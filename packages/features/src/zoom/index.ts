import { z } from "zod";
import { defineCommand, defineFeature, EasingSchema, mediaTimeAt, resolveProps, snapSeconds, ticksToSeconds, type Clip, type Project } from "@beacon/model";
import { visualSize } from "../media";
import { findClip } from "../timeline";

interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/**
 * The transform that shows content rectangle `rect` as large as fits on the
 * canvas, centred, without uncovering the canvas where the content covered it.
 */
export function zoomTransform(canvas: [number, number], size: [number, number], rect: { x: number; y: number; width: number; height: number }): Transform {
  const [cw, ch] = canvas;
  const [w, h] = size;
  const s = Math.min(cw / rect.width, ch / rect.height);
  const clamp = (v: number, span: number, view: number) => (span <= view ? 0 : Math.max(-(span - view) / 2, Math.min((span - view) / 2, v)));
  const x = clamp(-s * (rect.x + rect.width / 2 - w / 2), s * w, cw);
  const y = clamp(s * (rect.y + rect.height / 2 - h / 2), s * h, ch);
  return { x, y, scaleX: s, scaleY: s };
}


function targets(t: Transform) {
  return { "transform.x": t.x, "transform.y": t.y, "transform.scaleX": t.scaleX, "transform.scaleY": t.scaleY };
}

/**
 * Adds a block ending at timeline `start + duration` to the piece it ends
 * in, and the same block (it is in media time) to the later pieces in `also`.
 */
function block(doc: Project, pieces: Clip[], also: Clip[], newId: () => string, start: number, duration: number, easing: "linear" | "easeInOut", to: Transform): string[] {
  const end = snapSeconds(start + duration, doc.settings.fps);
  const owner = pieces.find((c) => end > c.start && end <= c.start + c.duration);
  if (!owner) throw new Error(`zoom block ending at ${start + duration}s is outside the clip and its pieces`);
  const anim = { end: mediaTimeAt(owner, end), duration: end - snapSeconds(start, doc.settings.fps), easing, to: targets(to) };
  return [owner, ...also.filter((c) => c !== owner)].map((c) => {
    const id = newId();
    c.animations.push({ id, ...anim });
    return id;
  });
}

/**
 * The clip and the other pieces of the same source after cuts: clips on its
 * track showing the same asset, in timeline order.
 */
function piecesOf(track: { clips: Clip[] }, clip: Clip): Clip[] {
  return track.clips.filter((c) => c.type === clip.type && c.assetId === clip.assetId).sort((a, b) => a.start - b.start);
}

/** Pieces from `first` to `last` inclusive; they must follow each other on the track and in the source. */
function span(track: { clips: Clip[] }, pieces: Clip[], first: Clip, last: Clip): Clip[] {
  const out = pieces.slice(pieces.indexOf(first), pieces.indexOf(last) + 1);
  for (const [i, c] of out.entries()) {
    const prev = out[i - 1];
    if (!prev) continue;
    const between = track.clips.find((o) => !out.includes(o) && o.start >= prev.start + prev.duration && o.start < c.start);
    if (between) throw new Error(`the zoom would run across clip "${between.id}", which shows something else; end it before ${ticksToSeconds(between.start)}s`);
    if (mediaTimeAt(c, c.start) < mediaTimeAt(prev, prev.start + prev.duration)) throw new Error(`pieces "${prev.id}" and "${c.id}" are out of source order, so one zoom can't run across them`);
  }
  return out;
}

const Rect = z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

/** Zoom and pan: transform animation blocks on a clip, computed from a region of its content. */
export const zoom = defineFeature({
  id: "zoom",
  version: 1,
  commands: [
    defineCommand({
      id: "zoom.to",
      description:
        "Zoom a clip (usually the screen recording) into a region of its content: from `at` (timeline seconds) over `duration`, its transform moves so `rect` (content pixels, top-left origin, as in the recording) fills the canvas; or give `center` and `factor` (multiple of the current scale) instead of `rect`. With `until`, it zooms back out to where it was, starting at `until`; between the two the zoom holds across cuts, through every piece of the same recording on that track. Adds transform animation blocks; returns their ids. Your projects' zooms are 0.2-0.4 s linear blocks, hence the defaults",
      args: z
        .strictObject({
          clip: z.string().min(1),
          at: z.number().nonnegative(),
          rect: Rect.optional(),
          center: z.strictObject({ x: z.number(), y: z.number() }).optional(),
          factor: z.number().positive().optional(),
          duration: z.number().positive().default(0.4),
          easing: EasingSchema.default("linear"),
          until: z.number().nonnegative().optional(),
        })
        .refine((a) => a.rect || (a.center && a.factor), "give `rect`, or `center` and `factor`"),
      apply(doc, given, ctx) {
        const loc = findClip(doc, ctx.registry, given.clip);
        // Times on the clip's own track (inside a group, its inner timeline).
        const off = ticksToSeconds(loc.offset);
        const args = { ...given, at: given.at - off, until: given.until === undefined ? undefined : given.until - off };
        const pieces = piecesOf(loc.track, loc.clip);
        const at = snapSeconds(args.at, doc.settings.fps);
        const clip = pieces.find((c) => at >= c.start && at < c.start + c.duration) ?? loc.clip;
        const size = visualSize(doc, clip);
        if (!size) throw new Error(`clip "${clip.id}" has no content size to zoom into`);
        const base = resolveProps(ctx.registry, clip, mediaTimeAt(clip, snapSeconds(args.at, doc.settings.fps))).transform as Transform | undefined;
        if (!base) throw new Error(`clip "${clip.id}" has no transform`);
        const scale = base.scaleX * (args.factor ?? 1);
        const rect = args.rect ?? {
          x: args.center!.x - doc.settings.width / scale / 2,
          y: args.center!.y - doc.settings.height / scale / 2,
          width: doc.settings.width / scale,
          height: doc.settings.height / scale,
        };
        const to = zoomTransform([doc.settings.width, doc.settings.height], size, rect);
        const newId = () => ctx.newId("anim");
        const ids: string[] = [];
        // Across cuts the zoom holds through every piece up to the zoom out, as one zoom.
        let held: Clip[] = [];
        if (args.until !== undefined) {
          if (args.until < args.at + args.duration) throw new Error("`until` is before the zoom in has finished");
          const out = snapSeconds(args.until + args.duration, doc.settings.fps);
          const last = pieces.find((c) => out > c.start && out <= c.start + c.duration);
          if (!last) throw new Error(`the zoom out ending at ${args.until + args.duration}s is outside the clip and its pieces`);
          held = span(loc.track, pieces, clip, last);
        }
        ids.push(...block(doc, pieces, held, newId, args.at, args.duration, args.easing, to));
        if (args.until !== undefined) ids.push(...block(doc, pieces, [], newId, args.until, args.duration, args.easing, base));
        for (const c of pieces) c.animations.sort((a, b) => a.end - b.end);
        return ids;
      },
    }),
  ],
});
