import { constants, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readlink, stat, symlink, utimes } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";

const MEDIA_FOLDER = "media";

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
  await Promise.all([...copies].map(([from, to]) => copyFollowingLinks(from, to)));
  return copies;
}

/**
 * Copies a file or folder (for which `filter` says yes) with its times kept exactly, as a clone on APFS, and links
 * replaced by what they point at, nested ones too: a copy holding a link would still need the original. A broken
 * link stays a link. (`cp` keeps links unless dereferencing, and rounds times down to the millisecond, which changes
 * a fingerprint.)
 */
export async function copyFollowingLinks(from: string, to: string, filter: (src: string) => boolean = () => true): Promise<void> {
  if (!filter(from)) return;
  if (existsSync(to)) throw new Error(`${to} already exists`);
  let src = from;
  if (lstatSync(from).isSymbolicLink()) {
    try {
      src = realpathSync(from);
    } catch {
      await symlink(await readlink(from), to);
      return;
    }
  }
  const st = await stat(src);
  if (st.isDirectory()) {
    await mkdir(to);
    for (const f of await readdir(src)) await copyFollowingLinks(join(from, f), join(to, f), filter);
  } else {
    await copyFile(src, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  }
  await utimes(to, st.atimeMs / 1000, st.mtimeMs / 1000);
}
