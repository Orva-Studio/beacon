import type { Pointer } from "bun:ffi";
import { AudioOutput, NativePreview, type PreviewMark, type PreviewStats } from "@beacon/media";
import { evaluate, evaluateAudio, projectDuration, roundSeconds, snapSeconds, ticksPerFrame, ticksToSeconds, type FeatureRegistry, type Project, type SourceDef } from "@beacon/model";
import { audioPlaybackArgs, renderJob, type AudioSource } from "./render";

export type ViewTarget = { layer: Pointer; width: number; height: number } | { offscreen: { width: number; height: number } };

export interface LiveViewOptions {
  registry: FeatureRegistry;
  cacheDir?: string;
  project: () => Project;
  data: <T>(assetId: string, key: string) => T | undefined;
  /** Each new frame during playback, in timeline seconds. */
  onTime?: (seconds: number) => void;
  /** Playback reached the end of the project. */
  onEnd?: () => void;
  /** Play silently on the system clock (tests, or no output device). */
  silent?: boolean;
}

/** Plays nothing; the time is wall-clock time since `play`. */
class SilentClock {
  #start?: { at: number; from: number };
  play(_: string[], from: number) {
    this.#start = { at: performance.now(), from };
  }
  time() {
    return this.#start && this.#start.from + (performance.now() - this.#start.at) / 1000;
  }
  stop() {
    this.#start = undefined;
  }
  close() {}
}

/** Around the canvas: a dark grey (23, 27, 29). */
const SURROUND: [number, number, number] = [23 / 255, 27 / 255, 29 / 255];

/** How often playback checks the audio clock; well under a frame at 60 fps. */
const TICK_MS = 4;

/** How far ahead playback starts decoders for upcoming cuts; ffmpeg takes ~0.5 s to start at a new position. */
const PREROLL_SECONDS = 2;

/** A frame shown this long without another is redrawn from the original media, not proxies. */
const SETTLE_MS = 250;

/** Every clip start on a visible track, in ticks, sorted. */
function edits(project: Project): number[] {
  return [...new Set(project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips.map((c) => c.start)))].sort((a, b) => a - b);
}

/**
 * The canvas preview in the app: renders scenes into a native view through
 * beacon-render (the export's renderer) and plays with the audio device as the
 * clock (the wall clock in reverse).
 */
export class LiveView {
  #native?: NativePreview;
  #canvas = "";
  /** Each source the preview has, as last sent: a definition that changes (a proxy built or deleted) is sent again. */
  #known = new Map<string, string>();
  #seq = 0;
  #audio?: AudioOutput | SilentClock;
  #wall?: SilentClock;
  #clock?: AudioOutput | SilentClock;
  #rate = 1;
  #timer?: ReturnType<typeof setTimeout>;
  #lastFrame = -1;
  #shown = 0;
  #size: { width: number; height: number };
  #place: [number, number, number] = [0, 0, 0];
  #marks: PreviewMark[] = [];
  #surround = SURROUND;
  /** The mix playing (its segments as JSON): an edit that leaves it alone doesn't restart the audio. */
  #mix = "";
  #edits?: { project: Project; ticks: number[] };
  /** Proxies on: moving (scrubbing or playing) rather than settled on a frame. */
  #moving = false;
  #settle?: ReturnType<typeof setTimeout>;
  #last?: string;
  readonly #prerolled = new Set<number>();

  constructor(
    readonly target: ViewTarget,
    readonly opts: LiveViewOptions,
  ) {
    this.#size = "layer" in target ? { width: target.width, height: target.height } : target.offscreen;
  }

  get playing(): boolean {
    return this.#timer !== undefined;
  }

