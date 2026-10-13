import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import {
  animationRamps,
  defineFeature,
  IDENTITY,
  clipSpeed,
  ticksToSeconds,
  type Asset,
  type AudioSegment,
  type CamtasiaObject,
  secondsToTicks,
  type Clip,
  type ClipEval,
  type ImportClipSpec,
  type Project,
  type VisualLayer,
} from "@beacon/model";
import { basename, join } from "node:path";
import { makeAudioProxy, makeProxies, streamSource, waveformPeaks, type MediaInfo, type Proxy, type StreamInfo } from "@beacon/media";

/** `waveform` job data: peak level per 10 ms, 0–255, by audio stream index. */
export interface WaveformData {
  streams: Record<number, number[]>;
}

/** `proxy` job data: a seek-friendly copy of each video stream and a quick-to-open copy of each audio stream, by stream index. */
export interface ProxyData {
  streams: Record<number, Proxy>;
  audio?: Record<number, string>;
}

/** `Asset.derived.loudness`: integrated loudness (LUFS) of each audio stream, by audio stream index. */
export type Loudness = Record<number, number>;

/** `Asset.derived.media` is written when the asset is imported. */
export function mediaInfo(asset: Asset): MediaInfo {
  const info = asset.derived.media as MediaInfo | undefined;
  if (!info) throw new Error(`asset ${asset.id} has no media info; import it through @beacon/media`);
  return info;
}

interface AudioProps {
  gain: number;
  volume: number;
  normalize: boolean;
}

/** Where to read an asset's `n`th stream of a kind: a `.brec` keeps each stream in its own file. */
export function sourceOf(asset: Asset, kind: "video" | "audio", n: number): { path: string; stream: number } {
  return streamSource(asset.path, mediaInfo(asset), kind, n);
}

/** An audio clip's segment of the mix: its volume envelope, scaled by its gain and the levelling to the project's target. */
function audioSegment(project: Project, clip: Clip, asset: Asset, stream: number): AudioSegment {
  const a: AudioProps = { gain: 1, volume: 1, normalize: false, ...(clip.props.audio as Partial<AudioProps> | undefined) };
  const target = project.settings.loudnessTarget;
  const measured = (asset.derived.loudness as Loudness | undefined)?.[stream];
  const k = a.gain * (a.normalize && target !== undefined && measured !== undefined ? 10 ** ((target - measured) / 20) : 1);
  return {
    ...sourceOf(asset, "audio", stream),
    start: ticksToSeconds(clip.start),
    duration: ticksToSeconds(clip.duration),
    mediaStart: ticksToSeconds(clip.mediaStart ?? 0),
    speed: clipSpeed(clip),
    gain: { base: a.volume * k, ramps: animationRamps(clip.animations, "audio.volume").map((r) => ({ ...r, to: r.to * k })) },
  };
}

/** The `n`th stream of a kind, as ffmpeg's `v:n` / `a:n` selectors count them. */
export function streamOf(asset: Asset, kind: "video" | "audio", n: number): StreamInfo {
  const s = mediaInfo(asset).streams.filter((x) => x.kind === kind)[n];
  if (!s) throw new Error(`asset ${asset.id} has no ${kind} stream ${n}`);
  return s;
}

function videoStreams(asset: Asset) {
  return mediaInfo(asset).streams.filter((s) => s.kind === "video");
}

/** The `.trec` screen codec, as ffmpeg names it. */
export function isScreenCodec(codec: string): boolean {
  return codec === "tsc2" || codec === "tscc2";
}

/** A recording's screen: a `.trec`'s by its codec, a `.brec`'s by its role. */
function isScreen(s: StreamInfo): boolean {
  return s.role === "screen" || isScreenCodec(s.codec);
}

/** Index of the stream a media clip uses among its asset's streams of that kind. */
export function clipStream(clip: Clip): number {
  return (clip.props.media as { stream?: number } | undefined)?.stream ?? 0;
}

/** Pixel size of what a visual clip shows: a group's canvas or its video stream; undefined for audio or missing info. */
export function visualSize(project: Project, clip: Clip): [number, number] | undefined {
  const group = clip.props.group as { width: number; height: number } | undefined;
  if (group) return [group.width, group.height];
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
  if (!asset?.derived.media || clip.type === "audio") return undefined;
  const s = mediaInfo(asset).streams.filter((x) => x.kind === "video")[clipStream(clip)];
  return s?.width && s.height ? [s.width, s.height] : undefined;
}

