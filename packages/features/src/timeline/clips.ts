import { z } from "zod";
import {
  adoptTrackProps,
  AssetSchema,
  ClipboardSchema,
  clipEnd,
  clipSpeed,
  defineCommand,
  mergeSpans,
  subtractSpans,
  isDraft,
  original,
  isFree,
  mediaTimeAt,
  resolveProps,
  pasteBase,
  planMove,
  trimBounds,
  trimRoom,
  mediaBounds,
  shiftIn as moveInPoint,
  snapSeconds,
  ticksPerFrame,
  remapAssetIds,
  walkClips,
  type Clip,
  type ClipLocation,
  type CommandContext,
  type FeatureRegistry,
  type Project,
  type Ticks,
  type Track,
  clone,
  freshEffect,
  oneOfEach,
  secondsToTicks,
  ticksToSeconds,
  findClip,
  locate,
  onTrack,
  withLinked,
  IdSchema as Id,
  SecondsSchema as Seconds,
} from "@beacon/model";
import { cutSections, openSections } from "./sections";

const Linked = z.boolean().default(true).describe("Include the clips linked to them (a recording's screen, camera and audio)");


/** A speed as a fraction in thousandths, reduced (1.5 → 3/2). */
function rational(x: number): { num: number; den: number } {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const num = Math.round(x * 1000);
  const g = gcd(num, 1000);
  return { num: num / g, den: 1000 / g };
}

function unlocked(track: Track) {
  if (track.locked) throw new Error(`track "${track.name}" is locked`);
}


const holds = (registry: FeatureRegistry, clip: Clip) => registry.hasTrait(clip.type, "hold");

/** Moves a clip's in-point, keeping what it shows where it was (see `shiftIn`). */
function shiftIn(clip: Clip, delta: Ticks, registry: FeatureRegistry) {
  moveInPoint(clip, delta, holds(registry, clip));
  if (clip.assetId && (clip.mediaStart ?? 0) < 0) throw new Error(`clip "${clip.id}" would start before its media`);
}

/** A deep copy under a new id; clips nested in it (a group's, a stitched clip's pieces) get new ids too, as ids are unique across the document. */
function copyClip(clip: Clip, ctx: CommandContext): Clip {
  const copy: Clip = { ...(clone(clip) as Clip), id: ctx.newId("clip") };
  for (const inner of walkClips([{ id: "", name: "", clips: [copy] }], ctx.registry)) if (inner.clip !== copy) inner.clip.id = ctx.newId("clip");
  return copy;
}

/** The copies' link for an original's `linkId`: one new link per original link, so copies link to each other. */
function copiedLink(links: Map<string, string>, linkId: string, ctx: CommandContext): string {
  if (!links.has(linkId)) links.set(linkId, ctx.newId("link"));
  return links.get(linkId)!;
}

/** Splits `clip` at timeline time `at` (strictly inside it); returns the right-hand piece, already in the track. */
function splitAt(track: Track, clip: Clip, at: Ticks, ctx: CommandContext, links: Map<string, string>): Clip {
  const right = copyClip(clip, ctx);
  shiftIn(right, at - clip.start, ctx.registry);
  clip.duration = at - clip.start;
  if (clip.linkId) right.linkId = copiedLink(links, clip.linkId, ctx);
  track.clips.splice(track.clips.indexOf(clip) + 1, 0, right);
  return right;
}

/** A piece of a clip a cut would leave shorter than this goes with the cut: a sliver is never wanted (the user, 2026-11-03). */
export const MIN_PIECE = 0.5;

/**
 * Merged, frame-snapped, latest first, so earlier ranges are unaffected by later deletions. No piece of a cut clip
 * (footage: media, stitched or grouped) on a track the cut reaches is left shorter than `MIN_PIECE`: one holding a word kept (features' `keepWhole`) takes
 * time back from the cuts beside it until it is that long (or they are used up); any other goes with the cut. A clip
 * no range touches stays however short it is.
 */
