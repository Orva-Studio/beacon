import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import tealStudio from "./rooms/teal-studio.jpg" with { type: "file" };

/**
 * The room behind the monitor, 1536×1024: made with gpt-image-2.5-flare, the least busy of the four tried, the user's
 * pick (2026-11-04); straight on, as the shot is.
 */
export const ROOM_SIZE: [number, number] = [1536, 1024];

let ready: string | undefined;

/**
 * A room's photo on disk for the renderer. Bundled, the import may be relative to the bundle or inside a compiled
 * binary's own file system, which the renderer can't open: then it is copied out once to the temp folder.
 */
export function roomPath(): string {
  if (ready) return ready;
  const src = tealStudio;
  const abs = isAbsolute(src) ? src : resolve(import.meta.dir, src);
  let path = abs;
  if (abs.startsWith("/$bunfs") || !existsSync(abs)) {
    const dir = join(tmpdir(), "beacon-rooms");
    mkdirSync(dir, { recursive: true });
    path = join(dir, basename(abs));
    if (!existsSync(path)) {
      try {
        writeFileSync(path, readFileSync(src));
      } catch {
        copyFileSync(abs, path);
      }
    }
  }
  ready = path;
  return path;
}
