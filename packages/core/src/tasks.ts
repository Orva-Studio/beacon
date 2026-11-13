import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileFingerprint } from "@beacon/media";
import {
  editScope,
  formatIssues,
  nestedOf,
  onlyClips,
  scopedProject,
  secondsToTicks,
  snapSeconds,
  type ActionContext,
  type ActionDef,
  type ActionPlan,
  type ActionStep,
  type ActionTask,
  type CommandResult,
} from "@beacon/model";
import { renderProject } from "@beacon/render";
import type { Job, RunOptions } from "./api";
import type { AppConfig } from "./config";
import { realPath } from "./media-copy";
import { pngImage, probeAsset, type CoreParts, type OpenProject } from "./project";

/** An action's document steps in one transaction, each given the results of those before it when it asks. */
function runSteps(tx: { run: (command: string, args: unknown) => unknown }, steps: ActionStep[]) {
  const results: unknown[] = [];
  for (const s of steps) results.push(tx.run(s.command, typeof s.args === "function" ? (s.args as (r: unknown[]) => unknown)(results) : (s.args ?? {})));
}

/** A task's file goes in the project's media folder or a temporary one, nowhere else; returned as given. */
function scratch(path: string, mediaDir: string): string {
  const real = realPath(resolve(path));
  const roots = [mediaDir, tmpdir()].map((r) => realPath(resolve(r)) + sep);
  if (!roots.some((r) => real.startsWith(r))) throw new Error(`a task can't write ${path}: only in the project's media folder or a temporary one`);
  return path;
}

/** Editor actions: their plans applied as one undo step, and the background tasks they start. */
export class Tasks {
  constructor(
    readonly parts: CoreParts,
    readonly config: AppConfig,
  ) {}

  /** An editor action: its editor steps, then its document steps as one undo step, then editor steps that follow from them; a task it starts runs as a job. */
  runAction(p: OpenProject, action: ActionDef, args: unknown, opts: RunOptions): CommandResult {
    const parsed = action.args.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`${action.id}: ${formatIssues(parsed.error)}`);
    const plan = action.resolve(parsed.data, this.#actionContext(p));
    const label = opts.label ?? plan.label;
    if (opts.dryRun) {
      const r = plan.steps?.length ? p.store.transaction(label, (tx) => runSteps(tx, plan.steps!), { dryRun: true }) : undefined;
      const lines = [...(plan.before ?? []), ...(plan.steps ?? [])].map((s) => `${s.command} ${typeof s.args === "function" ? "(from the steps before it)" : JSON.stringify(s.args ?? {})}`);
      if (plan.task) lines.push(`then in the background: ${plan.task.label}`);
      return { label, patches: r?.patches ?? [], inverse: r?.inverse ?? [], results: r?.results ?? [], diff: [...lines, ...(r?.diff ?? [])], dryRun: true };
    }
    const result = { ...this.#applyPlan(p, plan, label), ...(plan.note ? { note: plan.note } : {}) };
    if (!plan.task) return result;
    if (p.batch) {
      const task = plan.task;
      p.batch.later.push(() => `started job ${this.#startTask(p, task).id}: ${task.label} (job_status follows it)`);
      return { ...result, diff: [...result.diff, `then in the background, once the whole batch is kept: ${task.label}`] };
    }
    const job = this.#startTask(p, plan.task);
    return { ...result, results: [...result.results, { job: job.id }], diff: [...result.diff, `started job ${job.id}: ${plan.task.label} (job_status follows it)`] };
  }

  #actionContext(p: OpenProject): ActionContext {
    const { registry } = this.parts;
    const scope = editScope(p.store.doc, p.session.state.group, nestedOf(registry));
    return { project: p.store.doc, session: p.session.state, registry, scope: { tracks: scopedProject(p.store.doc, scope).tracks, group: scope.group }, data: p.data.get, pref: p.data.pref, memory: p.memory };
  }