function normalizeRanges(doc: Project, ranges: { start: number; end: number }[], registry: FeatureRegistry, data: CommandContext["data"], exact = false): [Ticks, Ticks][] {
  const snapped = ranges.map((r) => [snapSeconds(r.start, doc.settings.fps), snapSeconds(r.end, doc.settings.fps)] as [Ticks, Ticks]).filter(([a, b]) => b > a);
  let spans = mergeSpans(snapped) as [Ticks, Ticks][];
  // A range the user drew by hand is cut as drawn; slivers are a worry for cuts worked out for them.
  if (exact) return spans.reverse();
  const min = secondsToTicks(MIN_PIECE);
  const asked = spans;
  const words = [...registry.features.values()].flatMap((f) => f.keepWhole?.(doc, registry, data) ?? []).filter(([a, b]) => !asked.some(([x, y]) => (a + b) / 2 >= x && (a + b) / 2 < y));
  const holdsWord = (a: Ticks, b: Ticks) => words.some(([w0, w1]) => w1 > a && w0 < b);
  // Footage only: a caption, callout or region is often shorter than `MIN_PIECE` by design, and counting one stopped
  // a short in/out range from deleting anything (the time given back to the word in a caption ate the whole range).
  const footage = (c: Clip) => ["media", "stitched", "group"].some((t) => registry.hasTrait(c.type, t));
  const clips = doc.tracks.filter((t) => !t.locked && !t.hidden).flatMap((t) => t.clips).filter(footage);
  // A change on one track can leave a short piece on another: until none is left.
  for (let i = 0; i < 8; i++) {
    let changed = false;
    for (const c of clips) {
      const pieces = subtractSpans([c.start, clipEnd(c)], spans) as [Ticks, Ticks][];
      if (pieces.reduce((sum, [a, b]) => sum + b - a, 0) === c.duration) continue;
      for (const [a, b] of pieces.filter(([a, b]) => b - a < min)) {
        if (!holdsWord(a, b)) {
          spans = mergeSpans([...spans, [a, b]]) as [Ticks, Ticks][];
          changed = true;
          continue;
        }
        const left = spans.find(([, y]) => y === a);
        const right = spans.find(([x]) => x === b);
        const room = { left: left ? Math.min(a - left[0], a - c.start) : 0, right: right ? Math.min(right[1] - b, clipEnd(c) - b) : 0 };
        const need = min - (b - a);
        const fromLeft = Math.min(room.left, Math.max(Math.ceil(need / 2), need - room.right));
        const fromRight = Math.min(room.right, need - fromLeft);
        if (!fromLeft && !fromRight) continue;
        spans = spans
          .map(([x, y]): [Ticks, Ticks] => (left && x === left[0] ? [x, y - fromLeft] : right && x === right[0] ? [x + fromRight, y] : [x, y]))
          .filter(([x, y]) => y > x);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return spans.reverse();
}

/**
 * `base` and every other track holding a clip linked to one of theirs that is still going at `a`: what moves time
 * from `a` on `base` moves those too, as linked clips move together. A locked one refuses it.
 */
function withLinkedTracks(tracks: Track[], base: Track[], a: Ticks): Track[] {
  const out = new Set(base);
  for (let grew = true; grew; ) {
    grew = false;
    const linked = new Set([...out].flatMap((t) => t.clips.filter((c) => c.linkId && clipEnd(c) > a).map((c) => c.linkId!)));
    for (const t of tracks) {
      if (out.has(t) || !t.clips.some((c) => c.linkId && linked.has(c.linkId))) continue;
      if (t.locked) throw new Error(`track "${t.name}" is locked, and holds clips linked to ones this would move`);
      out.add(t);
      grew = true;
    }
  }
  return tracks.filter((t) => out.has(t));
}

/** Removes `[a, b)` from each unlocked, enabled track; with `ripple`, later media moves left to close the gap. */
function removeRange(doc: Project, tracks: Track[], a: Ticks, b: Ticks, ctx: CommandContext, ripple: boolean) {
  const gap = b - a;
  const links = new Map<string, string>();
  const enabled = tracks.filter((t) => !t.locked && !t.hidden);
  for (const track of ripple ? withLinkedTracks(tracks, enabled, a) : enabled) {
    for (const clip of [...track.clips]) {
      const end = clipEnd(clip);
      if (end <= a) continue;
      if (clip.start >= b) {
        if (ripple) clip.start -= gap;
      } else if (clip.start >= a && end <= b) track.clips.splice(track.clips.indexOf(clip), 1);
      else if (clip.start < a && end > b) {
        const right = splitAt(track, clip, a, ctx, links);
        shiftIn(right, gap, ctx.registry);
        if (ripple) right.start = a;
      } else if (clip.start < a) clip.duration = a - clip.start;
      else {
        shiftIn(clip, b - clip.start, ctx.registry);
        if (ripple) clip.start = a;
      }
    }
  }
  if (ripple && tracks === doc.tracks) {
    for (let i = doc.markers.length - 1; i >= 0; i--) if (doc.markers[i]!.time >= a && doc.markers[i]!.time < b) doc.markers.splice(i, 1);
    for (const m of doc.markers) if (m.time >= b) m.time -= gap;
    cutSections(doc, a, b);
  }
}

/** What deleting `ranges` (seconds) removes once a cut takes no sliver: for a review's estimate to match its cut. */
export function rangesCut(doc: Project, ranges: { start: number; end: number }[], registry: FeatureRegistry, data: CommandContext["data"]) {
  return normalizeRanges(doc, ranges, registry, data)
    .reverse()
    .map(([a, b]) => ({ start: ticksToSeconds(a), end: ticksToSeconds(b) }));
}

/** Deletes timeline ranges (seconds, read against the timeline before any of them) from every unlocked, enabled track and closes the gaps. */
export function rippleDeleteRanges(doc: Project, ranges: { start: number; end: number }[], ctx: CommandContext, exact = false) {
  for (const [a, b] of normalizeRanges(doc, ranges, ctx.registry, ctx.data, exact)) removeRange(doc, doc.tracks, a, b, ctx, true);
}

/**
 * Only the editor's own Delete and Ripple Delete of an in/out range: an agent's or a review's cut leaves no sliver of
 * footage (the user, 2026-11-06).
 */
const Exact = z.boolean().optional().describe("Cut exactly the ranges given, keeping pieces under half a second: the editor's Delete of an in/out range. Agents leave it out");

/**
 * Closes the time `removed` left on `affected` tracks, and on every track holding a later clip linked to one on
 * them, so a link group moves as one. Each clip would move left by the removed time its track has free before it;
 * a link group then moves by the least any of its clips can, and a clip held back holds back those after it on its
 * track, until nothing changes. A locked track's clips stay.
 */
function rippleOut(tracks: Track[], affected: Set<Track>, removed: [Ticks, Ticks][]) {
  const from = removed[0]?.[0];
  if (from === undefined) return;
  const rippling = new Set(affected);
  for (let grew = true; grew; ) {
    grew = false;
    const links = new Set([...rippling].flatMap((t) => t.clips.filter((c) => c.linkId && clipEnd(c) > from).map((c) => c.linkId!)));
    for (const t of tracks) if (!rippling.has(t) && t.clips.some((c) => c.linkId && links.has(c.linkId))) (rippling.add(t), (grew = true));
  }
  const shift = new Map<Clip, Ticks>();
  for (const track of rippling) {
    // Time a clip left behind still covers isn't removed from its track, so nothing overlaps.
    const gaps = removed.flatMap((span) => subtractSpans(span, track.clips.map((c) => [c.start, clipEnd(c)])));
    for (const c of track.clips) shift.set(c, track.locked ? 0 : gaps.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, c.start) - a), 0));
  }
  const groups = new Map<string, Clip[]>();
  for (const c of shift.keys()) if (c.linkId) groups.set(c.linkId, [...(groups.get(c.linkId) ?? []), c]);
  const ordered = [...rippling].map((t) => [...t.clips].sort((x, y) => x.start - y.start));
  for (let changed = true; changed; ) {
    changed = false;
    const lower = (c: Clip, to: Ticks) => to < shift.get(c)! && (shift.set(c, to), (changed = true));
    for (const g of groups.values()) {
      const least = Math.min(...g.map((c) => shift.get(c)!));
      for (const c of g) lower(c, least);
    }
    for (const cs of ordered) for (let i = 1; i < cs.length; i++) lower(cs[i]!, shift.get(cs[i - 1]!)! + cs[i]!.start - clipEnd(cs[i - 1]!));
  }
  for (const [c, d] of shift) c.start -= d;
}

