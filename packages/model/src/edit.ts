import { z } from "zod";
import { clipSpeed } from "./evaluate";
import { AssetSchema, ClipSchema, IdSchema, trackName, type Asset, type Clip, type Project, type Track } from "./schema";
import type { FeatureRegistry } from "./registry";
import { ticksToSeconds, type Ticks } from "./ticks";
import type { Animation } from "./schema";

/**
 * Timeline editing maths shared by the timeline's commands and the editor's
 * drags, so what a drag shows is what its command does. Pure; ticks.
 */

/** A plain copy; also of Immer drafts, which `structuredClone` can't copy. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A copy of an effect under a new id (ids are unique across the document). */
export const freshEffect = <E extends { id: string }>(fx: E, newId: (prefix: string) => string): E => ({ ...clone(fx), id: newId("fx") });

export const clipEnd = (c: Clip): Ticks => c.start + c.duration;

/**
 * Moves a clip's in-point `delta` ticks later (or earlier, if negative),
 * keeping what it shows where it was. Held frames (`hold`) keep their frame.
 */
export function shiftIn(clip: Clip, delta: Ticks, hold: boolean) {
  clip.start += delta;
  clip.duration -= delta;
  if (!hold) clip.mediaStart = (clip.mediaStart ?? 0) + Math.round(delta * clipSpeed(clip));
}

/** Whether `[start, end)` on `track` is clear of every clip not in `ignore`. */
export function isFree(track: Track, start: Ticks, end: Ticks, ignore: ReadonlySet<string> = new Set()): boolean {
  return track.clips.every((c) => ignore.has(c.id) || clipEnd(c) <= start || c.start >= end);
}

export interface Placement {
  clip: string;
  /** Index into the track list, bottom to top; at or past its length means a new track on top. */
  track: number;
  start: Ticks;
}

export interface MovePlan {
  placements: Placement[];
  /** Why the move can't be dropped there, if it can't. */
  error?: string;
}

/**
 * Where clips land when moved `by` ticks and each its own number of tracks
 * up (`rows`: clip id → tracks, negative: down). Tracks above the top are
 * created on drop. A move onto locked tracks, before the
 * start or over other clips is refused, as dropping onto other media is;
 * magnetic tracks make room instead.
 */
export function planMove(tracks: Track[], rows: ReadonlyMap<string, number>, by: Ticks): MovePlan {
  const placements: Placement[] = [];
  for (const [i, track] of tracks.entries()) {
    for (const c of track.clips) if (rows.has(c.id)) placements.push({ clip: c.id, track: i + rows.get(c.id)!, start: c.start + by });
  }
  const ids = new Set(rows.keys());
  const clip = (id: string) => tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  for (const p of placements) {
    const from = tracks.find((t) => t.clips.some((c) => c.id === p.clip))!;
    if (from.locked) return { placements, error: `track "${trackName(from, tracks.indexOf(from))}" is locked` };
    if (p.start < 0) return { placements, error: "it would start before the timeline" };
    if (p.track < 0) return { placements, error: "there is no track below" };
    const to = tracks[p.track];
    if (!to) continue;
    if (to.locked) return { placements, error: `track "${trackName(to, p.track)}" is locked` };
    if (!to.magnetic && !isFree(to, p.start, p.start + clip(p.clip).duration, ids)) return { placements, error: `it would overlap media on "${trackName(to, p.track)}"` };
  }
  // Moved clips can also land on each other: a clip moved onto the track of a linked clip that only moves in time.
  for (const [i, p] of placements.entries()) {
    if (tracks[p.track]?.magnetic) continue;
    const end = p.start + clip(p.clip).duration;
    const hit = placements.slice(i + 1).find((q) => q.track === p.track && q.start < end && p.start < q.start + clip(q.clip).duration);
    if (hit) return { placements, error: "the moved clips would overlap each other" };
  }
  return { placements };
}

/**
 * The smallest shift that puts one of `edges` on one of `targets`, if any is
 * within `threshold` (all in the same unit).
 */
export function snapOffset(edges: number[], targets: number[], threshold: number): number | undefined {
  let best: number | undefined;
  for (const e of edges) {
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/** Where dragged edges snap: other clips' edges, the playhead, the range's ends and markers. */
export function snapTargets(project: Project, opts: { playhead?: Ticks; range?: [Ticks, Ticks]; exclude?: ReadonlySet<string> }): Ticks[] {
  const out = new Set<Ticks>([0]);
  for (const t of project.tracks) for (const c of t.clips) if (!opts.exclude?.has(c.id)) out.add(c.start).add(clipEnd(c));
  for (const m of project.markers) out.add(m.time);
  if (opts.playhead !== undefined) out.add(opts.playhead);
  if (opts.range) out.add(opts.range[0]).add(opts.range[1]);
  return [...out];
}

export const ClipboardSchema = z.strictObject({
  /** Clips with `start` relative to the copy's start; `row` counts tracks up from the lowest copied one. */
  items: z.array(z.strictObject({ clip: ClipSchema, row: z.int().nonnegative() })).min(1),
  assets: z.array(AssetSchema),
  /** The tracks the rows were copied from, lowest first, to paste back onto when they are free. */
  tracks: z.array(IdSchema),
  /** Those tracks' shared settings (`Track.props`), so the clips keep them wherever they are pasted. */
  trackProps: z.array(z.record(z.string(), z.unknown()).nullable()).optional(),
});
export type Clipboard = z.infer<typeof ClipboardSchema>;

/** Every asset a clip uses, its own and those of clips nested in it (groups, stitched media). */
function assetIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) assetIds(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "assetId" && typeof v === "string") out.add(v);
      else assetIds(v, out);
    }
  }
  return out;
}

