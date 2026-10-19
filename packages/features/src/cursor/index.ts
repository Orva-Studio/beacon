import { z } from "zod";
import {
  compose,
  defineFeature,
  IDENTITY,
  mediaTimeAt,
  RgbaSchema,
  rotate,
  scale,
  shutterTimes,
  ticksToSeconds,
  translate,
  type Ticks,
  type Affine,
  type Clip,
  type ClipEval,
  type EvalContext,
  type Track,
  type VisualLayer,
} from "@beacon/model";
import { loadCursorData } from "@beacon/media";
import { streamOf } from "../media";
import { shadowFromCamtasia, shadowParams } from "../drop-shadow";

/** Cursor data from a recording, read as `data(assetId, "cursor")`. */
export interface CursorData {
  path: string;
  /** Seconds, screen points. */
  t: Float64Array;
  x: Int32Array;
  y: Int32Array;
  /** A `.brec`'s images are PNG files; a `.trec`'s are read from it by index. */
  images: { index: number; width: number; height: number; hotX: number; hotY: number; scale: number; file?: string }[];
  changes: { t: number; index: number }[];
  /** Captured display bounds in points, when the recording has them. */
  display?: { x: number; y: number; w: number; h: number };
  buttons: { t: Float64Array; kind: Uint32Array };
}

const cursorGroup = z.strictObject({
  /** Size multiplier (`cursorScale` in `.cmproj`). */
  scale: z.number().nonnegative(),
  opacity: z.number().min(0).max(1),
  /** `cursorTrackLevel` in `.cmproj`; 0 = raw positions. */
  smoothing: z.number().nonnegative(),
  /** Seconds over which the cursor glides from the previous clip's position after a cut. */
  smoothAcrossEdits: z.number().nonnegative(),
  /** A held frame's frozen cursor: image index and position in points. */
  frozen: z.strictObject({ image: z.int().nonnegative(), x: z.number(), y: z.number() }).optional(),
});


const intensity = z.strictObject({ intensity: z.number().nonnegative() });

function interpolate(d: CursorData, t: number): [number, number] {
  const n = d.t.length;
  if (!n) return [0, 0];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d.t[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return [d.x[0]!, d.y[0]!];
  if (i >= n - 1) return [d.x[n - 1]!, d.y[n - 1]!];
  const k = (t - d.t[i]!) / (d.t[i + 1]! - d.t[i]!);
  return [d.x[i]! + (d.x[i + 1]! - d.x[i]!) * k, d.y[i]! + (d.y[i + 1]! - d.y[i]!) * k];
}

/** Seconds of Gaussian smoothing for a `cursorTrackLevel`; a placeholder. */
function smoothingSigma(level: number): number {
  return level <= 0 ? 0 : Math.min(0.6, 0.035 * Math.sqrt(level));
}

function cursorPosition(d: CursorData, t: number, level: number): [number, number] {
  const sigma = smoothingSigma(level);
  if (sigma === 0) return interpolate(d, t);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let k = -12; k <= 12; k++) {
    const dt = (k / 12) * 3 * sigma;
    const w = Math.exp(-(dt * dt) / (2 * sigma * sigma));
    const [x, y] = interpolate(d, t + dt);
    sx += x * w;
    sy += y * w;
    sw += w;
  }
  return [sx / sw, sy / sw];
}

function imageAt(d: CursorData, t: number): number {
  let index = d.changes[0]?.index ?? 0;
  for (const c of d.changes) {
    if (c.t > t) break;
    index = c.index;
  }
  return Math.max(0, d.images.findIndex((i) => i.index === index));
}

/** The clip on the same track starting where this one ends, from the same recording. */
function nextCut(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => c !== clip && c.assetId === clip.assetId && c.type === clip.type && c.start === clip.start + clip.duration);
}

interface CursorState {
  image: number;
  /** Screen points. */
  pos: [number, number];
}

/** Cursor at timeline time `time` within clip `e.clip`. */
function cursorAt(e: ClipEval, d: CursorData, time: Ticks): CursorState {
  const c = e.props.cursor!;
  const mediaSeconds = ticksToSeconds(e.clip.type === "still" ? (e.clip.mediaStart ?? 0) : mediaTimeAt(e.clip, time));
  if (c.frozen) return { image: Math.max(0, d.images.findIndex((i) => i.index === c.frozen.image)), pos: [c.frozen.x, c.frozen.y] };
  let pos = cursorPosition(d, mediaSeconds, c.smoothing);
  // Glides over the last `smoothAcrossEdits` seconds before a cut, arriving
  // where the cursor is when the next clip starts; linear, not smoothstep.
  const left = ticksToSeconds(e.clip.start + e.clip.duration - time);
  const next = c.smoothAcrossEdits > 0 && left < c.smoothAcrossEdits ? nextCut(e.track, e.clip) : undefined;
  if (next) {
    const to = cursorPosition(d, ticksToSeconds(next.mediaStart ?? 0), c.smoothing);
    const k = 1 - left / c.smoothAcrossEdits;
    pos = [pos[0] + (to[0] - pos[0]) * k, pos[1] + (to[1] - pos[1]) * k];
  }
  return { image: imageAt(d, mediaSeconds), pos };
}