  #applyPlan(p: OpenProject, plan: ActionPlan, label: string): CommandResult {
    const before = p.session.state;
    let result: CommandResult;
    try {
      for (const s of plan.before ?? []) p.session.run(s.command, s.args, p.store.doc);
      result = plan.steps?.length
        ? this.parts.saved(p, p.store.transaction(label, (tx) => runSteps(tx, plan.steps!)))
        : { label, patches: [], inverse: [], results: [], diff: [], dryRun: false };
    } catch (e) {
      // A Cut that couldn't delete must not have replaced the clipboard either.
      if (p.session.state !== before) p.session.restore(before);
      throw e;
    }
    // The document change is committed: what fails after it (keeping the decisions, an editor step) is reported, not thrown, or a retry would apply the change twice.
    const failed: string[] = [];
    if (plan.decisions?.length && p.batch) p.batch.decisions.push(...plan.decisions);
    else if (plan.decisions?.length) {
      const step = result.patches.length ? crypto.randomUUID().slice(0, 8) : undefined;
      try {
        p.memory.record(step ? plan.decisions.map((d) => ({ ...d, step })) : plan.decisions);
        if (step) p.decided.set(result.patches, { step });
      } catch (e) {
        failed.push(`(your choices weren't kept for Settings › Memory: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
    try {
      for (const s of plan.after?.(result.results) ?? []) p.session.run(s.command, s.args, p.store.doc);
    } catch (e) {
      failed.push(`(editor step after the change failed: ${e instanceof Error ? e.message : String(e)})`);
    }
    return failed.length ? { ...result, diff: [...result.diff, ...failed] } : result;
  }

  /** An action's background work; its edit is planned on the document as it is when the work is done. */
  #startTask(p: OpenProject, task: ActionTask): Job {
    const job = this.parts.startJob(p, "task", task.label, async (progress) => {
      const mediaDir = join(p.path, "media");
      mkdirSync(mediaDir, { recursive: true });
      const finish = await task.run({
        progress,
        secret: (id) => this.config.secrets.get(id),
        pref: p.data.pref,
        mediaDir,
        bounceAudio: (clips, range, path) => this.#bounceAudio(p, clips, range, scratch(path, mediaDir)),
        asset: async (path, kind) => ({ kind, path, fingerprint: fileFingerprint(path), derived: await probeAsset(path) }),
        frame: async (time, path, width = 0) => {
          scratch(path, mediaDir);
          const doc = p.store.doc;
          writeFileSync(path, pngImage(p.frames.frame(doc, snapSeconds(time, doc.settings.fps), p.data.get, width)).png);
        },
      });
      if (this.parts.find(p.path) !== p) throw new Error("the project was closed");
      const plan = finish(this.#actionContext(p));
      const r = this.#applyPlan(p, plan, plan.label);
      // The task it starts is this job's to finish: one waiting on this job waits for it, and hears if it fails.
      if (plan.task) await this.#startTask(p, plan.task).done;
      return { label: plan.label, results: r.results };
    });
    if (task.failed) {
      job.done.catch((e: unknown) => {
        if (this.parts.find(p.path) !== p) return;
        const message = e instanceof Error ? e.message : String(e);
        const error = message === `${task.label}: cancelled` ? "cancelled" : message;
        try {
          for (const s of task.failed!(error)) p.session.run(s.command, s.args, p.store.doc);
        } catch (err) {
          console.error(err);
        }
      });
    }
    return job;
  }

  /** These clips' audio alone, as the timeline plays it over the range, written in the path's format (.wav, .m4a, .mp3). */
  async #bounceAudio(p: OpenProject, clips: string[], range: { from: number; to: number }, path: string) {
    const { registry, cacheDir } = this.parts;
    mkdirSync(dirname(path), { recursive: true });
    await renderProject(onlyClips(p.store.doc, clips, nestedOf(registry)).project, registry, { output: { kind: "video", path }, from: secondsToTicks(range.from), to: secondsToTicks(range.to), cacheDir, data: p.data.get });
  }
}
