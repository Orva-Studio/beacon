import { jobProcesses, type JobProcesses } from "@beacon/media";
import { randomId } from "@beacon/model";
import type { Job, JobInfo } from "./api";

/** Finished jobs kept for `job()` and `jobs()`; older ones are let go. */
const KEEP_FINISHED_JOBS = 50;

export interface JobEntry {
  info: Omit<JobInfo, "elapsed">;
  /** The project it belongs to: closing the project cancels it. None for a download. */
  project?: string;
  /** Processes it has running (ffmpeg, whisper, beacon-worker), killed when it is cancelled. */
  processes: JobProcesses;
  /** What the job works on, for finding a running job again. */
  subject?: string;
  started: number;
  done: Promise<unknown>;
}

export interface JobOptions {
  /** The project's path: closing it cancels the job. */
  project?: string;
  subject?: string;
  asset?: string;
  /** Also told each change, besides `Jobs`' own listener: the project's watchers. */
  report?: (e: { kind: "job"; job: JobInfo }) => void;
}

/** Background work (exports, analyses, downloads): its progress, its processes to kill, and what it was for. */
export class Jobs {
  readonly #jobs = new Map<string, JobEntry>();

  /** `emit`: every job's changes, whichever project it is for (core's app-wide events). */
  constructor(readonly emit: (e: { kind: "job"; job: JobInfo }) => void) {}

  start(kind: string, label: string, fn: (progress: (f: number, stage?: string) => void) => Promise<unknown>, opts: JobOptions = {}): Job {
    const id = randomId("job", 8);
    const entry: JobEntry = {
      info: { id, kind, label, state: "running", progress: 0, ...(opts.asset ? { asset: opts.asset } : {}) },
      ...(opts.project ? { project: opts.project } : {}),
      processes: { procs: new Set(), cancelled: false, abort: new AbortController() },
      subject: opts.subject,
      started: performance.now(),
      done: Promise.resolve(),
    };
    const report = () => {
      const e = { kind: "job" as const, job: this.info(id) };
      opts.report?.(e);
      this.emit(e);
    };
    // Progress is reported each whole percent, so a window can show it without a flood of events.
    let shown = 0;
    this.#forgetFinished();
    // Listed before it starts: a job that reports progress before its first await is looked up by that report.
    this.#jobs.set(id, entry);
    entry.done = jobProcesses
      .run(entry.processes, () =>
        fn((f, stage) => {
          entry.info.progress = Math.min(1, Math.max(0, f));
          const staged = stage !== undefined && stage !== entry.info.stage;
          if (staged) entry.info.stage = stage;
          if (staged || Math.floor(entry.info.progress * 100) > shown) {
            shown = Math.floor(entry.info.progress * 100);
            report();
          }
        }),
      )
      .then(
        (result) => {
          Object.assign(entry.info, { state: "done", progress: 1, result });
          report();
          return result;
        },
        (err: unknown) => {
          Object.assign(entry.info, { state: "failed", error: entry.processes.cancelled ? "cancelled" : err instanceof Error ? err.message : String(err) });
          report();
          throw entry.processes.cancelled ? new Error(`${label}: cancelled`) : err;
        },
      );
    // Failures are read through info(); an unawaited rejection must not crash the process.
    entry.done.catch(() => {});
    report();
    return { id, done: entry.done };
  }

  info(id: string): JobInfo {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`no job "${id}"`);
    return { ...j.info, elapsed: Number(((performance.now() - j.started) / 1000).toFixed(1)) };
  }

  list(): JobInfo[] {
    return [...this.#jobs.keys()].map((id) => this.info(id));
  }

  /** The job still working on `subject`, to join rather than start another. */
  running(subject: string): JobEntry | undefined {
    for (const j of this.#jobs.values()) if (j.subject === subject && j.info.state === "running") return j;
  }

  /** Running jobs that `which` picks, of the project at `path` (every project's and none's, without it). */
  runningOf(path: string | undefined, which: (j: JobEntry) => boolean = () => true): JobEntry[] {
    return [...this.#jobs.values()].filter((j) => j.info.state === "running" && (path === undefined || j.project === path) && which(j));
  }

  cancel(id: string) {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`no job "${id}"`);
    Jobs.stop(j);
  }

  /** Cancels the running jobs `runningOf` would list. */
  cancelOf(path: string | undefined, which?: (j: JobEntry) => boolean) {
    for (const j of this.runningOf(path, which)) Jobs.stop(j);
  }

  /** Stops a running job: kills its processes, so it fails as "cancelled". */
  static stop(entry: JobEntry) {
    if (entry.info.state !== "running") return;
    entry.processes.cancelled = true;
    entry.processes.abort?.abort();
    for (const proc of entry.processes.procs) proc.kill();
  }

  #forgetFinished() {
    const finished = [...this.#jobs.entries()].filter(([, j]) => j.info.state !== "running");
    for (const [id] of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_JOBS))) this.#jobs.delete(id);
  }
}