/** Points → content pixels of the screen stream. */
function pointsToContent(d: CursorData, streamWidth: number): [ratio: number, ox: number, oy: number] {
  if (!d.display) return [2, 0, 0];
  return [streamWidth / d.display.w, d.display.x, d.display.y];
}

/**
 * No cursor is drawn while its hotspot is outside the clip's visible
 * (cropped) area.
 */
function insideCrop(e: ClipEval, d: CursorData, state: CursorState, streamWidth: number): boolean {
  const crop = e.props.crop;
  if (!crop || !e.main) return true;
  const [ratio, ox, oy] = pointsToContent(d, streamWidth);
  const x = (state.pos[0] - ox) * ratio;
  const y = (state.pos[1] - oy) * ratio;
  const [w, h] = e.main.size;
  return x >= crop.left && x <= w - crop.right && y >= crop.top && y <= h - crop.bottom;
}

function spriteTransform(d: CursorData, state: CursorState, size: number, streamWidth: number, extra: Affine): Affine {
  const img = d.images[state.image]!;
  const [ratio, ox, oy] = pointsToContent(d, streamWidth);
  const k = img.scale * ratio * size;
  return compose(
    translate((state.pos[0] - ox) * ratio, (state.pos[1] - oy) * ratio),
    compose(extra, compose(scale(k), translate(-img.hotX, -img.hotY))),
  );
}

function effect(clip: Clip, type: string) {
  return clip.effects.find((x) => x.type === type && x.enabled);
}

/** Seconds since the last left-button down, if the button is still down or was released within `window`. */
function clickPhase(d: CursorData, t: number): { down: number; up?: number } | undefined {
  let down: number | undefined;
  let up: number | undefined;
  for (let i = 0; i < d.buttons.t.length; i++) {
    const bt = d.buttons.t[i]!;
    if (bt > t) break;
    if (d.buttons.kind[i] === 1) {
      down = bt;
      up = undefined;
    } else if (d.buttons.kind[i] === 2) up = bt;
  }
  return down === undefined ? undefined : { down: t - down, up: up === undefined ? undefined : t - up };
}

/** Extra transform about the hotspot: physics tilt from horizontal speed, and click scaling. */
function cursorExtra(e: ClipEval, d: CursorData, mediaSeconds: number): Affine {
  let m: Affine = IDENTITY;
  const physics = effect(e.clip, "cursor-physics");
  if (physics) {
    const [x0] = cursorPosition(d, mediaSeconds - 0.05, e.props.cursor!.smoothing);
    const [x1] = cursorPosition(d, mediaSeconds, e.props.cursor!.smoothing);
    const vx = (x1 - x0) / 0.05;
    const tilt = Math.max(-1, Math.min(1, vx / 2000)) * ((physics.params.tilt as number) ?? 2.5) * 0.15;
    m = compose(m, rotate(-tilt));
  }
  const click = effect(e.clip, "click-scaling");
  if (click) {
    const phase = clickPhase(d, mediaSeconds);
    const target = (click.params.scale as number) / Math.max(e.props.cursor!.scale, 1e-6);
    const ramp = 1 / (click.params.speed as number);
    let k = 1;
    if (phase && phase.up === undefined) k = 1 + (target - 1) * Math.min(1, phase.down / ramp);
    else if (phase?.up !== undefined && phase.up < ramp) k = target + (1 - target) * (phase.up / ramp);
    m = compose(m, scale(k));
  }
  return m;
}

/**
 * Draws the recorded cursor over screen clips and held frames, in the
 * clip's content space (the transform feature maps it to the canvas), with
 * size, opacity, smoothing, glide across cuts, shadow, motion
 * blur, physics tilt and click scaling.
 */
