import { mediaBounds, planMove, secondsToTicks, ticksToSeconds, trimBounds, trimRoom, type Clip, type Project } from "@beacon/model";
import type { Drag, MoveDrag } from "../timeline-draw";

export type DragOf<K extends Drag["kind"]> = Extract<Drag, { kind: K }>;

/** A move of `ids` by `by` seconds and `rows` tracks up, checked as the command will check it. */
export function plannedMove(project: Project, ids: string[], by: number, rows: number, ripple: boolean): MoveDrag {
  const moves = new Map(ids.map((id) => [id, ripple ? 0 : rows]));
  // As `clip.move` with `linked`: clips linked to a moved one follow it in time but keep their tracks.
  const links = new Set(project.tracks.flatMap((t) => t.clips).filter((c) => c.linkId && moves.has(c.id)).map((c) => c.linkId));
  for (const t of project.tracks) for (const c of t.clips) if (c.linkId && links.has(c.linkId) && !moves.has(c.id)) moves.set(c.id, 0);
  if (ripple) {
    for (const t of project.tracks) {
      const mine = t.clips.filter((c) => moves.has(c.id));
      if (!mine.length) continue;
      const from = Math.min(...mine.map((c) => c.start));
      for (const c of t.clips) if (c.start >= from) moves.set(c.id, 0);
    }
  }
  const plan = planMove(project.tracks, moves, secondsToTicks(by));
  return { kind: "move", ids, moves, by, rows: ripple ? 0 : rows, ripple, error: plan.error, x0: 0, y0: 0 };
}

/** The clips whose edge moves with `clip`'s: the others selected with it and the clips linked to any of them, on unlocked tracks. */
export function trimmedWith(project: Project, clip: Clip, selection: string[]): Clip[] {
  const picked = new Set([clip.id, ...selection]);
  const links = new Set(project.tracks.flatMap((t) => t.clips).filter((c) => picked.has(c.id) && c.linkId).map((c) => c.linkId));
  return project.tracks.flatMap((t) => (t.locked ? [] : t.clips.filter((c) => c.id !== clip.id && (picked.has(c.id) || (c.linkId && links.has(c.linkId))))));
}

/** How far a section from `a` to `b` (seconds) can reach: the ends of its neighbours, other than `skip`. */
export function sectionRoom(project: Project, a: number, b: number, skip?: string): [number, number] {
  let [lo, hi] = [0, Infinity];
  for (const s of project.sections) {
    if (s.id === skip) continue;
    const [sa, sb] = [ticksToSeconds(s.start), ticksToSeconds(s.end)];
    if (sb <= a + 1e-9) lo = Math.max(lo, sb);
    else if (sa >= b - 1e-9) hi = Math.min(hi, sa);
  }
  return [lo, hi];
}

/** The edges a drag of `part` of a span from `a` to `b` moves by `dt`: one end, or both for its body. */
export function partEdges(part: "start" | "end" | "body", a: number, b: number, dt: number): number[] {
  return part === "start" ? [a + dt] : part === "end" ? [b + dt] : [a + dt, b + dt];
}

/** Where a dragged section goes by `dt` (seconds, snapped): an edge kept a frame from the other and short of its neighbours, its body moved whole. */
export function sectionSpan(d: DragOf<"section">, dt: number, frame: number): [number, number] {
  let [a, b] = [d.a0, d.b0];
  if (d.part === "start") a = Math.min(d.b0 - frame, Math.max(d.lo, d.a0 + dt));
  else if (d.part === "end") b = Math.max(d.a0 + frame, Math.min(d.hi, d.b0 + dt));
  else {
    const by = Math.min(d.hi - d.b0, Math.max(d.lo - d.a0, dt));
    [a, b] = [d.a0 + by, d.b0 + by];
  }
  return [a, b];
}

/** `animation.set`'s times for an animation dragged by `dt` (seconds, snapped): its body moved, or an end moved a frame short of the other. */
export function animationTimes(d: DragOf<"anim">, dt: number, frame: number): { end: number; duration?: number } {
  const a = d.part === "end" ? d.a : Math.min(d.a + dt, d.part === "start" ? d.b - frame : Infinity);
  const b = d.part === "start" ? d.b : Math.max(d.b + dt, d.part === "end" ? d.a + frame : -Infinity);
  return d.part === "body" ? { end: Math.max(0, d.b + dt) } : { end: Math.max(0, b), duration: b - a };
}

