import { z } from "zod";
import {
  clipEnd,
  defineAction,
  defineCommand,
  defineFeature,
  ticksToSeconds,
  TrackSchema,
  type Animation,
  type Clip,
  type CommandContext,
  type Track,
  clone,
  cutToWindow,
  freshEffect,
  drawNested,
  nestedAudio,
} from "@beacon/model";
import { cursor } from "../cursor";
import { visualSize } from "../media";

const stitchSchema = z.strictObject({
  /** The segments' picture size: they fill it, and the clip's transform places it like any media. */
  width: z.number().positive(),
  height: z.number().positive(),
  /** One track: the segments end to end on the clip's inner timeline. */
  tracks: z.array(TrackSchema).length(1),
});

type Stitch = z.infer<typeof stitchSchema>;

/** What the outer clip carries for its segments. */
const LOOK = ["transform", "crop"];
const FLAT = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 };

/** Source media time ↔ the stitched clip's inner time, through one segment. */
const toInner = (seg: Clip, media: number) => seg.start + (media - (seg.mediaStart ?? 0));
const toSource = (seg: Clip, inner: number) => (seg.mediaStart ?? 0) + (inner - seg.start);

/** Which effects and animation targets the stitched clip itself can carry; the rest belong to its pieces. */
function outerFits(ctx: CommandContext) {
  const groups = new Map(ctx.registry.groupsFor("stitched").map((g) => [g.id, g]));
  return {
    effect: (type: string) => ctx.registry.effectFits(type, "stitched"),
    target: (key: string) => {
      const [group, field] = key.split(".", 2);
      return !!groups.get(group!)?.animatable?.includes(field ?? "");
    },
  };
}

function stitchClips(doc: { tracks: Track[] }, ids: string[], ctx: CommandContext) {
  const track = doc.tracks.find((t) => t.clips.some((c) => ids.includes(c.id)));
  if (!track) throw new Error("only clips on the main timeline can be stitched");
  if (track.locked) throw new Error(`track "${track.name}" is locked`);
  const clips = track.clips.filter((c) => ids.includes(c.id)).sort((a, b) => a.start - b.start);
  if (clips.length !== new Set(ids).size) throw new Error("stitched clips must be on one track");
  if (clips.length < 2) throw new Error("select at least two clips to stitch");
  for (const [i, c] of clips.entries()) {
    if (c.speed) throw new Error("clips with a speed change can't be stitched");
    if (c.assetId !== clips[0]!.assetId || !c.assetId) throw new Error("only pieces of the same recording can be stitched");
    if (i && c.start !== clipEnd(clips[i - 1]!)) throw new Error("stitched clips must be next to each other, with no gap");
    if (!ctx.registry.hasTrait(c.type, "visual")) throw new Error("only visual media can be stitched");
  }
  return { track, clips };
}

/**
 * Stitched media: pieces of one
 * recording joined into one clip, so its transform, effects and animations
 * run across the joins. The pieces sit end to end on the clip's own track
 * and canvas; the clip shows them through a window (`mediaStart`/duration),
 * so splitting and trimming it work as for any clip.
 */
