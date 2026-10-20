import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileFingerprint, measureSync, narrationStart, type PlaybackHeard, Recorder, type RecorderPreviewEvent, type RecorderSources } from "@beacon/media";
import { narrationSpan, snapSeconds, syncKey, ticksPerFrame, ticksToSeconds, type Asset, type Session } from "@beacon/model";
import type { LiveView } from "@beacon/render";
import type { ImportOptions, ImportResult, ProjectHandle, RecordOptions, RecordResult, RecordStatus, RecordStopOptions } from "./api";
import type { Analyses } from "./analyses";
import type { AppConfig } from "./config";
import { probeAsset, type CoreParts, type OpenProject } from "./project";

/** A narration being recorded: the span it plays, and when its sound was first heard (kept as playback ticks). */
interface Narration {
  from: number;
  until: number;
  hear: boolean;
  /** Nothing after the playhead to play: it records there, without playback, until stopped. */
  still: boolean;
  heard?: PlaybackHeard;
}

/** A take's default name: when it began, sortable ("2026-10-13 21.43.05"). */
function takeName(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
}

/** The recorder: takes into a project's `recordings` folder, voice narration over its timeline, and Check Sync. */
export class Recording {
  readonly #recorder = new Recorder();
  #recording?: { h: ProjectHandle; dir: string; narration?: Narration };
  #lastNarration?: RecordResult;

  constructor(
    readonly parts: CoreParts,
    readonly config: AppConfig,
    readonly analyses: Analyses,
    readonly importFiles: (h: ProjectHandle, files: string[], opts: ImportOptions) => Promise<ImportResult>,
  ) {}

  /** Whether a take is being recorded for the project. */
  recordingFor(h: ProjectHandle): boolean {
    return this.#recording?.h === h;
  }

  devices() {
    return this.#recorder.devices();
  }

  access(kind: "camera" | "microphone") {
    return this.#recorder.access(kind);
  }

  setOutput(output: string) {
    return this.#recorder.setOutput(output);
  }

  preview(sources: RecorderSources, fn?: (e: RecorderPreviewEvent) => void) {
    return this.#recorder.preview(sources, fn);
  }