/** The main timeline's tracks a space edit moves: one, or every unlocked one. */
function spaceTracks(doc: Project, track?: string): Track[] {
  if (!track) return doc.tracks.filter((t) => !t.locked);
  const one = doc.tracks.find((t) => t.id === track);
  if (!one) throw new Error(`no track "${track}" on the main timeline`);
  unlocked(one);
  return [one];
}

/** Moves every clip on `track` starting at or after `from` (other than `except`) by `by`. */
function shiftLater(track: Track, from: Ticks, by: Ticks, except?: Clip) {
  for (const c of track.clips) if (c !== except && c.start >= from) c.start += by;
}

/** The free time on `track` from `at` to its next clip (none: unbounded). */
function gapAfter(track: Track, at: Ticks, except: Clip): Ticks {
  return Math.min(Infinity, ...track.clips.filter((c) => c !== except && c.start >= at).map((c) => c.start - at));
}

/**
 * How far a ripple trim lengthening clips' ends by `by` pushes what comes after: a gap after them is filled first
 * (the user's, 2026-11-02), the same on every track so linked clips stay in step.
 */
const ripplePush = (by: Ticks, ends: { track: Track; at: Ticks; clip: Clip }[]) => (by <= 0 ? by : Math.max(0, by - Math.min(...ends.map((e) => gapAfter(e.track, e.at, e.clip)))));

/** The earliest time on the clip's own track that shows: 0 on the timeline, the start of its group's window inside one. */
function groupFloor(doc: Project, registry: FeatureRegistry, loc: ClipLocation): Ticks {
  if (loc.tracks === doc.tracks) return 0;
  for (const { clip } of walkClips(doc.tracks, registry))
    for (const g of registry.groupsFor(clip.type)) if (g.nested && clip.props[g.id] && g.nested(clip.props[g.id]) === loc.tracks) return clip.mediaStart ?? 0;
  return 0;
}

const one = (a: { clip?: string; clips?: string[] }) => (a.clip === undefined) !== (a.clips === undefined);
const ONE = { message: "give `clip` or `clips`, not both" };