/**
 * A copy of top-level clips, or with `range`, of what every track holds in
 * that time (clips cut to it). Locked and
 * disabled tracks are left out.
 */
/** A copy of `c` cut to `[a, b)` of its track's time; undefined when it's outside. A clip that holds a frame keeps it. */
export function cutToWindow(c: Clip, a: Ticks, b: Ticks, registry: Pick<FeatureRegistry, "hasTrait">): Clip | undefined {
  if (clipEnd(c) <= a || c.start >= b) return undefined;
  const copy = clone(c);
  if (copy.start < a) shiftIn(copy, a - copy.start, registry.hasTrait(c.type, "hold"));
  if (clipEnd(copy) > b) copy.duration = b - copy.start;
  return copy;
}

export function copyClips(project: Project, opts: { clips?: string[]; range?: [Ticks, Ticks] }, registry: Pick<FeatureRegistry, "hasTrait">): Clipboard | undefined {
  const picked: { clip: Clip; track: number }[] = [];
  for (const [i, track] of project.tracks.entries()) {
    if (track.locked || track.hidden) continue;
    for (const c of track.clips) {
      if (opts.clips) {
        if (opts.clips.includes(c.id)) picked.push({ clip: clone(c), track: i });
      } else if (opts.range) {
        const copy = cutToWindow(c, ...opts.range, registry);
        if (copy) picked.push({ clip: copy, track: i });
      }
    }
  }
  if (!picked.length) return undefined;
  const origin = Math.min(...picked.map((p) => p.clip.start));
  const low = Math.min(...picked.map((p) => p.track));
  const high = Math.max(...picked.map((p) => p.track));
  const assets = new Map<string, Asset>();
  for (const { clip } of picked) for (const id of assetIds(clip)) if (project.assets[id]) assets.set(id, project.assets[id]);
  return {
    items: picked.map(({ clip, track }) => ({ clip: { ...clip, start: clip.start - origin }, row: track - low })),
    assets: [...assets.values()],
    tracks: project.tracks.slice(low, high + 1).map((t) => t.id),
    trackProps: project.tracks.slice(low, high + 1).map((t) => (t.props ? clone(t.props) : null)),
  };
}

/**
 * Clips arriving on `to` from a track whose shared settings were `from` (a paste, a move, a group made or undone):
 * `to` takes the prop groups it has none of, so the clips look as they did; its own win where both have one.
 */
export function adoptTrackProps(to: Track, from: Record<string, unknown> | null | undefined) {
  for (const [group, value] of Object.entries(from ?? {})) {
    if (to.props?.[group] !== undefined) continue;
    to.props = { ...to.props, [group]: clone(value) };
  }
}

/**
 * The lowest track a copy can be pasted onto at `at` with every row free and
 * unlocked: the tracks it came from first, then upwards from the bottom.
 * Past the top, new tracks are made.
 */
export function pasteBase(tracks: Track[], board: Clipboard, at: Ticks): number {
  const fits = (base: number) =>
    board.items.every(({ clip, row }) => {
      const t = tracks[base + row];
      return !t || (!t.locked && isFree(t, at + clip.start, at + clipEnd(clip)));
    });
  const home = tracks.findIndex((t) => t.id === board.tracks[0]);
  if (home >= 0 && fits(home)) return home;
  for (let base = 0; base < tracks.length; base++) if (fits(base)) return base;
  return tracks.length;
}

/**
 * Where a property edit at `mediaTime` goes, the end value
 * of the last animation block on that property that has started by then,
 * or the clip's base value before any.
 */
export function blockAt(animations: Animation[], target: string, mediaTime: Ticks): Animation | undefined {
  return animations.filter((a) => target in a.to && a.end - a.duration < mediaTime).sort((a, b) => a.end - b.end).at(-1);
}

/**
 * The stored value an edit at `mediaTime` changes (see `blockAt`), which
 * differs from the value shown there while a block is in progress. Relative
 * edits (nudges, canvas drags) add to this, so the clip never jumps back.
 */
export function editedValue(clip: Clip, group: string, field: string, mediaTime: Ticks, fallback: unknown): unknown {
  const target = `${group}.${field}`;
  const block = blockAt(clip.animations, target, mediaTime);
  return block ? block.to[target] : ((clip.props[group] as Record<string, unknown> | undefined)?.[field] ?? fallback);
}

