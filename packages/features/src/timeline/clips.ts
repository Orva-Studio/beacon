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
  findClip,
  locate,
  onTrack,
  withLinked,
  IdSchema as Id,
  SecondsSchema as Seconds,
} from "@beacon/model";

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

/** Merged, frame-snapped, latest first, so earlier ranges are unaffected by later deletions. */
function normalizeRanges(doc: Project, ranges: { start: number; end: number }[]): [Ticks, Ticks][] {
  const snapped = ranges.map((r) => [snapSeconds(r.start, doc.settings.fps), snapSeconds(r.end, doc.settings.fps)] as [Ticks, Ticks]).filter(([a, b]) => b > a);
  return mergeSpans(snapped).reverse() as [Ticks, Ticks][];
}

/** Removes `[a, b)` from each unlocked, enabled track; with `ripple`, later media moves left to close the gap. */
function removeRange(doc: Project, tracks: Track[], a: Ticks, b: Ticks, ctx: CommandContext, ripple: boolean) {
  const gap = b - a;
  const links = new Map<string, string>();
  for (const track of tracks) {
    if (track.locked || track.hidden) continue;
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
  }
}

/** Deletes timeline ranges (seconds, read against the timeline before any of them) from every unlocked, enabled track and closes the gaps. */
export function rippleDeleteRanges(doc: Project, ranges: { start: number; end: number }[], ctx: CommandContext) {
  for (const [a, b] of normalizeRanges(doc, ranges)) removeRange(doc, doc.tracks, a, b, ctx, true);
}

/** Moves every clip on `track` starting at or after `from` (other than `except`) by `by`. */
/** The main timeline's tracks a space edit moves: one, or every unlocked one. */
function spaceTracks(doc: Project, track?: string): Track[] {
  if (!track) return doc.tracks.filter((t) => !t.locked);
  const one = doc.tracks.find((t) => t.id === track);
  if (!one) throw new Error(`no track "${track}" on the main timeline`);
  unlocked(one);
  return [one];
}

function shiftLater(track: Track, from: Ticks, by: Ticks, except?: Clip) {
  for (const c of track.clips) if (c !== except && c.start >= from) c.start += by;
}

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
      "Remove clips (and the clips linked to them). With `ripple`, later clips on the tracks they were on move left by the time removed, by the same amount on every one of those tracks, so they stay in sync",
    args: z.strictObject({ clip: Id.optional(), clips: z.array(Id).min(1).optional(), linked: Linked, ripple: z.boolean().default(false) }).refine(one, ONE),
    apply(doc, { clip, clips, linked, ripple }, ctx) {
      const locs = locate(doc, ctx.registry, clips ?? [clip!], linked);
      for (const l of locs) unlocked(l.track);
      // The removed time: the union of the clips' spans, across tracks.
      const union = mergeSpans(locs.map((l) => [l.clip.start, clipEnd(l.clip)]));
      const affected = new Set(locs.map((l) => l.track));
      for (const { clip: c, track } of locs) track.clips.splice(track.clips.indexOf(c), 1);
      if (!ripple) return;
      for (const track of affected) {
        // Time a clip left behind still covers isn't removed from its track, so nothing overlaps.
        const gaps = union.flatMap((span) => subtractSpans(span, track.clips.map((c) => [c.start, clipEnd(c)])));
        const removedBefore = (t: Ticks) => gaps.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, t) - a), 0);
        for (const c of track.clips) c.start -= removedBefore(c.start);
      }
    },
  }),
  defineCommand({
    id: "clip.move",
    description:
      "Move clips in time (`start` for the first clip, or `by` seconds) and/or to other tracks (`track` for the first clip, or `tracks` up, negative down; past the top, tracks are added). The named clips move as a block; linked clips move by the same time but stay on their tracks. Refused if they would land on locked tracks or over other media, except on magnetic tracks, which make room. `ripple` (Shift-drag) also moves every later clip on their tracks",
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
      "Move a clip's start and/or end edge (timeline seconds) without moving its content; edges stop where the media begins or ends. Linked clips are trimmed to the same edges. `ripple` (Shift-drag of an edge) moves later clips on the track so no gap opens or closes: the start edge then stays put and the content slides. `with` (several clips selected, one edge dragged): those clips' same edge, and their linked clips', moves by as much as this one's, all stopping where the first can go no further",
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
            if (ripple) shiftLater(track, oldEnd, by, c);
          }
        }
        return;
      }
      const s = start === undefined ? undefined : onTrack(doc, loc, start);
      const e = end === undefined ? undefined : onTrack(doc, loc, end);
      for (const { clip: c, track } of withLinked(loc, linked)) {
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
          if (ripple) shiftLater(track, oldEnd, clipEnd(c) - oldEnd, c);
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
        effects: [...(piece === c ? [] : piece.effects), ...c.effects].filter((fx) => ctx.registry.effectFits(fx.type, "still")).map((fx) => freshEffect(fx, ctx.newId)),
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
      "Delete time ranges (timeline seconds) from every unlocked, enabled track (locked and disabled tracks are left as they are) and close the gaps, splitting clips that cross a range edge. Ranges are all read against the timeline as it is before this command, so pass every cut at once. The rough-cut workhorse",
    args: z.strictObject({ ranges: Ranges }),
    apply(doc, { ranges }, ctx) {
      rippleDeleteRanges(doc, ranges, ctx);
    },
  }),
  defineCommand({
    id: "timeline.deleteRanges",
    description:
      "Delete time ranges (timeline seconds) from every unlocked, enabled track, splitting clips that cross a range edge and leaving gaps (Delete with an in/out selection); `timeline.rippleDelete` closes them",
    args: z.strictObject({ ranges: Ranges }),
    apply(doc, { ranges }, ctx) {
      for (const [a, b] of normalizeRanges(doc, ranges)) removeRange(doc, doc.tracks, a, b, ctx, false);
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
      for (const tr of spaceTracks(doc, track)) {
        for (const c of [...tr.clips]) if (c.start < t && clipEnd(c) > t) splitAt(tr, c, t, ctx, links);
        shiftLater(tr, t, d);
      }
      if (!track) for (const m of doc.markers) if (m.time >= t) m.time += d;
    },
  }),
  defineCommand({
    id: "timeline.removeSpace",
    description:
      "Close `duration` seconds of empty time just before a timeline time on every unlocked track (or only `track`), moving everything after it back, markers too unless only one track moves (Shift-drag left of the playhead or a gap). Refused where media is in that time",
    args: z.strictObject({ at: Seconds, duration: z.number().positive(), track: Id.optional() }),
    apply(doc, { at, duration, track }) {
      const t = snapSeconds(at, doc.settings.fps);
      const tracks = spaceTracks(doc, track);
      const room = t - Math.max(0, ...tracks.flatMap((tr) => tr.clips.filter((c) => c.start < t).map((c) => Math.min(clipEnd(c), t))));
      let d = Math.min(snapSeconds(duration, doc.settings.fps), t);
      // All the room asked for, rounded to a frame past media that ends between frames: as far as the media.
      if (d > room && d - room < ticksPerFrame(doc.settings.fps)) d = room;
      if (d <= 0) return;
      if (d > room) throw new Error("there is media in that time; only empty time can be closed");
      for (const tr of tracks) shiftLater(tr, t, -d);
      if (!track) for (const m of doc.markers) if (m.time >= t - d) m.time = Math.max(t - d, m.time - d);
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
