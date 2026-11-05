import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import tealStudio from "./rooms/teal-studio.jpg" with { type: "file" };
import reflection from "./rooms/reflection.jpg" with { type: "file" };

/**
 * The room behind the monitor, 1536×1024: made with gpt-image-2.5-flare, the least busy of the four tried, the user's
 * pick (2026-11-04); straight on, as the shot is.
 */
export const ROOM_SIZE: [number, number] = [1536, 1024];

/**
 * The room behind the camera, as Glossy's glass mirrors it: gpt-image-2.6-sunburst (2026-11-05, the least busy of
 * four), a dim room with a window, a lamp and someone filming; mirrored, scaled to 512 wide and blurred once, offline.
 */
export const REFLECTION_SIZE: [number, number] = [512, 342];

const ready = new Map<string, string>();

/**
 * A bundled picture on disk for the renderer. Bundled, the import may be relative to the bundle or inside a compiled
 * binary's own file system, which the renderer can't open: then it is copied out once to the temp folder.
 */
function onDisk(src: string): string {
  const known = ready.get(src);
  if (known) return known;
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
  ready.set(src, path);
  return path;
}

export const roomPath = () => onDisk(tealStudio);
export const reflectionPath = () => onDisk(reflection);