/**
 * How far a clip's edges can be trimmed out before they meet the clips
 * beside it on its track: the previous clip's end and the next one's start.
 * Unbounded on magnetic tracks, which make room.
 */
export function trimBounds(track: Track, clip: Clip): [Ticks, Ticks] {
  if (track.magnetic) return [-Infinity, Infinity];
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of track.clips) {
    if (c.id === clip.id) continue;
    if (clipEnd(c) <= clip.start) lo = Math.max(lo, clipEnd(c));
    else if (c.start >= clipEnd(clip)) hi = Math.min(hi, c.start);
  }
  return [lo, hi];
}

/** A point of a volume-style envelope: a value at a media time. */
export interface EnvelopePoint {
  time: Ticks;
  value: number;
}

/**
 * A property's animation blocks read as audio points: the base
 * value at the first block's start, then each block's end value (the points
 * import writes, each block a line from the point before).
 */
export function envelopePoints(base: number, animations: Animation[], target: string): EnvelopePoint[] {
  const blocks = animations.filter((a) => target in a.to).sort((a, b) => a.end - b.end);
  if (!blocks.length) return [];
  return [{ time: blocks[0]!.end - blocks[0]!.duration, value: base }, ...blocks.map((b) => ({ time: b.end, value: Number(b.to[target]) }))];
}

/** Points back to a base value and linear blocks, each from the point before (`newId` names them). */
export function envelopeBlocks(points: EnvelopePoint[], target: string, newId: (prefix: string) => string): { base?: number; blocks: Animation[] } {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (!sorted.length) return { blocks: [] };
  return {
    base: sorted[0]!.value,
    blocks: sorted.slice(1).map((p, i) => ({ id: newId("anim"), end: p.time, duration: p.time - sorted[i]!.time, easing: "linear" as const, to: { [target]: p.value } })),
  };
}

/** The tracks being edited: the timeline's, or an opened group's (its group tab). */
export interface EditScope {
  tracks: Track[];
  /** Main-timeline ticks at the scope's time 0: a group's inner clip at `t` shows at `t + offset`. */
  offset: Ticks;
  group?: Clip;
}

/** The audio the export plays, as the mixer does: audio clips not muted, on tracks not muted (a hidden track still plays). */
export function heardAudio(tracks: readonly Track[], isAudio: (clipType: string) => boolean): Clip[] {
  return tracks.filter((t) => !t.muted).flatMap((t) => t.clips.filter((c) => isAudio(c.type) && !(c.props.audio as { muted?: boolean } | undefined)?.muted));
}

/**
 * The project with only `ids` of its clips (exporting or bouncing a selection), those found, and their span in
 * main-timeline seconds (0 to 0 when none is). With `nested`, clips inside groups count too: a group stays for the
 * ones chosen in it, the rest of it gone.
 */
export function onlyClips(project: Project, ids: readonly string[], nested?: (c: Clip) => Track[] | undefined): { project: Project; found: Clip[]; from: number; to: number } {
  const keep = new Set(ids);
  const found: Clip[] = [];
  let [from, to] = [Infinity, -Infinity];
  const copy = structuredClone(project);
  // `at`: an inner time on the main timeline; `seen`: the part of it the groups around show.
  const prune = (tracks: Track[], at: (t: number) => number, seen: [number, number]) => {
    for (const t of tracks) {
      t.clips = t.clips.filter((c) => {
        const [a, b] = [Math.max(seen[0], at(c.start)), Math.min(seen[1], at(c.start + c.duration))];
        if (keep.has(c.id)) {
          found.push(c);
          if (a < b) [from, to] = [Math.min(from, a), Math.max(to, b)];
          return true;
        }
        const inner = nested?.(c);
        if (!inner) return false;
        const had = found.length;
        prune(inner, (x) => at(c.start + (x - (c.mediaStart ?? 0)) / clipSpeed(c)), [a, b]);
        return found.length > had;
      });
    }
  };
  prune(copy.tracks, (x) => x, [-Infinity, Infinity]);
  return { project: copy, found, from: to > from ? ticksToSeconds(from) : 0, to: to > from ? ticksToSeconds(to) : 0 };
}

/**
 * The scope for an opened group (a top-level clip whose nested tracks
 * `nested` returns), or the timeline. Groups with a speed change aren't
 * opened: their inner times don't map one to one.
 */
export function editScope(project: Project, group: string | null | undefined, nested: (c: Clip) => Track[] | undefined): EditScope {
  const clip = group ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === group) : undefined;
  const tracks = clip && !clip.speed ? nested(clip) : undefined;
  if (!clip || !tracks) return { tracks: project.tracks, offset: 0 };
  return { tracks, offset: clip.start - (clip.mediaStart ?? 0), group: clip };
}

/** The project as an opened group shows it: its tracks, with clips at main-timeline times. */
export function scopedProject(project: Project, scope: EditScope): Project {
  if (!scope.group) return project;
  return { ...project, tracks: scope.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, start: c.start + scope.offset })) })) };
}