export const stitching = defineFeature({
  id: "stitching",
  version: 1,
  clipTypes: [{ id: "stitched", description: "Pieces of one recording joined into one clip (stitched media)", traits: ["visual", "picture", "stitched"] }],
  props: [
    {
      id: "stitch",
      description: "The joined pieces, end to end on one inner track, and their picture size",
      traits: ["stitched"],
      schema: stitchSchema,
      defaults: () => ({ width: 1920, height: 1080, tracks: [{ id: "segments", name: "Segments", clips: [] }] }),
      nested: (v: Stitch) => v.tracks,
      size: (v: Stitch) => [v.width, v.height],
    },
  ],
  evaluate: {
    clip(e, ctx) {
      if (e.clip.type === "stitched" && e.props.stitch) drawNested(e, e.props.stitch as Stitch, ctx);
    },
    audio: (clip, ctx) => (clip.type === "stitched" ? nestedAudio(clip, (clip.props.stitch as Stitch | undefined)?.tracks, ctx) : []),
  },
  commands: [
    defineCommand({
      id: "clip.stitch",
      description:
        "Stitch pieces of one recording that sit next to each other on a track into one clip (⌥⌘I): the first piece's transform, crop and visual effects, and every piece's transform and crop animations, move to the stitched clip, so they run across the joins; cursor effects and cursor animations stay on each piece. Returns its id",
      args: z.strictObject({ clips: z.array(z.string().min(1)).min(2) }),
      apply(doc, { clips }, ctx) {
        const { track, clips: pieces } = stitchClips(doc, clips, ctx);
        const first = pieces[0]!;
        const size = visualSize(doc, ctx.registry, first) ?? [doc.settings.width, doc.settings.height];
        const fits = outerFits(ctx);
        const animations = new Map<string, Animation>();
        const segments: Clip[] = pieces.map((c, i) => {
          const seg = clone(c) as Clip;
          seg.start = c.start - first.start;
          const windowEnd = (c.mediaStart ?? 0) + c.duration;
          const own: Animation[] = [];
          for (const a of c.animations) {
            const outer = Object.keys(a.to).filter(fits.target);
            const rest = Object.keys(a.to).filter((k) => !fits.target(k));
            // Targets the stitched clip can't take (the cursor's) stay on the piece.
            if (rest.length) own.push({ ...clone(a), ...(outer.length ? { id: ctx.newId("anim") } : {}), to: Object.fromEntries(rest.map((k) => [k, a.to[k]])) });
            // Split pieces share blocks (same ids, source time); keep each once, on the inner timeline.
            if (!outer.length || animations.has(a.id) || a.end > windowEnd) continue;
            const block: Animation = { ...clone(a), to: Object.fromEntries(outer.map((k) => [k, a.to[k]])), end: toInner(seg, a.end) };
            // A block that ended before a later piece starts shows there as it holds: a cut at the join, not a ramp over the piece before.
            if (i && block.end < seg.start) Object.assign(block, { end: seg.start, duration: 0 });
            animations.set(a.id, block);
          }
          for (const g of LOOK) delete seg.props[g];
          seg.effects = seg.effects.filter((fx) => !fits.effect(fx.type));
          seg.animations = own;
          return seg;
        });
        const id = ctx.newId("clip");
        const stitched: Clip = {
          id,
          type: "stitched",
          start: first.start,
          duration: clipEnd(pieces.at(-1)!) - first.start,
          mediaStart: 0,
          props: { ...Object.fromEntries(LOOK.filter((g) => first.props[g]).map((g) => [g, clone(first.props[g])])), stitch: { width: size[0], height: size[1], tracks: [{ id: ctx.newId("track"), name: "Segments", clips: segments }] } },
          effects: first.effects.filter((fx) => fits.effect(fx.type)).map((fx) => freshEffect(fx, ctx.newId)),
          animations: [...animations.values()].sort((a, b) => a.end - b.end),
        };
        track.clips = [...track.clips.filter((c) => !clips.includes(c.id)), stitched].sort((a, b) => a.start - b.start);
        return id;
      },
    }),
    defineCommand({
      id: "clip.unstitch",
      description:
        "Take a stitched clip apart into its pieces (⇧⌘\\\\): what shows through its window, each piece with the stitched clip's transform, crop, effects and animations as well as its own cursor effects and animations. Returns the pieces' ids",
      args: z.strictObject({ clip: z.string().min(1) }),
      apply(doc, { clip }, ctx) {
        const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clip));
        const s = track?.clips.find((c) => c.id === clip);
        if (!track || !s || s.type !== "stitched") throw new Error(`"${clip}" is not stitched media on the main timeline`);
        if (track.locked) throw new Error(`track "${track.name}" is locked`);
        const [a, b] = [s.mediaStart ?? 0, (s.mediaStart ?? 0) + s.duration];
        const out: Clip[] = [];
        for (const seg of (s.props.stitch as Stitch).tracks[0]!.clips) {
          const c = cutToWindow(seg, a, b, ctx.registry);
          if (!c) continue;
          for (const g of LOOK) if (s.props[g]) c.props[g] = clone(s.props[g]);
          c.effects = [...seg.effects, ...s.effects.map((fx) => freshEffect(fx, ctx.newId))];
          // Every piece keeps every block, in its own source time, as split pieces do.
          c.animations = [...seg.animations, ...s.animations.map((x) => ({ ...clone(x), end: toSource(seg, x.end) }))].sort((x, y) => x.end - y.end);
          c.start = s.start + (c.start - a);
          c.id = ctx.newId("clip");
          out.push(c);
        }
        track.clips = [...track.clips.filter((c) => c.id !== clip), ...out].sort((x, y) => x.start - y.start);
        return out.map((c) => c.id);
      },
    }),
  ],
  actions: [
    defineAction({
      id: "edit.stitch",
      description: "Stitch the selected pieces of one recording into one clip (⌥⌘I)",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to stitch media");
        return {
          label: "Stitch Media",
          steps: [{ command: "clip.stitch", args: { clips: ctx.session.selection } }],
          after: (r) => [{ command: "selection.set", args: { clips: [r[0] as string], linked: false } }],
        };
      },
    }),
    defineAction({
      id: "edit.unstitch",
      description: "Take the selected stitched clips apart (Remove All Stitches, ⇧⌘\\\\)",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        const stitched = ctx.project.tracks.flatMap((t) => t.clips.filter((c) => c.type === "stitched" && ctx.session.selection.includes(c.id)));
        if (!stitched.length) throw new Error("select stitched media first");
        return {
          label: "Remove All Stitches",
          steps: stitched.map((c) => ({ command: "clip.unstitch", args: { clip: c.id } })),
          after: (r) => [{ command: "selection.set", args: { clips: (r as string[][]).flat(), linked: false } }],
        };
      },
    }),
  ],
  camtasia: {
    clipTypes: { StitchedMedia: () => ({ type: "stitched" }) },
    params(media, clip, ctx) {
      if (clip.type !== "stitched") return;
      const tracks = ctx.tracks([{ medias: media.medias ?? [] }]);
      const first = tracks[0]?.clips[0];
      const asset = typeof media.medias?.[0]?.src === "number" ? ctx.asset(media.medias[0].src) : undefined;
      const stream = (first?.props.media as { stream?: number } | undefined)?.stream ?? 0;
      const info = asset?.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined;
      const s = info?.streams?.filter((x) => x.kind === "video")[stream];
      // A `.cmproj` keeps cursor settings on the stitched clip; here each piece draws its own cursor.
      const cursorGroup = cursor.props!.find((g) => g.id === "cursor")!;
      const outer = Object.fromEntries(
        (
          [
            ["scale", "cursorScale"],
            ["opacity", "cursorOpacity"],
            ["smoothing", "cursorTrackLevel"],
          ] as const
        )
          .map(([field, name]) => [field, ctx.value(media, name)] as const)
          .filter(([, v]) => v !== undefined)
          .map(([field, v]) => [field, Number(v)]),
      );
      const across = ctx.value(media, "smoothCursorAcrossEditDuration");
      if (across !== undefined) outer.smoothAcrossEdits = ticksToSeconds(Number(across));
      for (const seg of tracks[0]?.clips ?? []) {
        seg.props.transform = { ...FLAT };
        if (seg.type === "screen" || seg.type === "still") seg.props.cursor = { ...cursorGroup.defaults(), ...(seg.props.cursor as object | undefined), ...outer };
      }
      clip.props.stitch = { width: s?.width ?? 1920, height: s?.height ?? 1080, tracks: tracks.length ? tracks : [{ id: "segments", name: "Segments", clips: [] }] };
    },
  },
});
