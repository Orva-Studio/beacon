import { stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import {
  SCHEMA_VERSION,
  type Animation,
  type Asset,
  type CamtasiaContext,
  type CamtasiaMapper,
  type CamtasiaObject,
  type Clip,
  type Easing,
  type FeatureRegistry,
  type Project,
  type Track,
  fpsRational,
} from "@beacon/model";
import { fileFingerprint, probeMedia } from "@beacon/media";

export interface ImportResult {
  project: Project;
  /** Everything not imported exactly: unclaimed types, effects and parameters. */
  report: string[];
}

const EASING: Record<string, Easing> = { linr: "linear", eioe: "easeInOut" };
function hex(rgba: number[] | undefined): string {
  const c = rgba ?? [0, 0, 0, 255];
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Camtasia times are numbers or exact fractions like `"27973120000/27"`. */
function ticks(v: unknown): number {
  if (typeof v === "string" && v.includes("/")) {
    const [n, d] = v.split("/").map(Number);
    return Math.round(n! / d!);
  }
  return Math.round(Number(v ?? 0));
}

/**
 * Camtasia's `scalar` is timeline time per media time (a number or
 * "num/den"); Beacon's speed is its inverse, media time per timeline time.
 */
function speedOf(scalar: unknown): Clip["speed"] {
  if (scalar === undefined || scalar === 1 || scalar === "1") return undefined;
  const [n, d] = String(scalar).split("/").map(Number);
  if (!n || (d !== undefined && !d)) return undefined;
  return d ? { num: d, den: n } : { num: 1000, den: Math.round(n * 1000) };
}

/**
 * Builds a Beacon project from a `.cmproj` (PLAN §11). The structure
 * (assets, tracks, times, keyframes) is read here; what each media type,
 * parameter and effect means comes from the features' Camtasia mappers.
 */
export async function importCmproj(cmproj: string, registry: FeatureRegistry): Promise<ImportResult> {
  const doc = JSON.parse(await Bun.file(join(cmproj, "project.tscproj")).text()) as CamtasiaObject;
  const report: string[] = [];
  const mappers = [...registry.features.values()].flatMap((f) => (f.camtasia ? [f.camtasia] : []));

  const assets: Record<string, Asset> = {};
  const bySrc = new Map<number, Asset>();
  const sources = new Map<number, CamtasiaObject>();
  for (const s of doc.sourceBin ?? []) {
    sources.set(s.id, s);
    const path = isAbsolute(s.src) ? s.src : resolve(cmproj, s.src);
    const info = await stat(path).catch(() => undefined);
    if (!info) {
      report.push(`source ${s.id}: missing file ${path}`);
      continue;
    }
    let media;
    try {
      media = await probeMedia(path);
    } catch (e) {
      report.push(`source ${s.id}: cannot read ${path} (${e instanceof Error ? e.message.split(": ").pop() : e}); its clips are skipped`);
      continue;
    }
    // Camtasia sources the features don't import (rare formats) are still decoded as video.
    const kind = registry.importerFor(extname(path))?.kind ?? "video";
    const asset: Asset = { id: `src-${s.id}`, kind, path, fingerprint: fileFingerprint(path), derived: { media } };
    // Camtasia's own loudness measurements, by audio stream.
    const lufs = (s.sourceTracks ?? []).filter((t: CamtasiaObject) => t.type === 2).map((t: CamtasiaObject) => t.integratedLUFS);
    if (lufs.some((v: unknown) => typeof v === "number")) asset.derived.loudness = Object.fromEntries(lufs.flatMap((v: unknown, i: number) => (typeof v === "number" ? [[i, v]] : [])));
    assets[asset.id] = asset;
    bySrc.set(s.id, asset);
  }

  const scenes = doc.timeline?.sceneTrack?.scenes ?? [];
  if (scenes.length > 1) report.push(`${scenes.length} scenes; only the first is imported`);
  const csmlTracks: CamtasiaObject[] = scenes[0]?.csml?.tracks ?? [];
  const attrs: CamtasiaObject[] = doc.timeline?.trackAttributes ?? [];

  let nextTrack = 0;
  const env: ImportEnv = { registry, mappers, bySrc, sources, report, importTracks: (list) => importTracks(list) };
  // A combined recording clip (UnifiedMedia) becomes its video clip plus a
  // linked audio clip, on a track of its own just below the video's.
  const importTracks = (list: CamtasiaObject[], attributes: CamtasiaObject[] = []): Track[] =>
    list.flatMap((t, i) => {
      const a = attributes[i] ?? {};
      // Camtasia's unnamed tracks stay unnamed ("Track N" by position, as Camtasia shows them).
      const track: Track = { id: `t${nextTrack++}`, name: a.ident || "", clips: [] };
      if (a.videoHidden) track.hidden = true;
      if (a.audioMuted) track.muted = true;
      const linkedAudio: Clip[] = [];
      for (const media of t.medias ?? []) {
        if (media._type === "UnifiedMedia") {
          const timing = { start: media.start, duration: media.duration, mediaStart: media.mediaStart, scalar: media.scalar };
          const video = media.video && importMedia({ ...media.video, ...timing }, env);
          const audio = media.audio && importMedia({ ...media.audio, ...timing }, env);
          if (video && audio) video.linkId = audio.linkId = `link-${media.id}`;
          if (video) track.clips.push(video);
          if (audio) linkedAudio.push(audio);
          continue;
        }
        const clip = importMedia(media, env);
        if (clip) track.clips.push(clip);
      }
      if (!linkedAudio.length) return [track];
      const audio: Track = { id: `t${nextTrack++}`, name: track.name && `${track.name} audio`, clips: linkedAudio };
      if (track.muted) audio.muted = true;
      return [audio, track];
    });
  const tracks = importTracks(csmlTracks, attrs);

  const fps = Number(doc.videoFormatFrameRate ?? 30);
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    features: Object.fromEntries([...registry.features.values()].map((f) => [f.id, f.version])),
    settings: {
      width: Math.round(doc.width ?? 1920),
      height: Math.round(doc.height ?? 1080),
      fps: fpsRational(fps),
      sampleRate: Number(doc.audioFormatSampleRate ?? 48000),
      background: hex(doc.timeline?.backgroundColor),
      ...(doc.shouldApplyLoudnessNormalization && typeof doc.targetLoudness === "number" ? { loudnessTarget: doc.targetLoudness } : {}),
    },
    assets,
    tracks,
    markers: [],
  };
  registry.validate(project);
  return { project, report };
}

interface ImportEnv {
  registry: FeatureRegistry;
  mappers: CamtasiaMapper[];
  bySrc: Map<number, Asset>;
  sources: Map<number, CamtasiaObject>;
  report: string[];
  importTracks: (list: CamtasiaObject[]) => Track[];
}

function importMedia(media: CamtasiaObject, { registry, mappers, bySrc, sources, report, importTracks }: ImportEnv): Clip | undefined {
  const where = `${media._type} ${media.id} (${media.attributes?.ident ?? ""})`;
  const read = new Set<string>();
  const blocks = new Map<string, Animation>();
  let clip: Clip | undefined;

  const ctx: CamtasiaContext = {
    value(obj, name) {
      if (obj === media) read.add(name);
      const v = obj.parameters?.[name];
      return v !== null && typeof v === "object" && !Array.isArray(v) ? v.defaultValue : v;
    },
    param(obj, name, target, map = (v) => v) {
      const raw = obj.parameters?.[name];
      read.add(name);
      if (raw === undefined || !clip) return;
      const [groupId, field] = target.split(".") as [string, string];
      const group = registry.groupsFor(clip.type).find((g) => g.id === groupId);
      if (!group) return;
      const values = (clip.props[groupId] ??= group.defaults()) as Record<string, unknown>;
      const base = ctx.value(obj, name);
      if (base !== undefined) values[field] = map(base);
      const keys: CamtasiaObject[] = (typeof raw === "object" && raw?.keyframes) || [];
      if (!keys.length) return;
      if (!group.animatable?.includes(field)) {
        report.push(`${where}: ${name} is keyframed but ${target} is not animatable; using its base value`);
        return;
      }
      for (const k of keys) {
        const end = ticks(k.endTime);
        const duration = ticks(k.duration);
        const id = `${end}:${duration}`;
        let block = blocks.get(id);
        if (!block) {
          const visual = (media.animationTracks?.visual ?? []).find((b: CamtasiaObject) => ticks(b.endTime) === end);
          const interp = visual?.interp ?? k.interp ?? raw.interp ?? "eioe";
          if (!EASING[interp]) report.push(`${where}: easing "${interp}" imported as easeInOut`);
          block = { id: `a${blocks.size}`, end, duration, easing: EASING[interp] ?? "easeInOut", to: {} };
          blocks.set(id, block);
        }
        block.to[target] = map(k.value);
      }
    },
    points(obj, name, target) {
      const raw = obj.parameters?.[name];
      if (obj === media) read.add(name);
      if (raw === undefined || !clip) return;
      const [groupId, field] = target.split(".") as [string, string];
      const group = registry.groupsFor(clip.type).find((g) => g.id === groupId);
      if (!group) return;
      const values = (clip.props[groupId] ??= group.defaults()) as Record<string, unknown>;
      const keys: CamtasiaObject[] = (typeof raw === "object" && raw?.keyframes) || [];
      if (!keys.length) {
        const base = ctx.value(obj, name);
        if (base !== undefined) values[field] = Number(base);
        return;
      }
      if (!group.animatable?.includes(field)) {
        report.push(`${where}: ${name} has points but ${target} is not animatable; using the first`);
      }
      if (keys.some((k) => ticks(k.duration) !== 0)) report.push(`${where}: ${name} has points with a duration; imported as instantaneous`);
      const points = keys.map((k) => ({ t: ticks(k.time), v: Number(k.value) })).sort((a, b) => a.t - b.t);
      values[field] = points[0]!.v;
      if (!group.animatable?.includes(field)) return;
      for (const [i, p] of points.entries()) {
        if (i === 0) continue;
        const prev = points[i - 1]!;
        blocks.set(`${target}#${i}`, { id: `a${blocks.size}`, end: p.t, duration: p.t - prev.t, easing: "linear", to: { [target]: p.v } });
      }
    },
    asset(src) {
      const a = bySrc.get(src);
      if (!a) throw new Error(`${where}: unknown source ${src}`);
      return a;
    },
    source(src) {
      const s = sources.get(src);
      if (!s) throw new Error(`${where}: unknown source ${src}`);
      return s;
    },
    report(message) {
      report.push(`${where}: ${message}`);
    },
    tracks: (list) => importTracks(list),
  };

  let mapped: { type: string; props?: Clip["props"] } | null = null;
  try {
    for (const claim of mappers.map((m) => m.clipTypes?.[media._type])) {
      mapped = claim?.(media, ctx) ?? null;
      if (mapped) break;
    }
  } catch (e) {
    report.push(`${where}: ${e instanceof Error ? e.message : e}; skipped`);
    return undefined;
  }
  if (!mapped) {
    const kind = media.def?.kind ? ` (${media.def.kind})` : "";
    report.push(`${where}: no feature imports this media type${kind}; skipped`);
    return undefined;
  }

  clip = {
    id: `c${media.id}`,
    type: mapped.type,
    start: ticks(media.start),
    duration: ticks(media.duration),
    props: { ...mapped.props },
    effects: [],
    animations: [],
  };
  if (media.mediaStart !== undefined) clip.mediaStart = ticks(media.mediaStart);
  const speed = speedOf(media.scalar);
  if (speed) clip.speed = speed;
  if (media.src !== undefined) {
    const asset = bySrc.get(media.src);
    if (!asset) {
      report.push(`${where}: source ${media.src} was not imported; skipped`);
      return undefined;
    }
    clip.assetId = asset.id;
  }

  for (const m of mappers) m.params?.(media, clip, ctx);

  for (const [i, fx] of (media.effects ?? []).entries()) {
    const name = fx.effectName as string;
    const map = mappers.map((m) => m.effects?.[name]).find(Boolean);
    if (!map) {
      report.push(`${where}: effect "${name}" is not supported; skipped`);
      continue;
    }
    const e = map(fx, ctx);
    if (!e) continue;
    const enabled = !fx.bypassed && Number(ctx.value(fx, "enabled") ?? 1) !== 0;
    clip.effects.push({ id: `${clip.id}-fx${i}`, type: e.type, enabled, params: e.params });
  }

  clip.animations = [...blocks.values()].sort((a, b) => a.end - b.end);
  for (const name of Object.keys(media.parameters ?? {})) {
    if (!read.has(name)) report.push(`${where}: parameter "${name}" not imported`);
  }
  return clip;
}

/** An import's report for people: the per-clip prefix and values dropped, the same message counted once. */
export function summarizeReport(lines: string[]): { message: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const message = line.replace(/^\w+ \d+ \([^)]*\): /, "").replace(/ = \S+/, "");
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return [...counts].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}
