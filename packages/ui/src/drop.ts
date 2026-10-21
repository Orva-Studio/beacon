import type { PointerEvent as ReactPointerEvent } from "react";
import type { DroppedFile } from "./rpc";
import { replica } from "./store";

/** Something the tool panels drag onto media: effects, animations and audio effects. */
export interface PanelItem {
  label: string;
  /** The action it runs; a drop adds `clip` (and `time` when `timed`) to `args`. */
  command: string;
  args: Record<string, unknown>;
  /** Clips with any of these traits take it. */
  traits: string[];
  /** Where on the clip it lands matters (animations start at the drop). */
  timed?: boolean;
  /**
   * Media from the Media Bin: it drops on a track (or the canvas) rather than a clip; `time` and `track` are added
   * to `args`. `layers`: the clips it makes, bottom track first (a recording's screen, camera and audio), once known.
   */
  media?: { seconds: number; layers?: { label: string; seconds: number }[] };
}

/** Where a drop at a point lands: the clip (or for media, the track; none makes new tracks) and the timeline time (seconds) there. */
export type DropTarget = (clientX: number, clientY: number, item: PanelItem) => { clip?: string; track?: string; time: number } | undefined;

const targets = new Set<DropTarget>();

export function addDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => void targets.delete(t);
}

function dropAt(x: number, y: number, item: PanelItem) {
  for (const t of targets) {
    const hit = t(x, y, item);
    if (hit) return hit;
  }
  return undefined;
}

/** A clip of a type with these traits takes the item. */
export const takes = (item: PanelItem, traits: string[] | undefined) => item.traits.some((t) => traits?.includes(t));

/**
 * Starts dragging a panel item from a pointer press: a drop on a clip runs it on that clip. `click`: a press
 * without movement; `missed`: a drop that hits no media, at that point (the Favorites panel reorders by it).
 */
export function pressItem(e: ReactPointerEvent, item: PanelItem, run: (command: string, args: object) => void, on: { click?: () => void; missed?: (x: number, y: number) => void } = {}) {
  if (e.button !== 0) return;
  const [x0, y0] = [e.clientX, e.clientY];
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    moved = true;
    replica.drag({ item, x: ev.clientX, y: ev.clientY });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    replica.drag(undefined);
    if (!moved) return on.click?.();
    const hit = dropAt(ev.clientX, ev.clientY, item);
    if (!hit) on.missed?.(ev.clientX, ev.clientY);
    else if (item.media) run(item.command, { ...item.args, time: hit.time, ...(hit.track ? { track: hit.track } : {}) });
    else run(item.command, { ...item.args, clip: hit.clip, ...(item.timed ? { time: hit.time } : {}) });
  };
  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    replica.drag(undefined);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/**
 * Takes a drag of files from Finder as a copy. Left at "none", WebKit reports the drop as refused and Finder animates
 * the files back, though the drop still arrives.
 */
export function acceptFiles(e: { dataTransfer: DataTransfer | null; preventDefault(): void }): boolean {
  if (!e.dataTransfer?.types.includes("Files")) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  return true;
}

/** Images up to this size travel with their bytes, for when they have no path to be found by (`DroppedFile.data`). */
const CARRIED = 64 * 1024 * 1024;

const base64 = (f: Blob) =>
  new Promise<string | undefined>((done) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).slice(String(r.result).indexOf(",") + 1));
    // A screenshot's temporary file can be gone already: it is then found by path or not at all.
    r.onerror = () => done(undefined);
    r.readAsDataURL(f);
  });

/**
 * Files dragged in from Finder or pasted: what the webview knows of them, with their URLs when WebKit passes them and
 * an image's bytes. Their list is taken at once: the event's `DataTransfer` is emptied once it is handled.
 */
export function droppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const uris = dt.getData("text/uri-list").split(/\r?\n/).filter((u) => u.startsWith("file://"));
  return Promise.all(
    [...dt.files].map(async (f, i) => {
      const data = f.type.startsWith("image/") && f.size <= CARRIED ? await base64(f) : undefined;
      return { name: f.name, size: f.size, lastModified: f.lastModified, ...(uris[i] ? { uri: uris[i] } : {}), ...(data !== undefined ? { data } : {}) };
    }),
  );
}

/** What Beacon puts on the system clipboard when it copies clips, so a later ⌘V knows an image copied since is newer. */
export const BEACON_CLIPS = "application/x-beacon-clips";

/** A paste of an image copied in another app (not Beacon's own clips, copied after it). */
export const pastedImage = (dt: DataTransfer | null) => !!dt && !dt.types.includes(BEACON_CLIPS) && [...dt.files].some((f) => f.type.startsWith("image/"));