const Ranges = z.array(z.strictObject({ start: Seconds, end: Seconds })).min(1);

export const clipCommands = [
  defineCommand({
    id: "clip.remove",
    description:
      "Remove clips (and the clips linked to them). With `ripple`, later clips on the tracks they were on move left by the time removed where their track has it free, and so do later clips on other tracks linked to them: linked clips always move together, so they stay in sync (a clip that can't move holds back those after it)",
    args: z.strictObject({ clip: Id.optional(), clips: z.array(Id).min(1).optional(), linked: Linked, ripple: z.boolean().default(false) }).refine(one, ONE),
    apply(doc, { clip, clips, linked, ripple }, ctx) {
      const locs = locate(doc, ctx.registry, clips ?? [clip!], linked);
      for (const l of locs) unlocked(l.track);
      // The removed time: the union of the clips' spans, across tracks.
      const union = mergeSpans(locs.map((l) => [l.clip.start, clipEnd(l.clip)]));
      const affected = new Set(locs.map((l) => l.track));
      for (const { clip: c, track } of locs) track.clips.splice(track.clips.indexOf(c), 1);
      if (!ripple) return;
      for (const list of new Set(locs.map((l) => l.tracks))) rippleOut(list, new Set(list.filter((t) => affected.has(t))), union);
    },
  }),
  defineCommand({
    id: "clip.move",
    description:
      "Move clips in time (`start` for the first clip, or `by` seconds) and/or to other tracks (`track` for the first clip, or `tracks` up, negative down; past the top or below the lowest, tracks are added there). The named clips move as a block; linked clips move by the same time but stay on their tracks. Refused if they would land on locked tracks or over other media, except on magnetic tracks, which make room. `ripple` (Shift-drag) also moves every later clip on their tracks",
    args: z
      .strictObject({
        clip: Id.optional(),
        clips: z.array(Id).min(1).optional(),
        start: Seconds.optional(),
        by: z.number().optional(),
        track: Id.optional(),
        tracks: z.int().optional(),
        linked: Linked,
        ripple: z.boolean().default(false),
      })
      .refine(one, ONE)
      .refine((a) => a.start === undefined || a.by === undefined, { message: "give `start` or `by`, not both" })
      .refine((a) => a.track === undefined || a.tracks === undefined, { message: "give `track` or `tracks`, not both" }),
    apply(doc, args, ctx) {
      const named = args.clips ?? [args.clip!];
      const anchor = findClip(doc, ctx.registry, named[0]!);
      const list = anchor.tracks;
      const locs = locate(doc, ctx.registry, named, args.linked);
      if (locs.some((l) => l.tracks !== list)) throw new Error("clips inside a group move only with other clips of that group");
      const fps = doc.settings.fps;
      const by =
        args.by !== undefined ? Math.sign(args.by) * snapSeconds(Math.abs(args.by), fps) : args.start !== undefined ? onTrack(doc, anchor, args.start) - anchor.clip.start : 0;
      let rows = args.tracks ?? 0;
      if (args.track !== undefined) {
        const to = list.findIndex((t) => t.id === args.track);
        if (to < 0) throw new Error(`no track "${args.track}" beside clip "${anchor.clip.id}"`);
        rows = to - list.indexOf(anchor.track);
      }
      const moves = new Map(locs.map((l) => [l.clip.id, named.includes(l.clip.id) ? rows : 0]));
      if (args.ripple) {
        if (rows) throw new Error("a ripple move stays on its tracks");
        for (const track of new Set(locs.map((l) => l.track))) {
          const from = Math.min(...locs.filter((l) => l.track === track).map((l) => l.clip.start));
          for (const c of track.clips) if (c.start >= from) moves.set(c.id, 0);
        }
      }
      const plan = planMove(list, moves, by);
      if (plan.error) throw new Error(`can't move there: ${plan.error}`);
      const byId = new Map(list.flatMap((t) => t.clips).map((c) => [c.id, c]));
      const came = new Map<string, Track>();
      for (const p of plan.placements) {
        const c = byId.get(p.clip)!;
        const from = list.find((t) => t.clips.includes(c))!;
        came.set(c.id, from);
        from.clips.splice(from.clips.indexOf(c), 1);
      }
      for (let i = 0; i < plan.below; i++) list.unshift({ id: ctx.newId("track"), name: "", clips: [] });
      for (const p of plan.placements) {
        while (list.length <= p.track) list.push({ id: ctx.newId("track"), name: "", clips: [] });
        const c = byId.get(p.clip)!;
        c.start = p.start;
        list[p.track]!.clips.push(c);
        if (came.get(c.id) !== list[p.track]) adoptTrackProps(list[p.track]!, came.get(c.id)!.props);
      }
      for (const t of new Set(plan.placements.map((p) => list[p.track]!))) t.clips.sort((x, y) => x.start - y.start);
    },
  }),
  defineCommand({
    id: "clip.trim",
    description:
      "Move a clip's start and/or end edge (timeline seconds) without moving its content; edges stop where the media begins or ends. Linked clips are trimmed to the same edges. `ripple` (Shift-drag of an edge) moves later clips on the track so no gap opens or closes: the start edge then stays put and the content slides; an end lengthened into a gap fills it first, then pushes what is after. `with` (several clips selected, one edge dragged): those clips' same edge, and their linked clips', moves by as much as this one's, all stopping where the first can go no further",
    args: z
      .strictObject({
        clip: Id,
        start: Seconds.optional(),
        end: Seconds.optional(),
        linked: Linked,
        ripple: z.boolean().default(false),
        with: z.array(Id).optional().describe("Other clips trimmed by the same amount at the same edge"),
      })
      .refine((a) => !a.ripple || a.start === undefined || a.end === undefined, { message: "a ripple trim moves one edge" })
      .refine((a) => !a.with?.length || (a.start === undefined) !== (a.end === undefined), { message: "trimming several clips moves one edge" }),
    apply(doc, { clip, start, end, linked, ripple, with: others }, ctx) {
      const loc = findClip(doc, ctx.registry, clip);
      if (others?.length) {
        const edge = start !== undefined ? "start" : "end";
        const all = locate(doc, ctx.registry, [clip, ...others], linked);
        if (ripple && new Set(all.map((l) => l.track)).size < all.length) throw new Error("a ripple trim of several clips needs each on a track of its own");
        let by = onTrack(doc, loc, (edge === "start" ? start : end)!) - (edge === "start" ? loc.clip.start : clipEnd(loc.clip));
        for (const { clip: c, track } of all) {
          unlocked(track);
          const [lo, hi] = trimRoom(doc, track, c, edge, holds(ctx.registry, c), ripple);
          by = Math.min(Math.max(by, lo), hi);
        }
        const push = edge === "end" ? ripplePush(by, all.map(({ clip: c, track }) => ({ track, at: clipEnd(c), clip: c }))) : by;
        for (const { clip: c, track } of all) {
          const oldStart = c.start;
          const oldEnd = clipEnd(c);
          if (edge === "start") {
            shiftIn(c, by, ctx.registry);
            if (ripple) {
              c.start = oldStart;
              shiftLater(track, oldEnd, -by, c);
            }
          } else {
            c.duration += by;
            if (ripple) shiftLater(track, oldEnd, push, c);
          }
        }
        return;
      }
      const s = start === undefined ? undefined : onTrack(doc, loc, start);
      const e = end === undefined ? undefined : onTrack(doc, loc, end);
      const trimmed = withLinked(loc, linked);
      // Every end moves to the same time, so the gap after them all is measured before any moves.
      const ends = trimmed.map(({ clip: c, track }) => ({ track, at: clipEnd(c), clip: c }));
      let push: Ticks | undefined;
      for (const { clip: c, track } of trimmed) {
        unlocked(track);
        const oldStart = c.start;
        const oldEnd = clipEnd(c);
        // Edges stop at the clips beside them; a ripple trim moves them instead.
        const [lo, hi] = ripple ? [-Infinity, Infinity] : trimBounds(track, c);
        if (s !== undefined) {
          const to = Math.max(s, mediaBounds(doc, c, holds(ctx.registry, c))[0], lo);
          shiftIn(c, to - c.start, ctx.registry);
          if (ripple) {
            c.start = oldStart;
            shiftLater(track, oldEnd, oldStart - to, c);
          }
        }
        if (e !== undefined) {
          c.duration = Math.min(e, mediaBounds(doc, c, holds(ctx.registry, c))[1], hi) - c.start;
          push ??= ripplePush(clipEnd(c) - oldEnd, ends);
          if (ripple) shiftLater(track, oldEnd, push, c);
        }
        if (c.duration <= 0) throw new Error(`clip "${c.id}" would be empty`);
      }
    },
  }),
  defineCommand({
    id: "asset.replace",
    description:
      "Replace an imported video, image or audio file with another of the same kind (Replace Media…; agents use media_replace, which probes the file). Its clips keep their places and settings, shortened where the new media ends sooner and removed where it ends before they begin. Not for recordings, whose streams are clips of their own",
    args: z.strictObject({ asset: Id, path: AssetSchema.shape.path, fingerprint: z.string(), derived: AssetSchema.shape.derived }),
    apply(doc, { asset, path, fingerprint, derived }, ctx) {
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      if (a.kind === "recording") throw new Error("a recording can't be replaced: its screen, camera and audio are clips of their own");
      Object.assign(a, { path, fingerprint, derived });
      const uses = [...walkClips(doc.tracks, ctx.registry)].filter((l) => l.clip.assetId === asset);
      for (const { clip, track } of uses) {
        const end = mediaBounds(doc, clip, holds(ctx.registry, clip))[1];
        if (end <= clip.start) track.clips.splice(track.clips.indexOf(clip), 1);
        else if (clipEnd(clip) > end) clip.duration = end - clip.start;
      }
    },
  }),
  defineCommand({
    id: "clip.speed",
    description:
      "Clip speed: play clips (and their linked clips) `speed` times as fast, 0.1–10; the same media then takes 1/speed as long on the timeline, its start staying put. Refused when the clip would run into the next one on its track. `speed: null` removes the change (1x)",
    args: z.strictObject({ clips: z.array(Id).min(1), speed: z.number().min(0.1).max(10).nullable(), linked: Linked }),
    apply(doc, { clips, speed, linked }, ctx) {
      const frame = ticksPerFrame(doc.settings.fps);
      for (const { clip: c, track } of locate(doc, ctx.registry, clips, linked)) {
        unlocked(track);
        const media = c.duration * clipSpeed(c);
        const to = speed ?? 1;
        const duration = Math.max(frame, Math.round(media / to / frame) * frame);
        const next = Math.min(...track.clips.filter((x) => x !== c && x.start >= clipEnd(c)).map((x) => x.start));
        if (!track.magnetic && c.start + duration > next) {
          throw new Error(`not enough room on the timeline for clip "${c.id}" at ${to}x: move the media after it first`);
        }
        if (speed === null || to === 1) delete c.speed;
        else c.speed = rational(to);
        c.duration = duration;
      }
    },
  }),
  defineCommand({
    id: "clip.split",
    description:
      "Split clips at a timeline time (seconds). Without `clips`, splits every clip on unlocked tracks under that time; with `clips`, those and their linked clips. Returns the ids of the new right-hand pieces",
    args: z.strictObject({ at: Seconds, clips: z.array(Id).optional(), linked: Linked }),
    apply(doc, { at, clips, linked }, ctx) {
      const t = snapSeconds(at, doc.settings.fps);
      const locs = clips
        ? locate(doc, ctx.registry, clips, linked)
        : doc.tracks.filter((tr) => !tr.locked).flatMap((track) => track.clips.map((clip) => ({ clip, track, tracks: doc.tracks, offset: 0 })));
      const links = new Map<string, string>();
      const out: string[] = [];
      for (const { clip, track, offset } of locs) {
        const at = t - offset;
        if (at <= clip.start || at >= clipEnd(clip)) continue;
        unlocked(track);
        out.push(splitAt(track, clip, at, ctx, links).id);
      }
      return out;
    },
  }),
  defineCommand({
    id: "clip.unlink",
    description: "Unlink clips from the clips recorded with them, so each can be moved and cut on its own",
    args: z.strictObject({ clips: z.array(Id).min(1) }),
    apply(doc, { clips }, ctx) {
      for (const { clip } of locate(doc, ctx.registry, clips, true)) delete clip.linkId;
    },
  }),
  defineCommand({
    id: "clip.link",
    description: "Link clips so they select, move and cut together, as a recording's clips are",
    args: z.strictObject({ clips: z.array(Id).min(2) }),
    apply(doc, { clips }, ctx) {
      const link = ctx.newId("link");
      for (const { clip } of locate(doc, ctx.registry, clips, true)) clip.linkId = link;
    },
  }),
  defineCommand({
    id: "clip.extendFrame",
    description:
      "Hold a video clip's last frame for `duration` seconds after it, or with `edge: \"start\"` its first frame for `duration` before it, as a new still clip (⌥-drag of a clip's end or start); a stitched clip's from the piece at that edge, in the stitched clip's look. `ripple` moves the clips after it on the track to make room (with `start`, the clip too). Returns the still's id",
    args: z.strictObject({ clip: Id, duration: z.number().positive(), edge: z.enum(["start", "end"]).default("end"), ripple: z.boolean().default(false) }),
    apply(doc, { clip, duration, edge, ripple }, ctx) {
      const loc = findClip(doc, ctx.registry, clip);
      const { clip: c, track } = loc;
      unlocked(track);
      const stitched = ctx.registry.hasTrait(c.type, "stitched");
      if (!stitched && (!ctx.registry.hasTrait(c.type, "video") || !c.assetId)) throw new Error(`clip "${clip}" is not a video clip`);
      const frame = ticksPerFrame(doc.settings.fps);
      const d = Math.max(frame, snapSeconds(duration, doc.settings.fps));
      // Room is made on the tracks of the clips linked to it too, so its sound stays with it.
      const linked = withLinked(loc, true);
      for (const l of linked) unlocked(l.track);
      const make = (from: (l: ClipLocation) => Ticks, except?: boolean) => {
        for (const l of linked) shiftLater(l.track, from(l), d, except ? l.clip : undefined);
      };
      let start: Ticks;
      if (edge === "start") {
        const room = ripple || track.magnetic;
        start = room ? c.start : c.start - d;
        if (room) make((l) => l.clip.start);
        else if (start < groupFloor(doc, ctx.registry, loc) || !isFree(track, start, c.start))
          throw new Error("there is media (or the start of the timeline or group) right before the clip; extend it with `ripple`");
      } else {
        start = clipEnd(c);
        if (ripple) make((l) => clipEnd(l.clip), true);
        else if (!track.magnetic && !isFree(track, start, start + d)) throw new Error("there is media right after the clip; extend it with `ripple`");
      }
      const id = ctx.newId("clip");
      const groups = new Set(ctx.registry.groupsFor("still").map((g) => g.id));
      const held = edge === "start" ? (c.mediaStart ?? 0) : mediaTimeAt(c, clipEnd(c) - frame);
      // A stitched clip's frame is its piece's there (its time on the clip's inner track), in the stitched clip's look.
      const piece = stitched ? ctx.registry.nestedTracks(c).flatMap((t) => t.clips).find((p) => p.assetId && (p.type === "still" || ctx.registry.hasTrait(p.type, "video")) && p.start <= held && held < clipEnd(p)) : c;
      if (!piece) throw new Error(`clip "${clip}" has no picture at its ${edge}`);
      const frameAt = piece === c ? held : piece.type === "still" ? (piece.mediaStart ?? 0) : mediaTimeAt(piece, held);
      // The frame as it shows there, animations and all (a zoom in), since the still has none of its own.
      const animated = new Set(c.animations.flatMap((a) => Object.keys(a.to).map((target) => target.split(".")[0]!)));
      const shown = resolveProps(ctx.registry, c, held);
      // What the piece carries itself (which stream, its cursor) is the piece's; the stitched clip's look goes over it.
      const own = piece === c ? {} : Object.fromEntries(Object.entries(resolveProps(ctx.registry, piece, frameAt)).filter(([k]) => groups.has(k) && k in piece.props));
      const still: Clip = {
        id,
        type: "still",
        start,
        duration: d,
        mediaStart: frameAt,
        assetId: piece.assetId,
        props: clone({ ...own, ...Object.fromEntries(Object.entries(shown).filter(([k]) => groups.has(k) && (k in c.props || animated.has(k)))) }),
        effects: oneOfEach([...(piece === c ? [] : piece.effects), ...c.effects]).filter((fx) => ctx.registry.effectFits(fx.type, "still")).map((fx) => freshEffect(fx, ctx.newId)),
        animations: [],
      };
      track.clips.splice(track.clips.indexOf(c) + (edge === "start" ? 0 : 1), 0, still);
      return id;
    },
  }),
  defineCommand({
    id: "clip.paste",
    description:
      "Paste copied clips (a `clipboard` from the editor's `clipboard.copy`, in its session) at a timeline time: onto the tracks they came from when those are free there, else the lowest free ones, else new tracks on top; or onto `track` and the tracks above it. Assets come along. Returns the new clip ids",
    args: z.strictObject({ clipboard: ClipboardSchema, at: Seconds, track: Id.optional() }),
    apply(doc, { clipboard, at, track }, ctx) {
      const t0 = snapSeconds(at, doc.settings.fps);
      const assets = new Map<string, string>();
      for (const a of clipboard.assets) {
        const same = Object.values(doc.assets).find((x) => x.path === a.path && x.fingerprint === a.fingerprint);
        const id = same?.id ?? (doc.assets[a.id] ? ctx.newId("asset") : a.id);
        if (!same) doc.assets[id] = { ...clone(a), id };
        assets.set(a.id, id);
      }
      let base = pasteBase(doc.tracks, clipboard, t0);
      if (track !== undefined) {
        base = doc.tracks.findIndex((t) => t.id === track);
        if (base < 0) throw new Error(`no track "${track}"`);
        for (const { clip, row } of clipboard.items) {
          const to = doc.tracks[base + row];
          if (to && !to.magnetic && !isFree(to, t0 + clip.start, t0 + clipEnd(clip))) throw new Error(`there is media in the way on "${to.name}"`);
        }
      }
      const links = new Map<string, string>();
      const out: string[] = [];
      for (const { clip, row } of clipboard.items) {
        while (doc.tracks.length <= base + row) doc.tracks.push({ id: ctx.newId("track"), name: "", clips: [] });
        const to = doc.tracks[base + row]!;
        unlocked(to);
        if (to.hidden) throw new Error(`track "${to.name}" is disabled`);
        adoptTrackProps(to, clipboard.trackProps?.[row]);
        const copy = copyClip(clip, ctx);
        copy.start = t0 + clip.start;
        if (copy.linkId) copy.linkId = copiedLink(links, copy.linkId, ctx);
        remapAssetIds(copy, assets);
        to.clips.push(copy);
        to.clips.sort((x, y) => x.start - y.start);
        out.push(copy.id);
      }
      return out;
    },
  }),
  defineCommand({
    id: "timeline.rippleDelete",
    description:
      "Delete time ranges (timeline seconds) from every unlocked, enabled track (locked and disabled tracks are left as they are) and close the gaps, splitting clips that cross a range edge. Ranges are all read against the timeline as it is before this command, so pass every cut at once. A piece of a cut clip that would be left under half a second goes with the cut (no slivers). The rough-cut workhorse",
    args: z.strictObject({ ranges: Ranges, exact: Exact }),
    apply(doc, { ranges, exact }, ctx) {
      rippleDeleteRanges(doc, ranges, ctx, exact);
    },
  }),
  defineCommand({
    id: "timeline.deleteRanges",
    description:
      "Delete time ranges (timeline seconds) from every unlocked, enabled track, splitting clips that cross a range edge and leaving gaps (Delete with an in/out selection); a piece of a cut clip that would be left under half a second goes too; `timeline.rippleDelete` closes them",
    args: z.strictObject({ ranges: Ranges, exact: Exact }),
    apply(doc, { ranges, exact }, ctx) {
      for (const [a, b] of normalizeRanges(doc, ranges, ctx.registry, ctx.data, exact)) removeRange(doc, doc.tracks, a, b, ctx, false);
    },
  }),
  defineCommand({
    id: "timeline.insertSpace",
    description:
      "Open a gap of `duration` seconds at a timeline time on every unlocked track (or only `track`), splitting clips there and moving everything after it, markers too unless only one track moves (Shift-drag right of the playhead or a gap)",
    args: z.strictObject({ at: Seconds, duration: z.number().positive(), track: Id.optional() }),
    apply(doc, { at, duration, track }, ctx) {
      const t = snapSeconds(at, doc.settings.fps);
      const d = snapSeconds(duration, doc.settings.fps);
      if (!d) return;
      const links = new Map<string, string>();
      for (const tr of withLinkedTracks(doc.tracks, spaceTracks(doc, track), t)) {
        for (const c of [...tr.clips]) if (c.start < t && clipEnd(c) > t) splitAt(tr, c, t, ctx, links);
        shiftLater(tr, t, d);
      }
      if (!track) {
        for (const m of doc.markers) if (m.time >= t) m.time += d;
        openSections(doc, t, d);
      }
    },
  }),
  defineCommand({
    id: "timeline.removeSpace",
    description:
      "Close `duration` seconds of empty time just before a timeline time on every unlocked track (or only `track`), moving everything after it back, markers too unless only one track moves (Shift-drag left of the playhead or a gap). Refused where media is in that time",
    args: z.strictObject({ at: Seconds, duration: z.number().positive(), track: Id.optional() }),
    apply(doc, { at, duration, track }) {
      const t = snapSeconds(at, doc.settings.fps);
      const tracks = withLinkedTracks(doc.tracks, spaceTracks(doc, track), t);
      const room = t - Math.max(0, ...tracks.flatMap((tr) => tr.clips.filter((c) => c.start < t).map((c) => Math.min(clipEnd(c), t))));
      let d = Math.min(snapSeconds(duration, doc.settings.fps), t);
      // All the room asked for, rounded to a frame past media that ends between frames: as far as the media.
      if (d > room && d - room < ticksPerFrame(doc.settings.fps)) d = room;
      if (d <= 0) return;
      if (d > room) throw new Error("there is media in that time; only empty time can be closed");
      for (const tr of tracks) shiftLater(tr, t, -d);
      if (!track) {
        for (const m of doc.markers) if (m.time >= t - d) m.time = Math.max(t - d, m.time - d);
        cutSections(doc, t - d, t);
      }
    },
  }),
];