/** A recording's screen stream: the `tsc2` codec. */
function screenStream(asset: Asset): number {
  return Math.max(0, videoStreams(asset).findIndex((s) => isScreenCodec(s.codec)));
}

/** A `.cmproj` `trackNumber` counts all of a source's tracks; ffmpeg's `a:n` counts audio streams (`type` 2) only. */
function audioStream(source: CamtasiaObject, trackNumber: number): number {
  const tracks: CamtasiaObject[] = source.sourceTracks ?? [];
  if (tracks[trackNumber]?.type !== 2) throw new Error(`track ${trackNumber} of source ${source.id} is not audio`);
  return tracks.slice(0, trackNumber).filter((t) => t.type === 2).length;
}

/** The first non-screen video stream (a recording's camera, or a plain video). */
function cameraStream(asset: Asset): number {
  return Math.max(0, videoStreams(asset).findIndex((s) => !isScreenCodec(s.codec)));
}

/** Media dropped on the canvas: scaled to fit, centred. */
function fitted(project: Project, width: number, height: number): Clip["props"]["transform"] {
  const k = Math.min(project.settings.width / width, project.settings.height / height);
  return { x: 0, y: 0, scaleX: k, scaleY: k, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 };
}

const AUDIO_TRACKS: Partial<Record<NonNullable<StreamInfo["role"]>, string>> = { microphone: "Microphone", systemAudio: "System Audio" };

/** Separate linked clips per stream, as you nearly always use recordings. */
function importClips(asset: Asset, project: Project): ImportClipSpec[] {
  const info = mediaInfo(asset);
  const duration = secondsToTicks(info.duration);
  const specs: ImportClipSpec[] = [];
  const video = videoStreams(asset);
  if (asset.kind === "image") {
    const s = video[0]!;
    return [{ track: "Image", type: "image", duration: secondsToTicks(5), props: { media: { stream: 0 }, transform: fitted(project, s.width!, s.height!) } }];
  }
  // A recording's audio is linked to its camera (or, with no camera, its screen); the screen and camera are placed and cut apart.
  const camera = video.some((s) => !isScreen(s));
  // A `.brec`'s files start at slightly different moments of the take (and a measured device delay moves a
  // stream too): each clip starts that far into its file from the latest start, so all show the same moment.
  const latest = Math.max(0, ...info.streams.map((s) => s.start ?? 0));
  const into = (s: StreamInfo) => secondsToTicks(latest - (s.start ?? 0));
  for (const [i, s] of video.entries()) {
    const screen = isScreen(s);
    specs.push({
      track: screen ? "Screen" : asset.kind === "recording" ? "Camera" : "Video",
      type: screen ? "screen" : "video",
      duration: secondsToTicks(s.duration || info.duration) - into(s),
      mediaStart: into(s),
      props: { media: { stream: i }, transform: fitted(project, s.width!, s.height!) },
      link: screen && camera ? undefined : "picture",
    });
  }
  const audio = info.streams.filter((s) => s.kind === "audio");
  for (const [i, s] of audio.entries()) {
    const track = (s.role && AUDIO_TRACKS[s.role]) ?? (audio.length > 1 ? `Audio ${i + 1}` : "Audio");
    specs.push({ track, type: "audio", duration: secondsToTicks(s.duration || info.duration) - into(s), mediaStart: into(s), props: { media: { stream: i }, audio: { gain: 1, volume: 1, normalize: true } }, link: "picture" });
  }
  // Streams of one recording differ by a few ms; linked clips share the shortest length.
  const shortest = Math.min(duration - secondsToTicks(latest), ...specs.map((x) => x.duration));
  return specs.map((x) => ({ ...x, duration: shortest }));
}

const mediaGroup = z.strictObject({
  /** Index among the asset's video streams (visual clips) or audio streams (audio clips). */
  stream: z.int().nonnegative(),
});

function visual(e: ClipEval, layer: Omit<VisualLayer, "kind" | "transform">) {
  const main: VisualLayer = { kind: "visual", transform: IDENTITY, ...layer };
  e.layers.push(main);
  e.main = main;
}

function proxyOf(data: ProxyData | undefined, stream: number): { proxy?: Proxy } {
  const proxy = data?.streams[stream];
  return proxy ? { proxy } : {};
}

