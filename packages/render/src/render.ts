import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { enginePath, runTool, spawn, tool, toolsDir } from "@beacon/media";
import { DEFAULT_CACHE_DIR, DerivedData } from "./derived";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  evaluate,
  evaluateAudio,
  projectDuration,
  ticksPerFrame,
  ticksToSeconds,
  type AudioSegment,
  type Easing,
  type FeatureRegistry,
  type Project,
  type Scene,
  type SourceDef,
  type Ticks,
} from "@beacon/model";

/** Export options; the format is the path's extension: .mp4, .mov, .gif or .webm. */
export interface VideoEncoding {
  /** .mp4 and .mov; ProRes only in .mov. */
  codec?: "h264" | "hevc" | "prores";
  /** Video data rate in kbit/s; omitted: automatic. */
  bitrate?: number;
  /** A keyframe every this many frames. */
  keyframe?: number;
  /** H.264 profile. */
  profile?: "baseline" | "main" | "high";
  /** Output frame rate; omitted: the project's. */
  fps?: number;
  /** Fit within this size, keeping the aspect ratio; omitted: the canvas. */
  size?: { width: number; height: number };
  /** false: no audio track. */
  audio?: boolean;
  /** Audio data rate in kbit/s. */
  audioBitrate?: number;
  /** Export colour space: BT.709 (default), or sRGB's transfer, which macOS players show as the editor does. */
  colorSpace?: "bt709" | "srgb";
}

export const VIDEO_FORMATS = ["mp4", "mov", "gif", "webm"] as const;

export type RenderOutput = ({ kind: "video"; path: string } & VideoEncoding) | { kind: "png"; dir: string };

export interface RenderOptions {
  output: RenderOutput;
  /** Timeline range; defaults to the whole project. */
  from?: Ticks;
  to?: Ticks;
  /** Render only these frame numbers (PNG output). */
  frames?: number[];
  /** Where frame indexes and other derived data are cached. */
  cacheDir?: string;
  onProgress?: (frame: number, total: number) => void;
  /** Derived asset data; defaults to the registered analyzers and the shared cache. */
  data?: <T>(assetId: string, key: string) => T | undefined;
}

function workerPath(): string {
  const path = process.env.BEACON_WORKER_PATH ?? enginePath("beacon-worker");
  if (!existsSync(path)) throw new Error(`beacon-worker not found at ${path}; run \`bun run build:engine\``);
  return path;
}

/** The worker/renderer job header: canvas, every registered pass, where to cache frame indexes. */
export function renderJob(project: Project, registry: FeatureRegistry, output: unknown, cacheDir?: string) {
  const passes = Object.fromEntries([...registry.passes.values()].map((p) => [p.id, { wgsl: p.wgsl, steps: p.steps }]));
  return { width: project.settings.width, height: project.settings.height, fps: project.settings.fps, output, sources: {}, passes, cacheDir };
}

