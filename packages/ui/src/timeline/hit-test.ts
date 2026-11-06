import { secondsToTicks, snapOffset, snapTargets, ticksToSeconds, type Clip, type Track } from "@beacon/model";
import { takes, type PanelItem } from "../drop";
import { arrowHalfHeight, clipBox, shownSpan, EDGE, headerIcons, rowAt, RULER, SECTION_EDGE, SNAP, volumeY } from "../timeline-layout";
import { arrows, volumeAt, volumePoints } from "../timeline-draw";
import type { TimelineContext } from "./context";

export type TimelineHits = ReturnType<typeof timelineHits>;

/** Where things are on the timeline canvas for this render: times and points, and what is under the pointer. */
export function timelineHits({ canvas, latest, size, snapLine, HEADER, TRACK, TOP, tracks, clipTypes }: TimelineContext) {
  /** The time under `clientX`; `before0` lets it go before the timeline's start (a frame held before a clip at 0, room made for it). */
  const timeAt = (clientX: number, before0 = false) => {
    const r = canvas.current!.getBoundingClientRect();
    const { start, end } = latest.current.session.timeline;
    const t = start + ((clientX - r.left - HEADER) / Math.max(1, r.width - HEADER)) * (end - start);
    return before0 ? t : Math.max(0, t);
  };

  /** Empty time just before `at` (seconds) on the tracks a Shift-drag moves: `track`, or every unlocked one. */
  const roomBefore = (at: number, track?: string) => {
    let last = 0;
    for (const t of latest.current.project.tracks) {
      if (track ? t.id !== track : t.locked) continue;
      for (const c of t.clips) if (ticksToSeconds(c.start) < at) last = Math.max(last, Math.min(at, ticksToSeconds(c.start + c.duration)));
    }
    return Math.max(0, at - last);
  };

  /**
   * Where the next clips start after `at` (on every unlocked track, or `track`), when nothing is going at `at` itself:
   * the gap a ⇧-drag left from there closes when there is no room before it. Undefined with no gap.
   */
  const gapEnd = (at: number, track?: string) => {
    // The playhead is kept to the millisecond, a clip's edge isn't: a few milliseconds either way are the same place.
    const near = 0.005;
    let next = Infinity;
    for (const t of latest.current.project.tracks) {
      if (track ? t.id !== track : t.locked) continue;
      for (const c of t.clips) {
        const [a, b] = [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)];
        if (a < at - near && b > at + near) return undefined;
        if (a >= at - near) next = Math.min(next, a);
      }
    }
    return Number.isFinite(next) && next - at > near ? next : undefined;
  };

  /** Seconds per screen point. */
  const spp = () => {
    const { start, end } = latest.current.session.timeline;
    return (end - start) / Math.max(1, size.current.w - HEADER);
  };

  const xOf = (t: number) => {
    const { start } = latest.current.session.timeline;
    return HEADER + (t - start) / spp();
  };

  /** Where `clip` on `t` is drawn, in seconds: at least `MIN_CLIP` wide where there is room. */
  const shown = (t: Track, clip: Clip) =>
    shownSpan(ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration), t.clips.filter((c) => c !== clip).map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)] as const), spp());

  const clipAt = (clientX: number, clientY: number): Clip | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const i = rowAt(clientY - r.top, TRACK, tracks.length, TOP);
    const t = i === undefined ? undefined : tracks[i];
    // A locked track's clips can't be picked, moved, trimmed or opened: the pointer sees empty time there.
    if (!t || t.locked) return undefined;
    const time = timeAt(clientX);
    return t.clips.find((c) => {
      const [a, b] = shown(t, c);
      return a <= time && time < b;
    });
  };

  /** The clip a panel item dropped at a point would go on: one that takes it, on an unlocked track. */
  const dropHit = (clientX: number, clientY: number, item: PanelItem) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || clientX < r.left + HEADER || clientX > r.right || clientY > r.bottom) return undefined;
    const row = rowUnder(clientY - r.top);
    const clip = row === undefined || tracks[row]!.locked ? undefined : clipAt(clientX, clientY);
    return clip && takes(item, clipTypes[clip.type]) ? { clip, row: row!, time: timeAt(clientX) } : undefined;
  };
  /** Where Media Bin media dropped at a point would go: its start at the pointer on that track (none: new tracks), refused over other media. */
  const mediaHit = (clientX: number, clientY: number, seconds: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || latest.current.session.group || clientX < r.left + HEADER || clientX > r.right || clientY < r.top + RULER || clientY > r.bottom) return undefined;
    const row = rowUnder(clientY - r.top);
    const time = timeAt(clientX);
    const t = row === undefined ? undefined : tracks[row]!;
    const [a, b] = [secondsToTicks(time), secondsToTicks(time + seconds)];
    const bad = !!t && (t.locked || (!t.magnetic && t.clips.some((c) => c.start < b && c.start + c.duration > a)));
    return { row, track: t?.id, time, bad };
  };

  /** The track row under a point (display order: top first), if any. */
  const rowUnder = (y: number) => rowAt(y, TRACK, tracks.length, TOP);

  /** The header icon under a point: mute, lock and eye, and on tall tracks the magnet (see the drawing). */
  const headerIcon = (x: number, y: number, i: number): "eye" | "magnet" | "lock" | "mute" | undefined => {
    const icons = headerIcons(i, TRACK, HEADER, TOP);
    const near = ([ix, iy]: [number, number]) => Math.abs(x - ix) <= 9 && Math.abs(y - iy) <= 8;
    if (near(icons.eye)) return "eye";
    if (near(icons.lock)) return "lock";
    if (near(icons.mute)) return "mute";
    if (icons.magnet && near(icons.magnet)) return "magnet";
    return undefined;
  };

  /** An animation arrow under the pointer (anywhere across its head's height), and which part: its start or end (to change its length) or its body (to move it). */
  const arrowAt = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowUnder(py);
    if (i === undefined || tracks[i]!.locked) return undefined;
    const box = clipBox(i, TRACK, TOP);
    const ay = box.y + box.h / 2;
    for (const clip of tracks[i]!.clips) {
      // Only the part of an arrow inside its clip is drawn, so only that part is grabbed.
      const [cx0, cx1] = [xOf(ticksToSeconds(clip.start)), xOf(ticksToSeconds(clip.start + clip.duration))];
      if (px < cx0 || px > cx1) continue;
      for (const { anim, a, b } of arrows(clip)) {
        const [xa, xb] = [xOf(a), xOf(b)];
        if (px < xa - 6 || px > xb + 6) continue;
        if (Math.abs(py - ay) > Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6) + 2)) continue;
        const grab = Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6));
        const part: "start" | "end" | "body" = Math.abs(px - xa) <= grab ? "start" : Math.abs(px - xb) <= grab ? "end" : "body";
        return { clip, anim, a, b, part };
      }
    }
    return undefined;
  };

  /** On a selected audio clip: the volume point under the pointer (its index), or the line itself. */
  const volumeHit = (clip: Clip, clientX: number, clientY: number): { index: number | null } | undefined => {
    const { session } = latest.current;
    if (!session.selection.includes(clip.id) || !clipTypes[clip.type]?.includes("audio")) return undefined;
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowUnder(py)!;
    const vy = (v: number) => volumeY(i, TRACK, v, TOP);
    // Points beyond the clip's edges aren't drawn, so they aren't grabbed either.
    const [cs, ce] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
    const pts = volumePoints(clip);
    const index = pts.findIndex((p) => p.time >= cs && p.time <= ce && Math.hypot(xOf(p.time) - px, vy(p.value) - py) <= 6);
    if (index >= 0) return { index };
    return Math.abs(vy(volumeAt(clip, timeAt(clientX))) - py) <= 4 ? { index: null } : undefined;
  };

  /** The edge of `clip` under the pointer, if it is wide enough to have grabbable edges. */
  const edgeAt = (clip: Clip, clientX: number): "start" | "end" | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const px = clientX - r.left;
    const a = xOf(ticksToSeconds(clip.start));
    const b = xOf(ticksToSeconds(clip.start + clip.duration));
    if (b - a < 3 * EDGE) return undefined;
    if (px - a <= EDGE) return "start";
    if (b - px <= EDGE) return "end";
    return undefined;
  };

  /** The section under `x` on the band, and which part: an edge within `SECTION_EDGE` points, else its body. */
  const sectionAt = (x: number) => {
    for (const s of latest.current.project.sections) {
      const [a, b] = [xOf(ticksToSeconds(s.start)), xOf(ticksToSeconds(s.end))];
      if (x < a - SECTION_EDGE || x > b + SECTION_EDGE) continue;
      const part: "start" | "end" | "body" = Math.abs(x - a) <= SECTION_EDGE && b - a > SECTION_EDGE * 2 ? "start" : Math.abs(x - b) <= SECTION_EDGE ? "end" : x < a ? "start" : "body";
      return { section: s, part };
    }
    return undefined;
  };

  /** Snaps `edges` (seconds) by the smallest shift onto a snap target, unless snapping is off or Control is held. */
  const snapped = (edges: number[], exclude: Set<string>, ctrl: boolean): number => {
    const { project, session } = latest.current;
    snapLine.current = undefined;
    if (!session.snapping || ctrl) return 0;
    const targets = snapTargets(project, {
      playhead: secondsToTicks(session.playhead),
      range: session.range ? [secondsToTicks(session.range.in), secondsToTicks(session.range.out)] : undefined,
      exclude,
    }).map(ticksToSeconds);
    const by = snapOffset(edges, targets, SNAP * spp());
    if (by !== undefined) snapLine.current = targets.find((t) => edges.some((e) => Math.abs(e + by - t) < 1e-9));
    return by ?? 0;
  };

  const pointer = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return { timeAt, roomBefore, gapEnd, spp, xOf, shown, clipAt, dropHit, mediaHit, rowUnder, headerIcon, arrowAt, volumeHit, edgeAt, sectionAt, snapped, pointer };
}
