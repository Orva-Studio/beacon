import { findDroppedFile, type DroppedFile } from "@beacon/media";
import type { ImportResult, BeaconCore, ProjectHandle } from "./api";

/** The paths of files dragged in from Finder; throws naming those it can't find. */
export async function findDropped(files: DroppedFile[]): Promise<string[]> {
  const paths = await Promise.all(files.map(findDroppedFile));
  const lost = files.filter((_, i) => !paths[i]).map((f) => f.name);
  if (lost.length) throw new Error(`couldn't find ${lost.join(", ")} on disk (not in Spotlight's index); use File > Import Media… instead`);
  return paths as string[];
}

/** Imports files dragged in from Finder, once their paths are found; at `time` on `track` when dropped on the timeline. */
export async function importDropped(core: BeaconCore, h: ProjectHandle, files: DroppedFile[], at: { time?: number; track?: string } = {}): Promise<ImportResult> {
  return core.import(h, await findDropped(files), { ...(at.time !== undefined ? { at: at.time } : {}), ...(at.track ? { track: at.track } : {}) });
}
