import { ticksToSeconds } from "@beacon/model";
import { droppedFiles } from "../drop";
import type { DroppedFile } from "../rpc";
import { replica } from "../store";
import { maxTop, RULER, TRACKS_TOP } from "../timeline-layout";
import { volumeAt, volumePoints } from "../timeline-draw";
import type { TimelineContext } from "./context";
import type { TimelineHits } from "./hit-test";

export interface ClickOptions {
  /** The right-click menu for a clip, shown natively by the main process. */
  menu: (clip: string) => void;
  /** A track's menu (Insert Track, Rename…, Lock…), or with null the track options under ⌄. */
  trackMenu: (track: string | null) => void;
  sectionMenu: (section: string) => void;
  /** Files dragged in from Finder, dropped at a time (and on a track). */
  dropFiles: (files: DroppedFile[], at: { time: number; track?: string }) => void;
}

/** The timeline's double-clicks, right-clicks, wheel and Finder drops. */
export function timelineClicks({ canvas, latest, size, HEADER, TRACK, TOP, tracks, clipTypes, run }: TimelineContext, hits: TimelineHits, { menu, trackMenu, sectionMenu, dropFiles }: ClickOptions) {
  const { timeAt, clipAt, rowUnder, headerIcon, arrowAt, volumeHit, sectionAt, pointer } = hits;

  const onDrop = (e: React.DragEvent<HTMLCanvasElement>) => {
    if (!e.dataTransfer.files.length || latest.current.session.group) return;
    e.preventDefault();
    e.stopPropagation();
    const r = canvas.current!.getBoundingClientRect();
    const row = rowUnder(e.clientY - r.top);
    const t = row === undefined ? undefined : tracks[row];
    const at = { time: timeAt(Math.max(e.clientX, r.left + HEADER)), ...(t && !t.locked ? { track: t.id } : {}) };
    void droppedFiles(e.dataTransfer).then((files) => dropFiles(files, at));
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = pointer(e);
    if (x > HEADER && y >= RULER && y < TRACKS_TOP) {
      const s = sectionAt(x)?.section;
      if (s) replica.nameSection({ id: s.id, start: ticksToSeconds(s.start), end: ticksToSeconds(s.end) });
      return;
    }
    const i = rowUnder(y);
    if (x < HEADER && i !== undefined && !headerIcon(x, y, i)) replica.rename(tracks[i]!.id);
    if (x < HEADER || i === undefined) return;
    // An animation stretched across its whole clip.
    const arrow = arrowAt(e.clientX, e.clientY);
    if (arrow) {
      const [a, b] = [ticksToSeconds(arrow.clip.start), ticksToSeconds(arrow.clip.start + arrow.clip.duration)];
      return run("animation.set", { clip: arrow.clip.id, animation: arrow.anim.id, end: b, duration: b - a }, "Stretch Animation Across Clip");
    }
    // On a selected audio clip's volume line: add a point there, or remove the one double-clicked.
    const clip = clipAt(e.clientX, e.clientY);
    if (clip && clipTypes[clip.type]?.includes("group") && !latest.current.session.group) return run("group.open", { clip: clip.id });
    const vol = clip && volumeHit(clip, e.clientX, e.clientY);
    if (!clip || !vol) return;
    const pts = volumePoints(clip);
    if (vol.index !== null) run("volume.setPoints", { clip: clip.id, points: pts.filter((_, j) => j !== vol.index) }, "Delete Audio Point");
    else {
      const t = timeAt(e.clientX);
      run("volume.setPoints", { clip: clip.id, points: [...pts, { time: t, value: volumeAt(clip, t) }].sort((p, q) => p.time - q.time) }, "Add Audio Point");
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = pointer(e);
    if (x < HEADER) {
      const i = rowUnder(y);
      if (i !== undefined) trackMenu(tracks[i]!.id);
      return;
    }
    if (y >= RULER && y < TRACKS_TOP) {
      const s = sectionAt(x)?.section;
      if (s) sectionMenu(s.id);
      return;
    }
    const clip = clipAt(e.clientX, e.clientY);
    if (!clip) return;
    if (!latest.current.session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
    menu(clip.id);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const { start, end } = latest.current.session.timeline;
    const span = end - start;
    if (e.metaKey || e.ctrlKey) {
      const at = timeAt(e.clientX);
      const f = Math.exp(e.deltaY * 0.01);
      run("timeline.view", { start: Math.max(0, at - (at - start) * f), end: at + (end - at) * f });
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && maxTop(tracks.length, TRACK, size.current.h) > 0) {
      // More tracks than fit: up and down move through them; sideways still moves through time.
      const most = maxTop(tracks.length, TRACK, size.current.h);
      run("timeline.scroll", { top: Math.min(most, Math.max(0, TOP + e.deltaY)) });
    } else {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (span / Math.max(1, size.current.w - HEADER));
      run("timeline.scroll", { start: Math.max(0, start + d) });
    }
  };

  return { onDrop, onDoubleClick, onContextMenu, onWheel };
}
