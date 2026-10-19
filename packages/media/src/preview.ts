import type { Pointer } from "bun:ffi";
import { checkStatus, copyOut, cstr, lastError, loadEngine, pointer, takeString } from "./engine";

export interface PreviewStats {
  shown: number;
  /** `seq` of the scene last on screen. */
  seq: number;
  skipped: number;
  lastMs: number;
  error: string | null;
  /** The last error seen, kept after later frames succeed. */
  lastError: string | null;
  width: number;
  height: number;
  /** Canvas pixels per view pixel when the canvas fits the view. */
  fitZoom: number;
}

/** A line or circle drawn over the canvas (beacon-render's `Mark`): positions in canvas pixels (y down), widths and radii in view pixels; straight RGBA 0–1. */
export type PreviewMark =
  | { kind: "line"; from: [number, number]; to: [number, number]; width: number; color: [number, number, number, number] }
  | { kind: "circle"; at: [number, number]; radius: number; width: number; fill: [number, number, number, number]; stroke: [number, number, number, number] };

/**
 * The live preview: beacon-render drawing into a native view's `CAMetalLayer`
 * (or offscreen) on its own thread. Submitting never blocks; only the
 * latest scene is drawn.
 */
export class NativePreview {
  #handle: Pointer | null;

  private constructor(handle: Pointer | null) {
    if (!handle) throw new Error(lastError(loadEngine()));
    this.#handle = handle;
  }

  /** `layer`: the view's `CAMetalLayer`; `width`×`height` physical pixels. */
  static onLayer(layer: Pointer, width: number, height: number, jobJson: string): NativePreview {
    const e = loadEngine();
    return new NativePreview(pointer(e.beacon_preview_new(layer, width, height, cstr(jobJson))));
  }

  static offscreen(width: number, height: number, jobJson: string): NativePreview {
    const e = loadEngine();
    return new NativePreview(pointer(e.beacon_preview_offscreen(width, height, cstr(jobJson))));
  }

  submit(seq: number, sceneJson: string): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_submit(this.#live(), seq >>> 0, cstr(sceneJson)));
  }

  /** Starts decoders for an upcoming scene (the next cut) without drawing it. */
  preroll(sceneJson: string): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_preroll(this.#live(), cstr(sceneJson)));
  }

  /** Read video from proxies where available (fast seeking) or only from the originals. */
  proxies(on: boolean): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_proxies(this.#live(), on ? 1 : 0));
  }

  resize(width: number, height: number): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_resize(this.#live(), Math.max(1, Math.round(width)), Math.max(1, Math.round(height))));
  }

  /** `zoom`: canvas pixels per view pixel, 0 to fit; `pan` in view pixels from the centre. */
  place(zoom: number, panX = 0, panY = 0): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_place(this.#live(), zoom, panX, panY));
  }

  surround(r: number, g: number, b: number): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_surround(this.#live(), r, g, b));
  }

  /** Replaces what is drawn over the canvas in the same frame as the picture (the editor's selection and guides). */
  marks(marks: PreviewMark[]): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_preview_marks(this.#live(), cstr(JSON.stringify(marks))));
  }

  /** Waits for queued work; an offscreen preview returns its RGBA pixels. */
  flush(): Uint8Array | undefined {
    const e = loadEngine();
    const out = copyOut(e, e.beacon_preview_flush(this.#live()), (out, cap) => e.beacon_preview_result_copy(this.#live(), out, cap));
    return out.length ? out : undefined;
  }

  stats(): PreviewStats {
    const e = loadEngine();
    return JSON.parse(takeString(e, e.beacon_preview_stats_json(this.#live()))) as PreviewStats;
  }

  close(): void {
    if (this.#handle) loadEngine().beacon_preview_free(this.#handle);
    this.#handle = null;
  }

  #live() {
    if (!this.#handle) throw new Error("preview is closed");
    return this.#handle;
  }
}

/** The default audio output, playing an ffmpeg mix; its position is the playback clock. */
/**
 * When playback's first sample was heard: `host`, host-clock seconds (mach time, as `recording.json`'s `hostStart`),
 * and `time`, the timeline second heard then. `last`: the same for the latest buffer, to see the device's clock drift;
 * `stalled`: seconds the timeline waited for its decoder since.
 */
export interface PlaybackHeard {
  host: number;
  time: number;
  last: { host: number; time: number };
  stalled: number;
}

export class AudioOutput {
  #handle: Pointer | null;
  readonly rate: number;

  constructor() {
    const e = loadEngine();
    this.#handle = pointer(e.beacon_audio_new());
    if (!this.#handle) throw new Error(lastError(e));
    this.rate = e.beacon_audio_rate(this.#handle);
  }

  /** `args`: ffmpeg argv (inputs and filters, output appended natively), empty for silence. */
  play(args: string[], start: number): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_audio_play(this.#live(), cstr(JSON.stringify(args)), start));
  }

  /** Timeline seconds now audible, or undefined when stopped. */
  time(): number | undefined {
    const t = loadEngine().beacon_audio_time(this.#live());
    return t < 0 ? undefined : t;
  }

  /** When this play's first sample was heard, on the host clock capture stamps buffers with; undefined until it is. */
  heard(): PlaybackHeard | undefined {
    const out = new Float64Array(5);
    if (loadEngine().beacon_audio_heard(this.#live(), out) !== 0) return undefined;
    const [host, time, lastHost, lastTime, stalled] = [...out] as [number, number, number, number, number];
    return { host, time, last: { host: lastHost, time: lastTime }, stalled };
  }

  /** Stops, returning the timeline second up to which sound had gone to the device (some not heard yet), or undefined when it wasn't playing. */
  halt(): number | undefined {
    const t = loadEngine().beacon_audio_halt(this.#live());
    return t < 0 ? undefined : t;
  }

  stop(): void {
    const e = loadEngine();
    checkStatus(e, e.beacon_audio_stop(this.#live()));
  }

  close(): void {
    if (this.#handle) loadEngine().beacon_audio_free(this.#handle);
    this.#handle = null;
  }

  #live() {
    if (!this.#handle) throw new Error("audio output is closed");
    return this.#handle;
  }
}
