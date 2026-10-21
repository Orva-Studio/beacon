import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { workerPath } from "./engine";
import { readLines, spawn, toolsDir } from "./tool";

/** A video stream's person matte: a grey movie, white where the person is, at the stream's own frame times. */
export interface Matte {
  path: string;
  width: number;
  height: number;
}

/**
 * Segments every frame of `path`'s `stream`th video stream with Apple's Vision into `out` (beacon-worker's matte
 * mode); `duration` (seconds) paces `onProgress`.
 */
export async function makeMatte(path: string, stream: number, out: string, duration: number, opts: { quiet?: boolean; onProgress?: (f: number) => void } = {}): Promise<Matte> {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp.mov`;
  const proc = spawn([...(opts.quiet ? ["/usr/sbin/taskpolicy", "-b"] : []), workerPath(), "matte", path, String(stream), tmp], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BEACON_TOOLS_DIR: toolsDir() },
  });
  let error: string | undefined;
  let size: [number, number] | undefined;
  const reader = readLines(proc.stdout, (line) => {
    const msg = JSON.parse(line) as { time?: number; done?: [number, number]; error?: string };
    if (msg.error) error = msg.error;
    if (msg.time !== undefined && duration > 0) opts.onProgress?.(Math.min(1, msg.time / duration));
    if (msg.done) size = msg.done;
  });
  const stderr = new Response(proc.stderr).text();
  try {
    const code = await proc.exited;
    await reader;
    if (code !== 0 || !size || !existsSync(tmp)) throw new Error(`couldn't find the person in ${path}: ${error ?? ((await stderr).trim() || `beacon-worker exited with ${code}`)}`);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { path: out, width: size[0], height: size[1] };
}
