import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * The processes a background job has started, found through async context:
 * cancelling the job (its project closed, the app quitting) kills them, so
 * no ffmpeg, whisper or beacon-worker outlives it.
 */
export interface JobProcesses {
  procs: Set<Subprocess>;
  cancelled: boolean;
}
export const jobProcesses = new AsyncLocalStorage<JobProcesses>();

/**
 * `Bun.spawn`, but a process started within a job is the job's to stop; once the job is cancelled
 * nothing more starts, so a fallback that catches the kill (a software re-encode, say) cannot outlive it.
 */
export const spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const owned = jobProcesses.getStore();
  if (owned?.cancelled) throw new Error("cancelled");
  const proc = Bun.spawn(...args);
  if (owned) {
    owned.procs.add(proc);
    void proc.exited.finally(() => owned.procs.delete(proc));
  }
  return proc;
}) as typeof Bun.spawn;

/**
 * Runs a command-line tool (ffmpeg, ffprobe, whisper-cli) and returns its
 * stdout; a non-zero exit throws with the end of its stderr.
 */
export async function runTool(args: string[], opts: { onStderr?: (chunk: string) => void } = {}): Promise<string> {
  const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  let err = "";
  for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
    err = (err + chunk).slice(-4000);
    opts.onStderr?.(chunk);
  }
  const [out, code] = await Promise.all([stdout, proc.exited]);
  if (code !== 0) throw new Error(`${args[0]} exited with ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`);
  return out;
}

/** Size and modification time (of every file, for a folder like a `.brec`): cheap, and what relinking and derived-data caches key on. */
export function fileFingerprint(path: string): string {
  const s = statSync(path);
  if (s.isDirectory()) {
    const files = readdirSync(path)
      .sort()
      .map((f) => {
        const fs = statSync(join(path, f));
        return `${f}:${fs.size}-${Math.round(fs.mtimeMs)}`;
      });
    return Bun.hash(files.join("\n")).toString(16);
  }
  return `${s.size}-${Math.round(s.mtimeMs)}`;
}
