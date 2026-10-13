import { readFileSync } from "node:fs";
import { join } from "node:path";
import { probeMedia, type MediaInfo, type StreamInfo } from "./probe";

/** A Beacon recording: a folder of one file per stream (docs/formats/brec.md). */
export const isBrec = (path: string) => path.toLowerCase().replace(/\/+$/, "").endsWith(".brec");

interface RecordingJson {
  version: number;
  complete: boolean;
  duration: number | null;
  streams: Record<string, { file: string; start: number | null; offset?: number }>;
}

/** Streams in the order a take's clips are stacked: screen, camera, then the microphone above system audio. */
const ORDER: NonNullable<StreamInfo["role"]>[] = ["screen", "camera", "microphone", "systemAudio"];

function recording(path: string): RecordingJson {
  const data = JSON.parse(readFileSync(join(path, "recording.json"), "utf8")) as RecordingJson;
  if (data.version !== 1) throw new Error(`${path}: recording.json version ${data.version} isn't one Beacon reads`);
  return data;
}

/**
 * A take's streams, each with its file and where in the take that file starts (plus any measured device
 * offset). A take the recorder never finished lasts as long as its longest stream.
 */
export async function probeBrec(path: string): Promise<MediaInfo> {
  const rec = recording(path);
  const streams: StreamInfo[] = [];
  for (const role of ORDER) {
    const s = rec.streams[role];
    if (!s || s.start === null) continue;
    const [first] = (await probeMedia(join(path, s.file))).streams;
    if (!first) continue;
    streams.push({ ...first, file: s.file, start: s.start + (s.offset ?? 0), role });
  }
  if (!streams.length) throw new Error(`${path}: the take recorded nothing`);
  const duration = rec.duration ?? Math.max(...streams.map((s) => (s.start ?? 0) + s.duration));
  return { duration, streams };
}

/** The cursor of a take, as `loadCursorData` returns a `.trec`'s, in the screen file's own time. */
export function loadBrecCursor(path: string) {
  const rec = recording(path);
  const offset = rec.streams.screen?.start ?? 0;
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const buttons: { t: number; kind: number }[] = [];
  const images: { index: number; width: number; height: number; hotX: number; hotY: number; scale: number; file: string }[] = [];
  const changes: { t: number; index: number }[] = [];
  let display: { x: number; y: number; w: number; h: number } | undefined;
  let text = "";
  try {
    text = readFileSync(join(path, "cursor.jsonl"), "utf8");
  } catch {
    // A take without the screen has no cursor.
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, number | string | Record<string, number>>;
    try {
      r = JSON.parse(line);
    } catch {
      // The last line of a take the recorder never finished can be cut short.
      continue;
    }
    if (r.display) display = r.display as typeof display;
    else if (typeof r.image === "number") images.push({ index: r.image, width: r.width as number, height: r.height as number, hotX: r.hotX as number, hotY: r.hotY as number, scale: r.scale as number, file: join(path, r.file as string) });
    else if (typeof r.cursor === "number") changes.push({ t: (r.t as number) - offset, index: r.cursor });
    else if (typeof r.button === "number") buttons.push({ t: (r.t as number) - offset, kind: r.button });
    else if (typeof r.x === "number") {
      t.push((r.t as number) - offset);
      x.push(Math.round(r.x));
      y.push(Math.round(r.y as number));
    }
  }
  return {
    path,
    t: Float64Array.from(t),
    x: Int32Array.from(x),
    y: Int32Array.from(y),
    images,
    changes,
    display,
    buttons: { t: Float64Array.from(buttons.map((b) => b.t)), kind: Uint32Array.from(buttons.map((b) => b.kind)) },
  };
}
