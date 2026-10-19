import type { AudioContext, AudioSegment, ClipEval, EffectDef, EvalContext, EvaluateHook } from "./feature";
import type { Track } from "./schema";
import type { FeatureRegistry } from "./registry";
import { IDENTITY, type Layer, type RGBA, type Scene, type SourceDef, type VisualLayer } from "./scene";
import type { Animation, Clip, Easing, Project } from "./schema";
import { rationalToNumber, secondsToTicks, ticksPerFrame, ticksToSeconds, type Ticks } from "./ticks";

/**
 * The two easings: linear, and a cubic ease in/out.
 */
export function ease(easing: Easing, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  if (easing === "linear") return t;
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function lerp(a: unknown, b: unknown, k: number): unknown {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => lerp(v, b[i], k));
  return k < 1 ? a : b;
}

/**
 * A property holds its base value until a block starts,
 * moves to the block's `to` value over its duration, and holds there until
 * the next block that targets it. Block times are media time.
 */
export function animatedValue(base: unknown, target: string, animations: Animation[], mediaTime: Ticks): unknown {
  let value = base;
  const blocks = animations.filter((a) => target in a.to).sort((a, b) => a.end - b.end);
  for (const block of blocks) {
    const to = block.to[target];
    if (mediaTime >= block.end) {
      value = to;
      continue;
    }
    const start = block.end - block.duration;
    if (mediaTime > start) value = lerp(value, to, ease(block.easing, (mediaTime - start) / block.duration));
    break;
  }
  return value;
}

/** The blocks targeting `target` as ramps in media seconds, in the order `animatedValue` applies them. */
export function animationRamps(animations: Animation[], target: string): AudioSegment["gain"]["ramps"] {
  return animations
    .filter((a) => target in a.to)
    .sort((a, b) => a.end - b.end)
    .map((a) => ({ start: ticksToSeconds(a.end - a.duration), end: ticksToSeconds(a.end), to: a.to[target] as number, easing: a.easing }));
}

/** Media time per timeline time. */
export function clipSpeed(clip: Clip): number {
  return clip.speed ? rationalToNumber(clip.speed) : 1;
}

/** Media position of a clip at timeline time `t`. */
export function mediaTimeAt(clip: Clip, t: Ticks): Ticks {
  return (clip.mediaStart ?? 0) + Math.round((t - clip.start) * clipSpeed(clip));
}

/** When on the timeline (ticks, not rounded) `clip` shows its media's time `media`: `mediaTimeAt` the other way. */
export function timelineTimeAt(clip: Clip, media: Ticks): number {
  return clip.start + (media - (clip.mediaStart ?? 0)) / clipSpeed(clip);
}

/** The stretch of its media a clip shows, in ticks: from its in point for its duration at its speed. */
export function mediaWindow(clip: Clip): [Ticks, Ticks] {
  const from = clip.mediaStart ?? 0;
  return [from, from + clip.duration * clipSpeed(clip)];
}

/** Timed words (seconds in the clip's media, as a transcript's) the clip shows: those whose middle is in its window. */
export function wordsInWindow<W extends { start: number; end: number }>(clip: Clip, words: W[]): W[] {
  const [from, to] = mediaWindow(clip).map(ticksToSeconds) as [number, number];
  return words.filter((w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to);
}

export function resolveProps(registry: FeatureRegistry, clip: Clip, mediaTime: Ticks): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const group of registry.groupsFor(clip.type)) {
    const values: Record<string, any> = { ...group.defaults(), ...(clip.props[group.id] as object | undefined) };
    for (const field of group.animatable ?? []) {
      values[field] = animatedValue(values[field], `${group.id}.${field}`, clip.animations, mediaTime);
    }
    out[group.id] = values;
  }
  return out;
}