  #preview(project: Project): NativePreview {
    const { width, height, fps } = project.settings;
    const canvas = `${width}x${height}@${fps.num}/${fps.den}`;
    if (!this.#native || canvas !== this.#canvas) {
      // One surface per layer: the old renderer lets go of it first.
      this.#native?.close();
      const job = JSON.stringify(renderJob(project, this.opts.registry, { kind: "raw" }, this.opts.cacheDir));
      const t = this.target;
      this.#native = "layer" in t ? NativePreview.onLayer(t.layer, this.#size.width, this.#size.height, job) : NativePreview.offscreen(this.#size.width, this.#size.height, job);
      this.#native.place(...this.#place);
      this.#native.surround(...this.#surround);
      this.#native.marks(this.#marks);
      this.#moving = false;
      this.#canvas = canvas;
      this.#known.clear();
    }
    return this.#native;
  }

  #scene(project: Project, t: number): string {
    const sources = new Map<string, SourceDef>();
    const scene = evaluate(project, this.opts.registry, t, { data: this.opts.data, sources });
    const fresh = [...sources].map(([id, def]) => [id, def, JSON.stringify(def)] as const).filter(([id, , json]) => this.#known.get(id) !== json);
    if (fresh.length) {
      scene.sources = Object.fromEntries(fresh.map(([id, def]) => [id, def]));
      for (const [id, , json] of fresh) this.#known.set(id, json);
    }
    return JSON.stringify(scene);
  }

  /** Starts decoders for the cuts coming up after `seconds`. */
  #preroll(project: Project, seconds: number) {
    if (this.#edits?.project !== project) {
      this.#edits = { project, ticks: edits(project) };
      this.#prerolled.clear();
    }
    const preview = this.#preview(project);
    const from = snapSeconds(seconds, project.settings.fps, "floor");
    const until = snapSeconds(seconds + PREROLL_SECONDS, project.settings.fps);
    for (const t of this.#edits.ticks) {
      if (t <= from || t > until || this.#prerolled.has(t)) continue;
      this.#prerolled.add(t);
      preview.preroll(this.#scene(project, t));
    }
  }

  /** Draws the canvas at a timeline time; returns the time shown (snapped down to a frame). */
  show(seconds: number): number {
    const project = this.opts.project();
    const t = snapSeconds(seconds, project.settings.fps, "floor");
    const preview = this.#preview(project);
    // An edit redrawn at the settled frame (a canvas drag, a slider) keeps the originals: their decoders are already there.
    const still = !this.#moving && !this.playing && this.#last !== undefined && ticksToSeconds(t) === this.#shown;
    if (!this.#moving && !still) {
      preview.proxies(true);
      this.#moving = true;
    }
    this.#last = this.#scene(project, t);
    preview.submit(++this.#seq, this.#last);
    this.#shown = ticksToSeconds(t);
    clearTimeout(this.#settle);
    if (!this.playing && !still) this.#settle = setTimeout(() => this.#settled(), SETTLE_MS);
    return roundSeconds(this.#shown);
  }

  /** Redraws the frame on screen from the originals now, rather than after a pause in movement. */
  settle() {
    clearTimeout(this.#settle);
    this.#settled();
  }

  /** Redraws the frame on screen from the originals: exactly what export renders. */
  #settled() {
    if (!this.#native || !this.#last || this.playing) return;
    this.#native.proxies(false);
    this.#moving = false;
    this.#native.submit(++this.#seq, this.#last);
  }

  resize(width: number, height: number) {
    this.#size = { width, height };
    this.#native?.resize(width, height);
  }

  /** `zoom`: canvas pixels per view pixel, 0 to fit. */
  place(zoom: number, panX = 0, panY = 0) {
    this.#place = [zoom, panX, panY];
    this.#native?.place(zoom, panX, panY);
  }

  /** The colour around the canvas (the editor's `stage` token), 0-1 RGB. */
  surround(r: number, g: number, b: number) {
    this.#surround = [r, g, b];
    this.#native?.surround(r, g, b);
  }

  /** What the editor draws over the canvas (selection, handles, guides); drawn with the next frame, placed with the picture. */
  marks(marks: PreviewMark[]) {
    this.#marks = marks;
    this.#native?.marks(marks);
  }

  stats(): PreviewStats | undefined {
    return this.#native?.stats();
  }

  /** Waits for the last scene to be drawn; offscreen views return its RGBA pixels. */
  flush(): Uint8Array | undefined {
    return this.#native?.flush();
  }

  /** Plays from a timeline time until `pause` or the end (the start, in reverse); `rate` as the session's. */
  play(from: number, rate = 1) {
    this.pause();
    this.#rate = rate;
    const project = this.opts.project();
    const end = ticksToSeconds(projectDuration(project));
    // Reverse plays without sound, on the wall clock.
    const clock = rate > 0 ? (this.#audio ??= this.opts.silent ? new SilentClock() : new AudioOutput()) : (this.#wall ??= new SilentClock());
    this.#clock = clock;
    if (rate > 0) {
      this.#mix = JSON.stringify(evaluateAudio(project, this.opts.registry));
      clock.play(audioPlaybackArgs(project, this.opts.registry, from, Math.max(0, end - from), this.#audioProxy(project), rate), from);
    } else clock.play([], from);
    this.#lastFrame = -1;
    this.#prerolled.clear();
    const frame = ticksToSeconds(ticksPerFrame(project.settings.fps));
    const tick = () => {
      const raw = clock.time();
      if (raw !== undefined) {
        // The clock runs at 1x from `from`: the mix is already sped up (or silent).
        const now = from + (raw - from) * rate;
        const done = rate > 0 ? now >= end - frame / 2 : now <= 0;
        if (done) {
          this.pause();
          this.opts.onTime?.(this.show(rate > 0 ? Math.max(0, end - frame) : 0));
          this.opts.onEnd?.();
          return;
        }
        const f = Math.floor(now / frame + 1e-6);
        if (f !== this.#lastFrame) {
          this.#lastFrame = f;
          this.opts.onTime?.(this.show(now));
          if (rate > 0) this.#preroll(this.opts.project(), now);
        }
      }
      this.#timer = setTimeout(tick, TICK_MS);
    };
    this.#timer = setTimeout(tick, 0);
  }

  /** Each segment's audio from its asset's proxy copy, when built: opening the originals costs ~0.15 s per segment. */
  #audioProxy(project: Project): AudioSource {
    const byPath = new Map(Object.values(project.assets).map((a) => [a.path, a.id]));
    return (s) => {
      const id = byPath.get(s.path);
      const path = id && this.opts.data<{ audio?: Record<number, string> }>(id, "proxy")?.audio?.[s.stream];
      return path ? { path, stream: 0 } : undefined;
    };
  }

  pause() {
    const was = this.playing;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#clock?.stop();
    this.#clock = undefined;
    if (was) this.#settle = setTimeout(() => this.#settled(), SETTLE_MS);
  }

  /**
   * The document changed: while playing, restart only if the sound changed
   * (frames already read the latest document every tick), else redraw the
   * current frame.
   */
  refresh() {
    if (!this.playing) return void this.show(this.#shown);
    const project = this.opts.project();
    if (JSON.stringify(evaluateAudio(project, this.opts.registry)) !== this.#mix) this.play(this.#shown, this.#rate);
  }

  close() {
    clearTimeout(this.#settle);
    this.pause();
    clearTimeout(this.#settle);
    this.#audio?.close();
    this.#audio = undefined;
    this.#native?.close();
    this.#native = undefined;
  }
}
