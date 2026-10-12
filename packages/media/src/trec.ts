import type { Pointer } from "bun:ffi";
import { checkLen, checkStatus, loadEngine, pointer, takeString } from "./engine";

export interface TrecStream {
  index: number;
  trackId: number;
  kind: "video" | "audio" | "other";
  codec: string;
  timescale: number;
  /** Seconds. */
  duration: number;
  sampleCount: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export interface TimedRect { t: number; x: number; y: number; w: number; h: number }
export interface TimedText { t: number; text: string }
/** kind: 1 display, 2 camera, 3 microphone, 4 system audio. */
export interface TrecDevice { t: number; kind: number; value: string }

export interface CursorImageInfo {
  index: number;
  width: number;
  height: number;
  /** Hotspot in image pixels from the top-left. */
  hotX: number;
  hotY: number;
  /** Image pixels to screen points (0.5 for Retina). */
  scale: number;
}

/** All times are seconds from the start of the recording; positions are screen points. */
export interface TrecInfo {
  fileSize: number;
  recorder: { name: string; version: string; platform: string; os: string };
  duration: number;
  streams: TrecStream[];
  cursorSamples: number;
  buttonEvents: number;
  displays: TimedRect[];
  windowRects: TimedRect[];
  focusedApps: TimedText[];
  windowTitles: TimedText[];
  systemInfo: TimedText[];
  devices: TrecDevice[];
  deviceIds: TrecDevice[];
  gpu: { t: number; value: number; flags: number; name: string }[];
  /** macOS virtual key code and NSEvent modifier flags. */
  keys: { t: number; key: number; flags: number }[];
  scroll: { t: number; dx: number; dy: number }[];
  stats: { t: number; value: number }[];
  cursorImages: CursorImageInfo[];
  /** The cursor image in use from `t` on, by `CursorImageInfo.index`. */
  cursorImageChanges: { t: number; index: number }[];
  rawChunks: { id: string; version: number; recordSize: number; body: string }[];
}

export interface CursorTrack {
  t: Float64Array;
  x: Int32Array;
  y: Int32Array;
}

/** `af0` button event types; 4/8 are probably the right button (docs/formats/trec.md). */
export const MouseButton = { initial: 256, leftDown: 1, leftUp: 2, rightDown: 4, rightUp: 8 } as const;

export interface ButtonTrack {
  t: Float64Array;
  kind: Uint32Array;
}

/**
 * A Camtasia recording opened by the native reader. Call `close()` when done;
 * the data is held in native memory until then.
 */
export class Trec {
  readonly info: TrecInfo;
  #handle: Pointer | null;

  private constructor(handle: Pointer, info: TrecInfo) {
    this.#handle = handle;
    this.info = info;
  }

  static open(path: string): Trec {
    const e = loadEngine();
    const handle = pointer(e.beacon_trec_open(Buffer.from(`${path}\0`)));
    if (!handle) return takeString(e, null) as never;
    try {
      return new Trec(handle, JSON.parse(takeString(e, e.beacon_trec_info_json(handle))) as TrecInfo);
    } catch (err) {
      e.beacon_trec_close(handle);
      throw err;
    }
  }

  cursor(): CursorTrack {
    const e = loadEngine();
    const n = checkLen(e, e.beacon_trec_cursor_len(this.#live()));
    const track = { t: new Float64Array(n), x: new Int32Array(n), y: new Int32Array(n) };
    if (n) checkStatus(e, e.beacon_trec_cursor_copy(this.#live(), track.t, track.x, track.y, n));
    return track;
  }

  buttons(): ButtonTrack {
    const e = loadEngine();
    const n = checkLen(e, e.beacon_trec_buttons_len(this.#live()));
    const track = { t: new Float64Array(n), kind: new Uint32Array(n) };
    if (n) checkStatus(e, e.beacon_trec_buttons_copy(this.#live(), track.t, track.kind, n));
    return track;
  }

  /** PNG bytes of `info.cursorImages[i]`. */
  cursorImage(i: number): Uint8Array {
    const e = loadEngine();
    const out = new Uint8Array(checkLen(e, e.beacon_trec_cursor_image_len(this.#live(), i)));
    checkStatus(e, e.beacon_trec_cursor_image_copy(this.#live(), i, out, out.length));
    return out;
  }

  close(): void {
    if (this.#handle) loadEngine().beacon_trec_close(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #live() {
    if (!this.#handle) throw new Error("Trec is closed");
    return this.#handle;
  }
}
