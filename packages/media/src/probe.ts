import { join } from "node:path";
import { isBrec, loadBrecCursor, probeBrec } from "./brec";
import { Trec } from "./trec";
import { ffmpegInput, runTool, spawn, tool } from "./tool";

export interface StreamInfo {
  kind: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  duration: number;
  sampleRate?: number;
  channels?: number;
  /** In a `.brec`: the stream's file in the folder, where that file starts in the take (seconds), and what it is. */
  file?: string;
  start?: number;
  role?: "screen" | "camera" | "microphone" | "systemAudio";
}

export interface MediaInfo {
  duration: number;
  streams: StreamInfo[];
}

/**
 * Where to read an asset's `n`th stream of a kind: its own file's stream `n`, or in a `.brec` (a stream per
 * file) that stream's file and its only stream.
 */
export function streamSource(path: string, info: MediaInfo, kind: "video" | "audio", n: number): { path: string; stream: number } {
  const s = info.streams.filter((x) => x.kind === kind)[n];
  return s?.file ? { path: join(path, s.file), stream: 0 } : { path, stream: n };
}

/** TechSmith's screen codec: `tsc2` as a `.trec` names it, `tscc2` as ffprobe does (projects store either). */
export function isScreenCodec(codec: string): boolean {
  return codec === "tsc2" || codec === "tscc2";
}

/** Streams of any media: `.trec` through the native reader, a `.brec` from its streams' files, everything else through ffprobe. */
export async function probeMedia(path: string): Promise<MediaInfo> {
  if (isBrec(path)) return probeBrec(path);
  if (path.toLowerCase().endsWith(".trec")) {
    using trec = Trec.open(path);
    const streams = trec.info.streams.flatMap((s): StreamInfo[] =>
      s.kind === "other"
        ? []
        : [{ kind: s.kind, codec: s.codec, width: s.width, height: s.height, duration: s.duration, sampleRate: s.sampleRate, channels: s.channels }],
    );
    return { duration: trec.info.duration, streams };
  }
  const out = await runTool([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration,sample_rate,channels", "-of", "json", "-protocol_whitelist", "file", path]).catch((e: Error) => {
    throw new Error(`ffprobe ${path}: ${e.message}`);
  });
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; duration?: string; sample_rate?: string; channels?: number }[];
  };
  const duration = Number(json.format?.duration ?? 0) || 0;
  const streams = json.streams.flatMap((s): StreamInfo[] => {
    if (s.codec_type !== "video" && s.codec_type !== "audio") return [];
    return [
      {
        kind: s.codec_type,
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        duration: Number(s.duration ?? duration) || 0,
        sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
        channels: s.channels,
      },
    ];
  });
  return { duration, streams };
}

/** Everything the cursor feature needs from a recording (`CursorData` in @beacon/features). */
export function loadCursorData(path: string) {
  if (isBrec(path)) return loadBrecCursor(path);
  using trec = Trec.open(path);
  const { t, x, y } = trec.cursor();
  const buttons = trec.buttons();
  const display = trec.info.displays[0];
  return {
    path,
    t,
    x,
    y,
    images: trec.info.cursorImages,
    changes: trec.info.cursorImageChanges,
    display: display ? { x: display.x, y: display.y, w: display.w, h: display.h } : undefined,
    buttons,
  };
}



/**
 * Integrated loudness (EBU R128, LUFS) of each audio stream, by audio stream
 * index: what "Auto-normalize loudness" levels from.
 */
export async function measureLoudness(path: string, info: MediaInfo): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  const audio = info.streams.filter((s) => s.kind === "audio").length;
  for (let i = 0; i < audio; i++) {
    const src = streamSource(path, info, "audio", i);
    const log = await new Promise<string>((resolve) => {
      const proc = spawn([tool("ffmpeg"), "-nostdin", "-hide_banner", ...ffmpegInput(src.path), "-map", `0:a:${src.stream}`, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { stdout: "ignore", stderr: "pipe" });
      void new Response(proc.stderr).text().then(resolve);
    });
    const lufs = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1];
    // Silence measures -70 (the gate): there is nothing to level.
    if (lufs !== undefined && Number(lufs) > -70) out[i] = Number(lufs);
  }
  return out;
}