export interface EvaluateEnv {
  data?: <T>(assetId: string, key: string) => T | undefined;
  /** Receives every source the scene draws, keyed by the id used in the scene. */
  sources?: Map<string, SourceDef>;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

function sourceId(def: SourceDef): string {
  switch (def.kind) {
    case "video":
      return `${def.path}#v${def.stream}`;
    case "cursor":
      return `${def.path}#cursor${def.index}`;
    case "text":
    case "strokes":
      return `${def.kind}:${fnv1a(JSON.stringify(def))}`;
    default:
      return def.path;
  }
}

/** An effect's `apply` as a clip hook: for clips with it enabled and visual content. */
function effectHook(def: EffectDef): NonNullable<EvaluateHook["clip"]>[] {
  const apply = def.apply;
  if (!apply) return [];
  return [
    (e, ctx) => {
      if (e.main?.kind !== "visual") return;
      const fx = e.clip.effects.find((x) => x.type === def.id && x.enabled);
      if (fx) apply(e as ClipEval & { main: VisualLayer }, fx.params, ctx);
    },
  ];
}

/**
 * The timeline at time `t` as a flat Scene (PLAN §8). Pure: every feature
 * contributes through its `evaluate` hook; core knows no clip types.
 */
export function evaluate(project: Project, registry: FeatureRegistry, t: Ticks, env: EvaluateEnv = {}): Scene {
  const hooks = [...registry.features.values()].flatMap((f) => [...(f.effects ?? []).flatMap(effectHook), ...(f.evaluate?.clip ? [f.evaluate.clip] : [])]);
  const sources = env.sources ?? new Map<string, SourceDef>();
  const frameSeconds = ticksToSeconds(ticksPerFrame(project.settings.fps));
  const contextFor = (canvas: { width: number; height: number }): EvalContext => {
    const ctx: EvalContext = {
      project,
      registry,
      canvas,
      data: env.data ?? (() => undefined),
      source(def) {
        const id = sourceId(def);
        sources.set(id, def);
        return id;
      },
      evalClip(clip, track, time, opts) {
        const mediaTime = mediaTimeAt(clip, time);
        const props = resolveProps(registry, clip, mediaTime);
        // Effects that span part of the clip apply only there: hooks see the ones in effect now.
        const live = clip.effects.some((fx) => fx.span) ? { ...clip, effects: clip.effects.filter((fx) => !fx.span || (mediaTime >= fx.span.start && mediaTime < fx.span.end)) } : clip;
        const e: ClipEval = { clip: live, track, time, mediaTime, props, layers: [], sample: opts?.sample ?? false };
        for (const hook of hooks) hook(e, ctx);
        return e;
      },
      evalTracks(tracks, time, inner, opts) {
        const c = inner ? contextFor(inner) : ctx;
        const layers: Layer[] = [];
        for (const track of tracks) {
          if (track.hidden) continue;
          for (const clip of track.clips) {
            if (time >= clip.start && time < clip.start + clip.duration) layers.push(...c.evalClip(clip, track, time, opts).layers);
          }
        }
        return layers;
      },
      frameSeconds,
    };
    return ctx;
  };
  const ctx = contextFor({ width: project.settings.width, height: project.settings.height });
  return { background: parseColor(project.settings.background), layers: ctx.evalTracks(project.tracks, t) };
}

/** The timeline's audio mix: every segment the clips on unmuted tracks contribute through their `audio` hooks. */
export function evaluateAudio(project: Project, registry: FeatureRegistry): AudioSegment[] {
  const hooks = [...registry.features.values()].flatMap((f) => (f.evaluate?.audio ? [f.evaluate.audio] : []));
  const ctx: AudioContext = {
    project,
    registry,
    tracks: (tracks) => tracks.filter((t) => !t.muted).flatMap((t) => t.clips.flatMap((c) => hooks.flatMap((h) => h(c, ctx)))),
  };
  return ctx.tracks(project.tracks);
}

/** `#rrggbb`, with `aa` after it when not opaque: what `parseColor` reads. */
export function formatColor(c: readonly number[]): string {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  const alpha = byte(c[3] ?? 1);
  return `#${c.slice(0, 3).map(byte).join("")}${alpha === "ff" ? "" : alpha}`;
}

/** `#rrggbb` or `#rrggbbaa`. */
export function parseColor(hex: string): RGBA {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`bad colour "${hex}"`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}

/** Frames of shutter at motion blur intensity 1 (the clip's and the cursor's). */
export const SHUTTER = 0.75;

/** The times motion blur samples before `time`, newest first: 15 across the shutter at `intensity`. */
export function shutterTimes(time: Ticks, frameSeconds: number, intensity: number): Ticks[] {
  const shutter = frameSeconds * Math.min(1, SHUTTER * intensity);
  const n = 16;
  return Array.from({ length: n - 1 }, (_, i) => time - secondsToTicks((shutter * (i + 1)) / n));
}

/** The audio of nested tracks heard through a clip's window (groups, stitched media). */
export function nestedAudio(clip: Clip, tracks: Track[] | undefined, ctx: AudioContext): AudioSegment[] {
  if (!tracks) return [];
  const speed = clipSpeed(clip);
  const [inStart, inEnd] = mediaWindow(clip).map(ticksToSeconds) as [number, number];
  const start = ticksToSeconds(clip.start);
  return ctx.tracks(tracks).flatMap((s) => {
    const from = Math.max(s.start, inStart);
    const to = Math.min(s.start + s.duration, inEnd);
    if (to <= from) return [];
    return [{ ...s, start: start + (from - inStart) / speed, duration: (to - from) / speed, mediaStart: s.mediaStart + (from - s.start) * s.speed, speed: s.speed * speed }];
  });
}

/** Draws nested tracks on their own canvas as the clip's content, so its transform and effects apply to them as one. */
export function drawNested(e: ClipEval, g: { width: number; height: number; tracks: Track[] }, ctx: EvalContext) {
  const layers = ctx.evalTracks(g.tracks, e.mediaTime, { width: g.width, height: g.height }, { sample: e.sample });
  const main: VisualLayer = { kind: "visual", content: { type: "group", background: [0, 0, 0, 0], layers }, size: [g.width, g.height], transform: IDENTITY };
  e.layers.push(main);
  e.main = main;
}