/**
 * Clips that show or play an asset: screen recordings (with cursor data),
 * camera and other video, images, held frames, and audio.
 */
export const media = defineFeature({
  id: "media",
  version: 1,
  clipTypes: [
    { id: "screen", description: "Screen recording stream of a .trec, drawn with its cursor", traits: ["visual", "media", "video", "cursor"] },
    { id: "video", description: "A video stream (camera, mp4, mov)", traits: ["visual", "media", "video"] },
    { id: "image", description: "A still image file", traits: ["visual", "media"] },
    {
      id: "still",
      description: "One frame of a video held for the clip's duration (an extended frame); mediaStart picks the frame",
      traits: ["visual", "media", "cursor", "hold"],
    },
    { id: "audio", description: "An audio stream", traits: ["audio", "media"] },
  ],
  jobAnalyzers: [
    {
      id: "proxy",
      description:
        "Copies of media with video for scrubbing and playback in the app: video as short-GOP HEVC (half size above 1920 wide), their audio streams copied out of the container",
      version: 3,
      when: "preview",
      folder: "proxies",
      // Audio files are read as they are: a copy would open no faster.
      applies: (asset) => asset.kind !== "image" && !!asset.derived.media && mediaInfo(asset).streams.some((s) => s.kind === "video"),
      async analyze(asset, progress, { cacheDir, quiet }) {
        const video = mediaInfo(asset).streams.filter((s) => s.kind === "video" && asset.kind !== "image");
        const sound = mediaInfo(asset).streams.filter((s) => s.kind === "audio");
        const key = new Bun.CryptoHasher("sha256").update(`${asset.path}\0${asset.fingerprint}`).digest("hex").slice(0, 16);
        const audio: NonNullable<ProxyData["audio"]> = {};
        for (const i of sound.keys()) {
          const src = sourceOf(asset, "audio", i);
          audio[i] = await makeAudioProxy(src.path, src.stream, join(cacheDir, "proxies", `${key}-a${i}.mka`));
        }
        // Version 2's H.264 copies, left behind by the version bump.
        for (const i of video.keys()) rmSync(join(cacheDir, "proxies", `${key}-v${i}.mp4`), { force: true });
        // One ffmpeg run per file: a `.trec`'s streams together, a `.brec`'s each from its own file.
        const byFile = new Map<string, { i: number; stream: number }[]>();
        for (const i of video.keys()) {
          const src = sourceOf(asset, "video", i);
          byFile.set(src.path, [...(byFile.get(src.path) ?? []), { i, stream: src.stream }]);
        }
        const streams: ProxyData["streams"] = {};
        let done = 0;
        for (const [path, items] of byFile) {
          const built = await makeProxies(
            path,
            items.map(({ i, stream }) => ({ stream, codec: video[i]!.codec, width: video[i]!.width ?? 0, height: video[i]!.height ?? 0, out: join(cacheDir, "proxies", `${key}-v${i}.hevc.mp4`) })),
            byFile.size > 1 ? video[items[0]!.i]!.duration : mediaInfo(asset).duration,
            { quiet, onProgress: (f) => progress((done + f * items.length) / video.length) },
          );
          for (const [k, { i }] of items.entries()) streams[i] = built[k]!;
          done += items.length;
        }
        return { streams, audio } satisfies ProxyData;
      },
      discard(result) {
        const data = result as ProxyData;
        for (const s of Object.values(data.streams ?? {})) rmSync(s.path, { force: true });
        for (const a of Object.values(data.audio ?? {})) rmSync(a, { force: true });
      },
      revive(result, { cacheDir }) {
        const data = result as ProxyData;
        const find = (path: string) => {
          if (existsSync(path)) return path;
          const moved = join(cacheDir, "proxies", basename(path));
          return existsSync(moved) ? moved : undefined;
        };
        const streams: ProxyData["streams"] = {};
        for (const [i, s] of Object.entries(data.streams ?? {})) {
          const path = find(s.path);
          if (!path) return undefined;
          streams[Number(i)] = { ...s, path };
        }
        const audio: NonNullable<ProxyData["audio"]> = {};
        for (const [i, a] of Object.entries(data.audio ?? {})) {
          const path = find(a);
          if (!path) return undefined;
          audio[Number(i)] = path;
        }
        const moved = Object.entries(streams).some(([i, s]) => s.path !== data.streams[Number(i)]!.path) || Object.entries(audio).some(([i, a]) => a !== data.audio![Number(i)]);
        return moved ? ({ streams, audio } satisfies ProxyData) : result;
      },
    },
    {
      id: "waveform",
      description: "Peak level per 10 ms of each audio stream (0-255), for timeline waveforms",
      version: 1,
      when: "preview",
      applies: (asset) => !!asset.derived.media && mediaInfo(asset).streams.some((s) => s.kind === "audio"),
      async analyze(asset) {
        const sound = mediaInfo(asset).streams.filter((s) => s.kind === "audio");
        const streams: WaveformData["streams"] = {};
        for (const i of sound.keys()) {
          const src = sourceOf(asset, "audio", i);
          streams[i] = await waveformPeaks(src.path, src.stream);
        }
        return { streams } satisfies WaveformData;
      },
    },
  ],
  importers: [
    { id: "recording", extensions: [".trec", ".brec"], kind: "recording", clips: importClips },
    { id: "video", extensions: [".mp4", ".mov", ".m4v"], kind: "video", clips: importClips },
    { id: "image", extensions: [".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tif", ".tiff", ".bmp"], kind: "image", clips: importClips },
    { id: "audio", extensions: [".mp3", ".m4a", ".wav", ".aac", ".aif", ".aiff", ".flac"], kind: "audio", clips: importClips },
  ],
  props: [
    { id: "media", description: "Which stream of the asset the clip uses", traits: ["media"], schema: mediaGroup, defaults: () => ({ stream: 0 }), identity: true },
    {
      id: "audio",
      description: "Linear gain, a volume envelope (fades, ducking) on top of it, and whether the clip is levelled to the project's loudness target",
      traits: ["audio"],
      schema: z.strictObject({ gain: z.number().nonnegative(), volume: z.number().nonnegative(), normalize: z.boolean() }),
      defaults: () => ({ gain: 1, volume: 1, normalize: false }),
      animatable: ["volume"],
    },
  ],
  camtasia: {
    clipTypes: {
      ScreenVMFile: (m, ctx) => ({ type: "screen", props: { media: { stream: screenStream(ctx.asset(m.src)) } } }),
      ScreenIMFile: (m, ctx) => ({ type: "still", props: { media: { stream: screenStream(ctx.asset(m.src)) } } }),
      VMFile: (m, ctx) => ({ type: "video", props: { media: { stream: cameraStream(ctx.asset(m.src)) } } }),
      IMFile: () => ({ type: "image", props: { media: { stream: 0 } } }),
      AMFile: (m, ctx) => ({ type: "audio", props: { media: { stream: audioStream(ctx.source(m.src), Number(m.trackNumber ?? 0)) } } }),
    },
    params(media, clip, ctx) {
      if (clip.type !== "audio") return;
      clip.props.audio = { gain: Number(media.attributes?.gain ?? 1), volume: 1, normalize: Boolean(media.attributes?.loudnessNormalization) };
      ctx.points(media, "volume", "audio.volume");
    },
  },
  evaluate: {
    audio(clip, ctx) {
      if (clip.type !== "audio" || !clip.assetId) return [];
      const stream = clipStream(clip);
      return [audioSegment(ctx.project, clip, ctx.project.assets[clip.assetId]!, stream)];
    },
    clip(e, ctx) {
      const { clip } = e;
      if (!clip.assetId || !ctx.registry.hasTrait(clip.type, "visual") || !ctx.registry.hasTrait(clip.type, "media")) return;
      const asset = ctx.project.assets[clip.assetId]!;
      const stream: number = e.props.media!.stream;
      if (clip.type === "image") {
        const s = streamOf(asset, "video", 0);
        visual(e, { content: { type: "source", source: ctx.source({ kind: "image", path: asset.path }) }, size: [s.width!, s.height!] });
        return;
      }
      const s = streamOf(asset, "video", stream);
      const time = clip.type === "still" ? ticksToSeconds(clip.mediaStart ?? 0) : ticksToSeconds(e.mediaTime);
      visual(e, {
        content: { type: "source", source: ctx.source({ kind: "video", ...sourceOf(asset, "video", stream), ...proxyOf(ctx.data<ProxyData>(asset.id, "proxy"), stream) }), time },
        size: [s.width!, s.height!],
      });
    },
  },
});
