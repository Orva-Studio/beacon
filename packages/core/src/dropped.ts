import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { draggedPaths, findDroppedFile, type DroppedFile } from "@beacon/media";
import type { ImportResult, BeaconCore, ProjectHandle } from "./api";

/** A name for a file that came with only its bytes: its own, unless it is WebKit's stand-in for a pasted image ("image.png"). */
function savedName(f: DroppedFile, now: Date): string {
  if (!/^image\.\w+$/i.test(f.name)) return f.name.replace(/[/:]/g, "-");
  const two = (n: number) => String(n).padStart(2, "0");
  return `Pasted ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} at ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}${extname(f.name)}`;
}

function save(f: DroppedFile, bytes: Buffer, folder: string): string {
  mkdirSync(folder, { recursive: true });
  const name = savedName(f, new Date());
  const [stem, ext] = [name.slice(0, name.length - extname(name).length), extname(name)];
  let path = join(folder, name);
  for (let n = 2; existsSync(path); n++) path = join(folder, `${stem} ${n}${ext}`);
  writeFileSync(path, bytes);
  return path;
}

/** A file macOS hands over for one drag only (a screenshot thumbnail's, under `TemporaryItems`), gone once it ends. */
const temporary = (path: string) => path.includes("/TemporaryItems/");

/**
 * The paths of files dragged in from Finder or pasted; throws naming those it can't find. One with no path but its
 * bytes, or whose path is the drag's temporary file, is written into `folder` (the project's media folder) first.
 */
export async function findDropped(files: DroppedFile[], opts: { dragged?: string[]; folder?: string } = {}): Promise<string[]> {
  // Each of the drag's paths answers one dropped file: two files alike in name, size and date are two paths.
  const left = [...(opts.dragged ?? draggedPaths())];
  const paths = files.map((f) => {
    const path = findDroppedFile(f, left);
    if (path) {
      left.splice(left.indexOf(path), 1);
      return opts.folder && temporary(path) ? save(f, readFileSync(path), opts.folder) : path;
    }
    if (f.data !== undefined && opts.folder) return save(f, Buffer.from(f.data, "base64"), opts.folder);
    return path;
  });
  const lost = files.filter((_, i) => !paths[i]).map((f) => f.name);
  if (lost.length) throw new Error(`couldn't find ${lost.join(", ")} among the dragged files; use File > Import Media… instead`);
  return paths as string[];
}

/**
 * Imports files dragged in from Finder or pasted, once their paths are found (those with only their bytes saved into
 * `folder`); at `time` on `track` when dropped on the timeline.
 */
export async function importDropped(core: BeaconCore, h: ProjectHandle, files: DroppedFile[], at: { time?: number; track?: string } = {}, folder?: string): Promise<ImportResult> {
  return core.import(h, await findDropped(files, { ...(folder ? { folder } : {}) }), { ...(at.time !== undefined ? { at: at.time } : {}), ...(at.track ? { track: at.track } : {}) });
}
