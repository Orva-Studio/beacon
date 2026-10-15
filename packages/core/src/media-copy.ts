import { existsSync, mkdirSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";

export const MEDIA_FOLDER = "media";

export const isInside = (dir: string, path: string) => path.startsWith(dir + sep);

/** A name in `folder` not taken yet: "clip.mp4", then "clip 2.mp4", "clip 3.mp4"… */
function freeName(folder: string, file: string, taken: Set<string>): string {
  const ext = extname(file);
  const stem = basename(file, ext);
  for (let n = 1; ; n++) {
    const to = join(folder, n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`);
    if (!existsSync(to) && !taken.has(to)) return to;
  }
}

/**
 * Copies files (and recording folders, whole) into the project's `media` folder; returns each one's copy.
 * Times are kept so a copy's fingerprint matches its original's; on APFS the copy is a clone, so it is instant
 * and takes no space until one of them changes.
 */
export async function copyIntoProject(dir: string, files: string[]): Promise<Map<string, string>> {
  const folder = join(dir, MEDIA_FOLDER);
  mkdirSync(folder, { recursive: true });
  const copies = new Map<string, string>();
  const taken = new Set<string>();
  for (const file of new Set(files)) {
    const to = freeName(folder, file, taken);
    taken.add(to);
    copies.set(file, to);
  }
  await Promise.all([...copies].map(([from, to]) => cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })));
  return copies;
}
