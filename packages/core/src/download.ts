import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ResourceDef } from "@beacon/model";
import { runTool } from "@beacon/media";

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Downloads a resource to `path` with macOS's curl (redirects followed, a partial file resumed; a cancelled job
 * kills it), then keeps it only if its hash is the one pinned.
 */
export async function download(def: ResourceDef, path: string, progress: (f: number) => void): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  const timer = setInterval(() => {
    if (existsSync(part)) progress(Math.min(0.99, statSync(part).size / def.bytes));
  }, 250);
  try {
    // A part already whole (the last run stopped before its check) would make the server refuse a resume.
    if (!existsSync(part) || statSync(part).size < def.bytes) await runTool(["/usr/bin/curl", "--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--output", part, def.url]);
  } finally {
    clearInterval(timer);
  }
  const got = await sha256(part);
  if (got !== def.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${def.title}: the download's SHA-256 is ${got}, not ${def.sha256}; nothing was kept`);
  }
  renameSync(part, path);
}
