import { Trec } from "./trec";
import { runTool, spawn } from "./tool";

export interface StreamInfo {
  kind: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  duration: number;
  sampleRate?: number;
  channels?: number;
}

export interface MediaInfo {
  duration: number;
  streams: StreamInfo[];
}

/** Streams of any media file: `.trec` through the native reader, everything else through ffprobe. */
export async function probeMedia(path: string): Promise<MediaInfo> {
  if (path.toLowerCase().endsWith(".trec")) {
    using trec = Trec.open(path);
    const streams = trec.info.streams.flatMap((s): StreamInfo[] =>
      s.kind === "other"
        ? []
        : [{ kind: s.kind, codec: s.codec, width: s.width, height: s.height, duration: s.duration, sampleRate: s.sampleRate, channels: s.channels }],
    );
    return { duration: trec.info.duration, streams };
  }
  const out = await runTool(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration,sample_rate,channels", "-of", "json", "-protocol_whitelist", "file", path]).catch((e: Error) => {
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
    const log = await new Promise<string>((resolve) => {
      const proc = spawn(["ffmpeg", "-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-i", path, "-map", `0:a:${i}`, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { stdout: "ignore", stderr: "pipe" });
      void new Response(proc.stderr).text().then(resolve);
    });
    const lufs = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1];
    // Silence measures -70 (the gate): there is nothing to level.
    if (lufs !== undefined && Number(lufs) > -70) out[i] = Number(lufs);
  }
  return out;
}