const ENCODERS: Record<NonNullable<VideoEncoding["codec"]>, string[]> = {
  h264: ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-tag:v", "avc1"],
  hevc: ["-c:v", "hevc_videotoolbox", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"],
  prores: ["-c:v", "prores_videotoolbox", "-profile:v", "hq"],
};

/** RGBA → BT.709 limited range, tagged with the transfer of `space`, as players expect for HD. */
const trc = (space: VideoEncoding["colorSpace"]) => (space === "srgb" ? "iec61966-2-1" : "bt709");
const colorTags = (space: VideoEncoding["colorSpace"]) => ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", trc(space), "-color_range", "tv"];
// setparams: VideoToolbox writes the primaries and transfer from each frame, which the scale leaves unset.
const toYuv = (space: VideoEncoding["colorSpace"]) => `scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=${trc(space)}:colorspace=bt709:range=tv`;

/** Automatic data rate: what export used before the options existed. */
const AUTO_BITRATE = "16M";
/** A keyframe every 30 frames. */
const KEYFRAME = 30;

/** The format of a video output, from its extension. */
export function videoFormat(path: string): (typeof VIDEO_FORMATS)[number] {
  const ext = extname(path).slice(1).toLowerCase();
  const f = VIDEO_FORMATS.find((x) => x === ext);
  if (!f) throw new Error(`can't export ${ext ? `.${ext}` : "without an extension"}: use ${VIDEO_FORMATS.map((x) => `.${x}`).join(", ")}`);
  return f;
}

/** The ffmpeg output options the worker encodes the frames with. */
function encoderArgs(o: Extract<RenderOutput, { kind: "video" }>): string[] {
  const format = videoFormat(o.path);
  const fit = o.size ? `scale=${o.size.width}:${o.size.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` : "";
  const rate = o.fps ? ["-r", String(o.fps)] : [];
  const keyframe = ["-g", String(o.keyframe ?? KEYFRAME)];
  if (format === "gif") return ["-filter_complex", `${o.fps ? `fps=${o.fps},` : ""}${fit}split[a][b];[a]palettegen[p];[b][p]paletteuse`, "-loop", "0"];
  if (format === "webm") {
    const quality = o.bitrate ? ["-b:v", `${o.bitrate}k`] : ["-b:v", "0", "-crf", "32"];
    return ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", ...quality, ...keyframe, "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-vf", `${fit}${toYuv(o.colorSpace)}`, ...colorTags(o.colorSpace), ...rate];
  }
  const codec = o.codec ?? "h264";
  if (codec === "prores" && format === "mp4") throw new Error("ProRes exports to .mov, not .mp4");
  const quality = codec === "prores" ? [] : ["-b:v", o.bitrate ? `${o.bitrate}k` : AUTO_BITRATE, ...keyframe];
  const profile = codec === "h264" && o.profile ? ["-profile:v", o.profile] : [];
  return [...ENCODERS[codec], ...quality, ...profile, "-vf", `${fit}${toYuv(o.colorSpace)}`, ...colorTags(o.colorSpace), ...rate];
}

/** A frame rate as a fraction: 29.97 is 30000/1001. */
function rational(fps: number): { num: number; den: number } {
  return Number.isInteger(fps) ? { num: fps, den: 1 } : { num: Math.round(fps * 1001), den: 1001 };
}

/** The video's size: the canvas fitted within `size` (as ffmpeg's force_original_aspect_ratio=decrease), even. */
export function fittedSize(canvas: { width: number; height: number }, size?: { width: number; height: number }): { width: number; height: number } {
  const s = size ? Math.min(size.width / canvas.width, size.height / canvas.height) : 1;
  return { width: Math.max(2, Math.floor((canvas.width * s) / 2) * 2), height: Math.max(2, Math.floor((canvas.height * s) / 2) * 2) };
}

/**
 * With `BEACON_ENCODE_NATIVE=1`, H.264, HEVC and ProRes in MP4 or MOV are encoded by VideoToolbox straight from
 * the GPU's frames, a few in flight. Not yet the default: it has no parity test against ffmpeg's output. GIF and
 * WebM always go through ffmpeg.
 */
function nativeEncode(project: Project, o: Extract<RenderOutput, { kind: "video" }>, path: string) {
  const format = videoFormat(o.path);
  if ((format !== "mp4" && format !== "mov") || !process.env.BEACON_ENCODE_NATIVE) return undefined;
  const codec = o.codec ?? "h264";
  if (codec === "prores" && format === "mp4") throw new Error("ProRes exports to .mov, not .mp4");
  return {
    kind: "encode",
    path,
    codec,
    ...fittedSize(project.settings, o.size),
    fps: o.fps ? rational(o.fps) : project.settings.fps,
    bitrate: (o.bitrate ?? 16_000) * 1000,
    keyframe: o.keyframe ?? KEYFRAME,
    ...(codec === "h264" && o.profile ? { profile: o.profile } : {}),
    srgb: o.colorSpace === "srgb",
  };
}

/**
 * Renders a project through the `beacon-worker` sidecar: evaluates each frame,
 * streams scenes to it, and (for video) mixes and muxes the audio clips.
 */
export async function renderProject(project: Project, registry: FeatureRegistry, opts: RenderOptions): Promise<{ frames: number }> {
  const frameTicks = ticksPerFrame(project.settings.fps);
  const from = opts.from ?? 0;
  const to = opts.to ?? projectDuration(project);
  const frames = opts.frames ?? Array.from({ length: Math.ceil((to - from) / frameTicks) }, (_, i) => Math.round(from / frameTicks) + i);

  const tmp = opts.output.kind === "video" ? mkdtempSync(join(tmpdir(), "beacon-")) : undefined;
  try {
    const format = opts.output.kind === "video" ? videoFormat(opts.output.path) : undefined;
    const videoOnly = tmp ? join(tmp, `video.${format === "mp4" ? "mov" : format}`) : undefined;
    const native = opts.output.kind === "video" ? nativeEncode(project, opts.output, videoOnly!) : undefined;
    const output = native ?? (opts.output.kind === "video" ? { kind: "video", path: videoOnly, args: encoderArgs(opts.output) } : { kind: "png", dir: opts.output.dir });
    // Natively encoded at another rate, frames are evaluated at that rate rather than dropped or repeated.
    const step = native ? ticksPerFrame(native.fps) : frameTicks;
    const times = native && opts.frames === undefined ? Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step) : frames.map((f) => f * frameTicks);

    const job = renderJob(project, registry, output, opts.cacheDir);

    const proc = spawn([workerPath()], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, BEACON_TOOLS_DIR: toolsDir() } });
    let error: string | undefined;
    let done = 0;
    const reader = (async () => {
      const lines = proc.stdout.pipeThrough(new TextDecoderStream());
      let buf = "";
      for await (const chunk of lines) {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl)) as { frame?: number; done?: number; error?: string };
          buf = buf.slice(nl + 1);
          if (msg.error) error = msg.error;
          if (msg.frame !== undefined) opts.onProgress?.(msg.frame, times.length);
          if (msg.done !== undefined) done = msg.done;
        }
      }
    })();

    const data = opts.data ?? new DerivedData(registry, opts.cacheDir ?? DEFAULT_CACHE_DIR, () => project).get;
    const known = new Set<string>();
    let failure: unknown;
    try {
      proc.stdin.write(`${JSON.stringify(job)}\n`);
      for (const [i, time] of times.entries()) {
        if (error) break;
        const sources = new Map<string, SourceDef>();
        const scene: Scene = evaluate(project, registry, time, { data, sources });
        const fresh = [...sources].filter(([id]) => !known.has(id));
        if (fresh.length) {
          scene.sources = Object.fromEntries(fresh);
          for (const [id] of fresh) known.add(id);
        }
        if (opts.output.kind === "png") scene.name = `f${String(frames[i]).padStart(6, "0")}`;
        proc.stdin.write(`${JSON.stringify(scene)}\n`);
        await proc.stdin.flush();
      }
      await proc.stdin.end();
    } catch (e) {
      failure = e;
      proc.kill();
    }
    const code = await proc.exited;
    await reader;
    // A worker that dies first breaks the pipe; its own message says why.
    if (error || failure || code !== 0) {
      throw new Error(`render failed: ${error ?? (failure instanceof Error ? failure.message : failure) ?? `beacon-worker exited with ${code}`}`);
    }

    if (opts.output.kind === "video") {
      if (format === "gif") copyFileSync(videoOnly!, opts.output.path);
      else await muxAudio(project, registry, videoOnly!, opts.output, ticksToSeconds(times[0]!), times.length * ticksToSeconds(step));
    }
    return { frames: done };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function easeExpr(easing: Easing, x: string): string {
  return easing === "linear" ? x : `if(lt(${x},0.5),4*pow(${x},3),1-pow(2-2*${x},3)/2)`;
}

