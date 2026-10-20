import { statSync } from "node:fs";
import { basename } from "node:path";
import { loadEngine, takeString } from "./engine";

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

/** The files of the last drag, as macOS keeps them (the drop just received, until another drag starts). */
export function draggedPaths(): string[] {
  const e = loadEngine();
  return JSON.parse(takeString(e, e.beacon_drag_files())) as string[];
}

/**
 * The path of a file dropped from Finder onto the window: its URL when WebKit gives one, else the file of
 * that name, size and modification time among the drag's own (`draggedPaths`). Undefined when it isn't there.
 */
export function findDroppedFile(f: DroppedFile, dragged: string[]): string | undefined {
  if (f.uri?.startsWith("file://")) {
    const path = decodeURIComponent(new URL(f.uri).pathname);
    if (same(path, f)) return path;
  }
  return dragged.find((p) => basename(p) === f.name && same(p, f));
}