export const cursor = defineFeature({
  id: "cursor",
  version: 1,
  analyzers: [
    {
      id: "cursor",
      description: "A recording's cursor track, clicks and cursor images",
      analyze: (asset) => (asset.kind === "recording" ? loadCursorData(asset.path) : undefined),
    },
  ],
  props: [
    {
      id: "cursor",
      description: "Recorded cursor: size, opacity and smoothing",
      traits: ["cursor"],
      schema: cursorGroup,
      defaults: () => ({ scale: 1, opacity: 1, smoothing: 1, smoothAcrossEdits: 0 }),
      animatable: ["scale", "opacity"],
    },
  ],
  effects: [
    {
      id: "cursor-shadow",
      title: "Cursor Shadow",
      description: "Shadow under the cursor",
      traits: ["cursor"],
      params: z.strictObject({ angle: z.number(), offset: z.number(), blur: z.number(), opacity: z.number(), color: RgbaSchema }),
      defaults: () => ({ angle: 3.92699, offset: 7, blur: 10, opacity: 0.5, color: [0, 0, 0, 1] }),
    },
    { id: "cursor-motion-blur", title: "Cursor Motion Blur", description: "Blurs the cursor along its motion", traits: ["cursor"], params: intensity, defaults: () => ({ intensity: 1 }) },
    {
      id: "cursor-physics",
      title: "Cursor Physics",
      description: "Tilts the cursor as it moves",
      traits: ["cursor"],
      params: z.strictObject({ intensity: z.number(), tilt: z.number() }),
      defaults: () => ({ intensity: 1.5, tilt: 2.5 }),
    },
    {
      id: "click-scaling",
      title: "Click Scaling",
      description: "Resizes the cursor while the left button is down",
      traits: ["cursor"],
      /** `scale`: cursor size during a click, like `cursor.scale` (assumed); `speed`: 1/seconds of the ramp. */
      params: z.strictObject({ scale: z.number().positive(), speed: z.number().positive() }),
      defaults: () => ({ scale: 3.5, speed: 7.5 }),
    },
  ],
  camtasia: {
    params(media, clip, ctx) {
      if (!["ScreenVMFile", "ScreenIMFile"].includes(media._type)) return;
      ctx.param(media, "cursorScale", "cursor.scale");
      ctx.param(media, "cursorOpacity", "cursor.opacity");
      ctx.param(media, "cursorTrackLevel", "cursor.smoothing");
      const across = ctx.value(media, "smoothCursorAcrossEditDuration");
      if (across !== undefined) (clip.props.cursor as any).smoothAcrossEdits = ticksToSeconds(Number(across));
      const image = ctx.value(media, "cursorImagePath");
      if (media._type === "ScreenIMFile" && typeof image === "string") {
        const keys: { time: number; value: number[] }[] = media.parameters?.cursorLocation?.keyframes ?? [];
        // Keyframe times are relative to the held frame; the one nearest 0 is the frame's own position.
        const at = keys.reduce<(typeof keys)[number] | undefined>((best, k) => (!best || Math.abs(k.time) < Math.abs(best.time) ? k : best), undefined);
        const base = ctx.value(media, "cursorLocation");
        const loc = at?.value ?? base ?? [0, 0];
        (clip.props.cursor as any).frozen = { image: Number(image.split("/").pop()), x: loc[0], y: loc[1] };
      }
    },
    effects: {
      CursorShadow: (fx, ctx) => ({ type: "cursor-shadow", params: { ...shadowFromCamtasia(fx, ctx) } }),
      CursorMotionBlur: (fx, ctx) => ({ type: "cursor-motion-blur", params: ctx.numbers(fx, { intensity: "intensity" }) }),
      CursorPhysics: (fx, ctx) => ({ type: "cursor-physics", params: ctx.numbers(fx, { intensity: "intensity", tilt: "tilt" }) }),
      LeftClickScaling: (fx, ctx) => ({ type: "click-scaling", params: ctx.numbers(fx, { scale: "scale", speed: "speed" }) }),
    },
  },
  evaluate: {
    clip(e, ctx) {
      const c = e.props.cursor;
      if (!c || !e.clip.assetId || c.opacity <= 0 || c.scale <= 0) return;
      const d = ctx.data<CursorData>(e.clip.assetId, "cursor");
      if (!d || !d.images.length) return;
      const streamWidth = streamOf(ctx.project.assets[e.clip.assetId]!, "video", e.props.media?.stream ?? 0).width!;
      const seconds = ticksToSeconds(e.clip.type === "still" ? (e.clip.mediaStart ?? 0) : e.mediaTime);
      const state = cursorAt(e, d, e.time);
      if (!insideCrop(e, d, state, streamWidth)) return;
      const img = d.images[state.image]!;
      const layer: VisualLayer = {
        kind: "visual",
        content: { type: "source", source: ctx.source(img.file ? { kind: "image", path: img.file } : { kind: "cursor", path: d.path, index: state.image }) },
        size: [img.width, img.height],
        transform: spriteTransform(d, state, c.scale, streamWidth, cursorExtra(e, d, seconds)),
        opacity: c.opacity,
        passes: [],
      };
      const blur = effect(e.clip, "cursor-motion-blur");
      if (blur && !e.sample && !c.frozen) layer.motion = motionSamples(e, ctx, d, streamWidth, state.image, blur.params.intensity as number);
      const shadow = effect(e.clip, "cursor-shadow");
      if (shadow) layer.passes!.push({ pass: "drop-shadow", params: shadowParams(shadow.params as any) });
      e.layers.push(layer);
    },
  },
});

/** Cursor transforms over the shutter interval before this frame. */
function motionSamples(e: ClipEval, ctx: EvalContext, d: CursorData, streamWidth: number, image: number, amount: number): Affine[] {
  const out: Affine[] = [];
  for (const time of shutterTimes(e.time, ctx.frameSeconds, amount)) {
    const { pos } = cursorAt(e, d, time);
    out.push(spriteTransform(d, { image, pos }, e.props.cursor!.scale, streamWidth, cursorExtra(e, d, ticksToSeconds(mediaTimeAt(e.clip, time)))));
  }
  return out;
}