/** A segment's gain as an ffmpeg expression of `t`, seconds into its input; `animatedValue`'s rules, with `offset` the media time at `t` = 0. */
function gainExpr({ base, ramps }: AudioSegment["gain"], offset: number): string {
  const m = `(t+${offset.toFixed(6)})`;
  let expr = String(ramps.at(-1)?.to ?? base);
  for (let i = ramps.length - 1; i >= 0; i--) {
    const r = ramps[i]!;
    const from = i === 0 ? base : ramps[i - 1]!.to;
    if (r.end > r.start) expr = `if(lt(${m},${r.end}),${from}+(${r.to - from})*${easeExpr(r.easing, `(${m}-${r.start})/${r.end - r.start}`)},${expr})`;
    expr = `if(lt(${m},${r.start}),${from},${expr})`;
  }
  return expr;
}

/** `atempo` takes 0.5–100, so other speeds are a chain. */
function atempo(speed: number): string {
  const factors: number[] = [];
  let x = speed;
  while (x > 100) (factors.push(100), (x /= 100));
  while (x < 0.5) (factors.push(0.5), (x /= 0.5));
  if (Math.abs(x - 1) > 1e-9) factors.push(x);
  return factors.map((f) => `,atempo=${f}`).join("");
}

/**
 * ffmpeg inputs and a filter graph mixing every audible segment of
 * [start, start + length) into `[aout]`, starting at `firstInput`; the
 * export muxes it under the video, playback streams it to the device.
 */
