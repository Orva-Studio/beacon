import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runTool } from "./tool";

/** What a webview knows about a file dropped on it: no path, unless WebKit passed its URL. */
export interface DroppedFile {
  name: string;
  size: number;
  /** Milliseconds since the epoch. */
  lastModified: number;
  uri?: string;
}

const same = (path: string, f: DroppedFile) => {
  try {
    const s = statSync(path);
    // A project is a folder Finder shows as a file; WebKit's size for it isn't the folder's.
    if (/\.(cmproj|beproj|brec)$/.test(f.name)) return s.isDirectory() && Math.abs(s.mtimeMs - f.lastModified) < 1000;
    return s.isFile() && s.size === f.size && Math.abs(s.mtimeMs - f.lastModified) < 1000;
  } catch {
    return false;
  }
};

/**
 * The path of a file dropped from Finder onto the window: its URL when WebKit
 * gives one, else the file of that name, size and modification time in the
 * usual folders or Spotlight's index. Undefined when it can't be found.
 */
export async function findDroppedFile(f: DroppedFile): Promise<string | undefined> {
  if (f.uri?.startsWith("file://")) {
    const path = decodeURIComponent(new URL(f.uri).pathname);
    if (same(path, f)) return path;
  }
  for (const dir of ["Desktop", "Downloads", "Movies", "Documents", "Music", "Pictures"]) {
    const path = join(homedir(), dir, f.name);
    if (same(path, f)) return path;
  }
  const found = await runTool(["/usr/bin/mdfind", "-name", f.name]).catch(() => "");
  return found.split("\n").find((p) => p.endsWith(`/${f.name}`) && same(p, f));
}