/** The command a volume drag sends: by `dv` up, the whole line (or the clip's volume) or one point, that one also `dt` seconds along. */
export function volumeEdit(d: DragOf<"volume">, dv: number, dt: number, frame: number): { command: string; args: unknown; label: string } {
  // Up to 100% by dragging, but points already above it aren't pulled down.
  const v = (val: number, was = 0) => Math.min(Math.max(1, was), Math.max(0, val));
  if (d.index === null) {
    if (d.points.length) return { command: "volume.setPoints", args: { clip: d.clip, points: d.points.map((p) => ({ time: p.time, value: v(p.value + dv, p.value) })) }, label: "Volume" };
    return { command: "clip.set", args: { clip: d.clip, props: { audio: { volume: v(d.base + dv) } } }, label: "Volume" };
  }
  const p = d.points[d.index]!;
  const lo = d.points[d.index - 1]?.time ?? -Infinity;
  const hi = d.points[d.index + 1]?.time ?? Infinity;
  // A frame apart at least: points are snapped to frames, and two on one frame would merge.
  const t = Math.min(hi - frame, Math.max(lo + frame, p.time + dt));
  const points = d.points.map((q, j) => (j === d.index ? { time: t, value: v(p.value + dv, p.value) } : q));
  return { command: "volume.setPoints", args: { clip: d.clip, points }, label: "Move Audio Point" };
}

/** The clip a trim drags, its track, and whether it holds a frame and its start may go before 0. */
export function trimTarget(project: Project, clipTypes: Record<string, string[]>, d: DragOf<"trim">, alt: boolean, shift: boolean) {
  const all = project.tracks.flatMap((t) => t.clips);
  const clip = all.find((c) => c.id === d.clip)!;
  const a = ticksToSeconds(clip.start);
  const b = ticksToSeconds(clip.start + clip.duration);
  const track = project.tracks.find((tr) => tr.clips.includes(clip))!;
  // Stitched pieces hold a frame too: their piece at that edge.
  const video = clipTypes[clip.type]?.some((t) => t === "video" || t === "stitched") ?? false;
  // ⌥ on the start with room made (Shift, a magnetic track): the frame goes in at the clip's start, so it may be dragged past 0.
  const room = video && alt && d.edge === "start" && (shift || !!track.magnetic);
  return { all, clip, a, b, track, video, room };
}

/** Where a trim's edges go with the grabbed one dragged to `t` (seconds, snapped), stopped where the command stops them. */
export function trimTo(project: Project, clipTypes: Record<string, string[]>, d: DragOf<"trim">, target: ReturnType<typeof trimTarget>, t: number, alt: boolean, shift: boolean, frame: number) {
  const { all, clip, a, b, track, video } = target;
  // Edges stop at the clips beside them, as the command does; Shift (ripple) pushes them instead.
  if (!shift) {
    const [lo, hi] = trimBounds(track, clip);
    t = Math.min(Math.max(t, ticksToSeconds(lo)), ticksToSeconds(hi));
  }
  // Nor past where its media begins or ends, as the command stops them; ⌥ on video extends a frame there instead.
  if (!(video && alt)) {
    const [lo, hi] = mediaBounds(project, clip, clipTypes[clip.type]?.includes("hold") ?? false);
    t = Math.min(Math.max(t, ticksToSeconds(lo)), ticksToSeconds(hi));
  }
  t = d.edge === "start" ? Math.min(t, b - frame) : Math.max(t, a + frame);
  const extend = video && alt && (d.edge === "end" ? t > b : t < a);
  const ripple = shift || (extend && d.edge === "start" && !!track.magnetic);
  const edges = new Map([[clip.id, t]]);
  const others = all.filter((c) => c.id !== clip.id && d.edges.has(c.id));
  if (others.length && !extend) {
    // Every clip trimmed with it moves its edge as far, all stopping where the first can go no further, as the command does.
    const from = d.edge === "start" ? clip.start : clip.start + clip.duration;
    let by = secondsToTicks(t) - from;
    for (const c of [clip, ...others]) {
      const [lo, hi] = trimRoom(project, project.tracks.find((tr) => tr.clips.includes(c))!, c, d.edge, clipTypes[c.type]?.includes("hold") ?? false, ripple);
      by = Math.min(Math.max(by, lo), hi);
    }
    t = ticksToSeconds(from + by);
    edges.set(clip.id, t);
    for (const c of others) edges.set(c.id, ticksToSeconds((d.edge === "start" ? c.start : c.start + c.duration) + by));
  }
  return { t, ripple, extend, edges };
}