export function audioMix(project: Project, registry: FeatureRegistry, start: number, length: number, firstInput = 0, source?: AudioSource): { inputs: string[]; filter?: string } {
  const inputs: string[] = [];
  const filters: string[] = [];
  let n = 0;
  for (const s of evaluateAudio(project, registry)) {
    const from = Math.max(s.start, start);
    const until = Math.min(s.start + s.duration, start + length);
    if (until <= from) continue;
    const media = s.mediaStart + (from - s.start) * s.speed;
    const input = firstInput + n++;
    const src = source?.(s) ?? { path: s.path, stream: s.stream };
    inputs.push("-ss", media.toFixed(6), "-t", ((until - from) * s.speed).toFixed(6), "-protocol_whitelist", "file", "-i", src.path);
    const volume = s.gain.ramps.length ? `volume='${gainExpr(s.gain, media)}':eval=frame` : `volume=${s.gain.base.toFixed(5)}`;
    filters.push(`[${input}:a:${src.stream}]${volume}${atempo(s.speed)},adelay=delays=${Math.round((from - start) * 1000)}:all=1[a${n}]`);
  }
  if (!n) return { inputs };
  return { inputs, filter: `${filters.join(";")};${Array.from({ length: n }, (_, i) => `[a${i + 1}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest,apad[aout]` };
}

/** Where to read a segment's audio instead of its original file (a proxy with the same timing). */
export type AudioSource = (segment: AudioSegment) => { path: string; stream: number } | undefined;

/** ffmpeg argv streaming the mix from `start` for `length` seconds (output options appended by the caller); empty when silent. */
export function audioPlaybackArgs(project: Project, registry: FeatureRegistry, start: number, length: number, source?: AudioSource, rate = 1): string[] {
  const { inputs, filter } = audioMix(project, registry, start, length, 0, source);
  if (!filter) return [];
  // atempo keeps the pitch; ffmpeg 7 takes 0.5-100 in one stage.
  const sped = rate === 1 ? filter : `${filter};[aout]atempo=${rate}[sped]`;
  return [tool("ffmpeg"), "-nostdin", "-v", "error", ...inputs, "-filter_complex", sped, "-map", rate === 1 ? "[aout]" : "[sped]", "-t", (length / rate).toFixed(6)];
}

/** Mixes every audible segment in the rendered range under the video. */
async function muxAudio(project: Project, registry: FeatureRegistry, video: string, o: Extract<RenderOutput, { kind: "video" }>, start: number, length: number) {
  const webm = videoFormat(o.path) === "webm";
  const { inputs, filter } = o.audio === false ? { inputs: [] } : audioMix(project, registry, start, length, 1);
  const args = [tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-i", video, ...inputs];
  if (filter) {
    // Opus runs at 48 kHz only.
    const codec = webm ? ["-c:a", "libopus", "-ar", "48000"] : ["-c:a", "aac", "-ar", String(project.settings.sampleRate)];
    args.push("-filter_complex", filter, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", ...codec, "-b:a", `${o.audioBitrate ?? 256}k`, "-shortest");
  } else {
    args.push("-map", "0:v", "-c:v", "copy");
  }
  if (!webm) args.push("-movflags", "+faststart");
  args.push(o.path);
  await runTool(args).catch((e: Error) => {
    throw new Error(`audio mux failed: ${e.message}`);
  });
}
