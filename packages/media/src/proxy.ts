import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { runTool, spawn, tool } from "./tool";

/** Keyframe every this many frames: a seek decodes at most this many. */
const GOP = 10;
/** Streams wider than this get half-size proxies. */
const FULL_SIZE_MAX = 1920;

export interface Proxy {
  path: string;
  /** Proxy size over the stream's size. */
  factor: number;
}

export interface ProxySource {
  /** Index among the file's video streams. */
  stream: number;
  codec: string;
  width: number;
  height: number;
  out: string;
}

/** Codecs VideoToolbox decodes (ffprobe's names and `.trec`'s): their proxies are decoded and scaled on the GPU. */
const HARDWARE = new Set(["h264", "avc1", "hevc", "hvc1", "hev1", "prores", "apcn", "apch", "apcs", "apco", "ap4h"]);

/**
 * Copies of a file's video streams for the live preview, one ffmpeg for all of
 * them: HEVC (VideoToolbox) with a keyframe every few frames and the source's
 * frame times, so seeking costs one small file open and a few decodes instead
 * of the recording's ~0.5 s. Screens get more bits than cameras: below 8 Mb/s
 * their text softens. H.264/HEVC/ProRes are decoded and scaled on the GPU (a
 * 4K camera: 3.5 s of CPU instead of 81, docs/performance.md); `quiet` runs
 * ffmpeg at macOS background priority (efficiency cores, throttled I/O).
 */
export async function makeProxies(path: string, sources: ProxySource[], duration: number, opts: { quiet?: boolean; onProgress?: (f: number) => void } = {}): Promise<Proxy[]> {
  const proxies = sources.map((s) => ({ path: s.out, factor: s.width > FULL_SIZE_MAX ? 0.5 : 1 }));
  const todo = sources.map((s, i) => ({ ...s, factor: proxies[i]!.factor, tmp: `${s.out}.${process.pid}.tmp.mp4` })).filter((s) => !existsSync(s.out));
  if (!todo.length) return proxies;
  for (const s of todo) mkdirSync(dirname(s.out), { recursive: true });
  const build = (hardware: boolean) => {
    const input: string[] = [];
    const outputs: string[] = [];
    for (const s of todo) {
      const [w, h] = [Math.trunc((s.width * s.factor) / 2) * 2, Math.trunc((s.height * s.factor) / 2) * 2];
      const gpu = hardware && HARDWARE.has(s.codec);
      if (gpu) input.push(`-hwaccel:v:${s.stream}`, "videotoolbox", `-hwaccel_output_format:v:${s.stream}`, "videotoolbox_vld");
      const scale = s.factor === 1 ? [] : ["-vf", gpu ? `scale_vt=${w}:${h}` : `scale=${w}:${h}:flags=area`];
      outputs.push(
        "-map", `0:v:${s.stream}`, "-an", ...scale,
        // The proxy's frames must keep the source's times: the preview finds frames by time in either.
        "-fps_mode", "passthrough", "-enc_time_base", "demux",
        "-c:v", "hevc_videotoolbox", "-tag:v", "hvc1", "-b:v", s.codec === "tsc2" ? "8M" : "5M", "-g", String(GOP), ...(gpu ? [] : ["-pix_fmt", "yuv420p"]),
        s.tmp,
      );
    }
    return runTool(
      // One scaling thread: the encoder sets the pace, and more threads only add CPU (a 626 s screen: 23 → 16 s).
      [...(opts.quiet ? ["taskpolicy", "-b"] : []), tool("ffmpeg"), "-nostdin", "-v", "error", "-stats", "-y", "-protocol_whitelist", "file", "-filter_threads", "1", ...input, "-i", path, ...outputs],
      {
        onStderr: (chunk) => {
          const m = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
          if (m && duration > 0) opts.onProgress?.(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration));
        },
      },
    );
  };
  try {
    // A source VideoToolbox turns down (4:2:2 H.264, say) is decoded in software instead.
    await build(true).catch((e: Error) => (todo.some((s) => HARDWARE.has(s.codec)) ? build(false) : Promise.reject(e)));
    for (const s of todo) renameSync(s.tmp, s.out);
  } finally {
    for (const s of todo) rmSync(s.tmp, { force: true });
  }
  return proxies;
}

/**
 * One audio stream copied out of its container (no re-encode): opening a
 * recording costs ~0.15 s, and playback opens one input per audio segment.
 */
export async function makeAudioProxy(path: string, stream: number, out: string): Promise<string> {
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp.mka`;
  try {
    await runTool([tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file", "-i", path, "-map", `0:a:${stream}`, "-c", "copy", tmp]);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return out;
}

/** Peak level per 10 ms of one audio stream, 0–255, for timeline waveforms. */
export async function waveformPeaks(path: string, stream: number): Promise<number[]> {
  const proc = spawn([tool("ffmpeg"), "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", path, "-map", `0:a:${stream}`, "-ac", "1", "-ar", "4000", "-f", "s16le", "-"], { stdout: "pipe", stderr: "ignore" });
  const pcm = new Int16Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg could not read the audio of ${path}`);
  const peaks: number[] = [];
  for (let i = 0; i < pcm.length; i += 40) {
    let max = 0;
    for (let j = i; j < Math.min(i + 40, pcm.length); j++) max = Math.max(max, Math.abs(pcm[j]!));
    peaks.push(Math.min(255, Math.round(Math.sqrt(max / 32768) * 255)));
  }
  return peaks;
}

/** A small PNG of one video frame (`time` seconds into the stream), `height` pixels tall. */
export async function thumbnailPng(path: string, stream: number, time: number, height: number): Promise<Uint8Array> {
  const out = await new Response(
    spawn(
      [tool("ffmpeg"), "-nostdin", "-v", "error", "-ss", Math.max(0, time).toFixed(3), "-protocol_whitelist", "file", "-i", path, "-map", `0:v:${stream}`, "-frames:v", "1", "-vf", `scale=-2:${height}`, "-f", "image2pipe", "-c:v", "png", "-"],
      { stdout: "pipe", stderr: "ignore" },
    ).stdout,
  ).arrayBuffer();
  return new Uint8Array(out);
}