  async start(p: OpenProject, opts: RecordOptions = {}): Promise<{ take: string }> {
    if (this.#recording) throw new Error(`already recording ${basename(this.#recording.dir)}`);
    if (opts.narrate) return this.#narrate(p, opts);
    const sources: RecorderSources = { ...(opts.sources ?? { screen: {}, microphone: {}, systemAudio: true }) };
    // The pair's measured delay goes into the take, so its camera clip lines up on import.
    const sync = sources.camera?.id && sources.microphone?.id ? this.config.settings().cameraSync?.[syncKey(sources.camera.id, sources.microphone.id)] : undefined;
    if (!sources.offsets && sync?.cameraLateMs) sources.offsets = { camera: -sync.cameraLateMs / 1000 };
    const dir = join(p.path, "recordings", `${opts.name ?? takeName(new Date())}.brec`);
    mkdirSync(dirname(dir), { recursive: true });
    await this.#recorder.start(dir, sources, opts.monitor);
    this.#recording = { h: p.path, dir };
    return { take: dir };
  }

  /** Records the microphone while the app's view plays the timeline from the playhead, or through the range. */
  async #narrate(p: OpenProject, opts: RecordOptions): Promise<{ take: string }> {
    const view = p.view;
    if (!view) throw new Error("a narration plays the timeline in the Beacon app: open the project there");
    const { screen, camera, systemAudio, microphone, ...rest } = opts.sources ?? { microphone: {} };
    if (screen || camera || systemAudio) throw new Error("a narration records only a microphone");
    const doc = p.store.doc;
    const { from, until, still } = narrationSpan(doc, p.session.state);
    if (p.session.state.playing) p.session.run("playback.pause", {}, doc);
    const dir = join(p.path, "recordings", `${opts.name ?? `Narration ${takeName(new Date())}`}.brec`);
    mkdirSync(dirname(dir), { recursive: true });
    await this.#recorder.start(dir, { ...rest, microphone: microphone ?? {} }, opts.monitor);
    const hear = !still && !!opts.narrate?.hear;
    if (still) {
      this.#recording = { h: p.path, dir, narration: { from, until: from, hear, still } };
      return { take: dir };
    }
    try {
      if (p.session.state.playhead !== from) p.session.run("playhead.set", { time: from }, p.store.doc);
      view.muted = !hear;
      p.session.run("playback.play", {}, p.store.doc);
    } catch (e) {
      view.muted = false;
      await this.#recorder.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    this.#recording = { h: p.path, dir, narration: { from, until, hear, still } };
    return { take: dir };
  }

  /** A playback tick in the project's view: a narration notes when its sound was heard, and ends at its range's end. */
  ticked(p: OpenProject, view: LiveView, t: number) {
    const n = this.#recording?.h === p.path ? this.#recording.narration : undefined;
    if (!n) return;
    n.heard = view.heard() ?? n.heard;
    if (t >= n.until - ticksToSeconds(ticksPerFrame(p.store.doc.settings.fps)) / 2) p.session.run("playback.pause", {}, p.store.doc);
  }

  /** A narration lasts while the timeline plays on from where it began: a pause or a seek ends it there. */
  sessionChanged(p: OpenProject, session: Session, changed: (keyof Session)[]) {
    const rec = this.#recording;
    if (!rec?.narration || rec.narration.still || rec.h !== p.path) return;
    if ((changed.includes("playing") && !session.playing) || (changed.includes("playhead") && !p.ticking)) {
      void this.stop().catch((e: unknown) => this.parts.emit(p, { kind: "error", message: `narration: ${e instanceof Error ? e.message : e}` }));
    }
  }

  async syncCheck(sources: RecorderSources, show: () => Promise<void>) {
    if (this.#recording) throw new Error(`recording ${basename(this.#recording.dir)}: stop it first`);
    const dir = join(this.parts.cacheDir, "sync-check", `${takeName(new Date())}.brec`);
    mkdirSync(dirname(dir), { recursive: true });
    await this.#recorder.start(dir, sources);
    try {
      await show();
    } finally {
      await this.#recorder.stop();
    }
    try {
      return await measureSync(dir);
    } finally {
      // The take is only for measuring; recording.json stays, to look at a check that went wrong.
      for (const f of readdirSync(dir)) if (f !== "recording.json") rmSync(join(dir, f), { force: true });
    }
  }

  async status(): Promise<RecordStatus> {
    const rec = this.#recording;
    if (!rec) return { recording: false, ...(this.#lastNarration ? { last: this.#lastNarration } : {}) };
    const s = await this.#recorder.status();
    const n = rec.narration;
    return {
      recording: s.recording,
      take: rec.dir,
      project: rec.h,
      ...(s.elapsed !== undefined ? { elapsed: s.elapsed } : {}),
      ...(n ? { narration: { from: n.from, until: n.until, hear: n.hear } } : {}),
    };
  }

  async stop(opts: RecordStopOptions = {}): Promise<RecordResult> {
    const rec = this.#recording;
    if (!rec) throw new Error("not recording");
    this.#recording = undefined;
    const p = this.parts.find(rec.h);
    const n = rec.narration;
    // Read before playback stops: pausing lets go of the audio clock.
    const heard = n && (p?.view?.heard() ?? n.heard);
    if (n && p) {
      if (p.session.state.playing) p.session.run("playback.pause", {}, p.store.doc);
      if (p.view) p.view.muted = false;
    }
    const take = await this.#recorder.stop();
    if (take.errors.length) console.warn(`recording ${basename(rec.dir)}: ${take.errors.join("; ")}`);
    const problems = take.errors.length ? { problems: take.errors } : {};
    let result: RecordResult;
    if (opts.discard) {
      rmSync(rec.dir, { recursive: true, force: true });
      result = { assets: [], clips: [], jobs: [], take: rec.dir, duration: take.duration, discarded: true };
    } else if (n) {
      if (!n.still && !heard) throw new Error(`the timeline never played, so the narration can't be lined up: ${basename(rec.dir)} is kept in the project's recordings`);
      if (heard) {
        const drift = heard.last.time - heard.time - (heard.last.host - heard.host);
        if (Math.abs(drift) > 0.005 || heard.stalled > 0) console.warn(`narration ${basename(rec.dir)}: the timeline ran ${(drift * 1000).toFixed(1)} ms off the host clock and waited ${(heard.stalled * 1000).toFixed(0)} ms for its decoder`);
      }
      // The timeline second the file's first sample is under: where it was heard, or (nothing played) the playhead.
      const at = heard ? narrationStart(rec.dir, heard) : n.from;
      result = { ...(await this.#placeNarration(this.parts.get(rec.h), rec.dir, at, n.from)), take: rec.dir, duration: take.duration, ...problems };
    } else return { ...(await this.importFiles(rec.h, [rec.dir], opts)), take: rec.dir, duration: take.duration, ...problems };
    if (n && p) {
      this.#lastNarration = result;
      this.parts.emit(p, { kind: "narrated", result });
    }
    return result;
  }

  /**
   * A narration on a new track at `from`, starting as far into its file as the timeline was heard after the
   * microphone began, so each word sits under what was playing as it was spoken. One undo step.
   */
  async #placeNarration(p: OpenProject, dir: string, at: number, from: number): Promise<ImportResult> {
    const file = resolve(dir);
    const importer = this.parts.registry.importerFor(".brec")!;
    const asset: Omit<Asset, "id"> = { kind: importer.kind, path: file, fingerprint: fileFingerprint(file), derived: await probeAsset(file) };
    const fps = p.store.doc.settings.fps;
    // The clip begins at `from`, or later if the take began after it.
    const start = Math.max(ticksToSeconds(snapSeconds(from, fps)), ticksToSeconds(snapSeconds(at, fps, "ceil")));
    const result: ImportResult = { assets: [], clips: [], jobs: [] };
    this.parts.saved(p, p.store.transaction("Record Narration", (tx) => {
      const id = tx.run<string>("asset.add", asset);
      const [spec] = importer.clips({ id, ...asset }, p.store.doc);
      if (!spec) throw new Error(`${basename(dir)} has no audio`);
      const track = tx.run<string>("track.add", { name: "Narration" });
      const mediaStart = start - at + ticksToSeconds(spec.mediaStart ?? 0);
      const duration = ticksToSeconds(spec.duration) - (start - at);
      result.assets.push(id);
      result.clips.push(tx.run<string>("clip.add", { track, type: spec.type, start, duration, mediaStart, assetId: id, props: spec.props }));
    }));
    return this.analyses.imported(p, result);
  }
}