function hasNested(tracks: Track[], ctx: CommandContext): boolean {
  return tracks.some((t) => t.clips.some((c) => ctx.registry.nestedTracks(c).length));
}

/**
 * Magnetic tracks have no gaps: clips are packed from the start in the order
 * of their middles, so a clip dropped between two makes room. Tracks inside
 * groups too.
 */
export function packMagnetic(doc: Project, ctx: CommandContext) {
  // Walking the draft makes a draft of every clip, on every transaction: only when a track is magnetic (read on
  // the draft, so one made magnetic in this transaction counts) or there are nested tracks that could be (in the
  // original: a group pasted or added in this transaction brings its inner tracks already packed).
  if (!doc.tracks.some((t) => t.magnetic) && !hasNested((isDraft(doc) ? original(doc)! : doc).tracks, ctx)) return;
  const lists = [doc.tracks];
  for (const { clip } of walkClips(doc.tracks, ctx.registry)) {
    lists.push(ctx.registry.nestedTracks(clip));
  }
  for (const track of lists.flat()) {
    if (!track.magnetic) continue;
    let at = 0;
    for (const c of [...track.clips].sort((x, y) => x.start + x.duration / 2 - (y.start + y.duration / 2))) {
      if (c.start !== at) c.start = at;
      at += c.duration;
    }
  }
}
