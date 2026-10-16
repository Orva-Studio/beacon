import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { importCmproj } from "@beacon/camtasia";
import { annotationPresets, createRegistry } from "@beacon/features";
import { fileFingerprint, jobProcesses, jobSignal, type JobProcesses, type MediaInfo, measureLoudness, measureSync, narrationStart, pastePng, type PlaybackHeard, probeMedia, Recorder, type RecorderPreviewEvent, type RecorderSources, streamSource, thumbnailPng } from "@beacon/media";
import {
  createProject,
  describeSession,
  jsonSchemaOf,
  formatIssues,
  type ActionDef,
  type SharedSession,
  editScope,
  nestedOf,
  projectDuration,
  ProjectStore,
  randomId,
  roundSeconds,
  secondsToTicks,
  SESSION_COMMANDS,
  SessionStore,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type CommandResult,
  type Asset,
  type Clip,
  type Ticks,
  type FeatureRegistry,
  type JobAnalyzerDef,
  type MediaImporterDef,
  type Project,
  type ResourceDef,
  type Session,
  type SessionChange,
  placeCanvas,
  rationalToNumber,
  scopedProject,
  walkClips,
  assetName,
} from "@beacon/model";
import { DEFAULT_CACHE_DIR, DerivedData, FrameRenderer, LiveView, renderProject, videoFormat, type ViewTarget } from "@beacon/render";
import type {
  AssetPreview,
  CommandInfo,
  CoreEvent,
  ExportOptions,
  FrameOptions,
  Image,
  ImportOptions,
  ImportResult,
  Job,
  JobInfo,
  NewProjectOptions,
  BeaconCore,
  ProjectHandle,
  QueryInfo,
  RecordOptions,
  RecordResult,
  RecordStopOptions,
  ResourceInfo,
  PreferenceInfo,
  RecordStatus,
  RunOptions,
  SchemaInfo,
  SheetOptions,
  Snapshot,
  TransactionStep,
} from "./api";
import { download } from "./download";
import { keychain, type Secrets } from "./keychain";
import { copyFollowingLinks, copyIntoProject, isInside } from "./media-copy";
import { lock, readProject, unlock, writeProject } from "./persist";

export interface LocalCoreOptions {
  registry?: FeatureRegistry;
  /** Save after every change (headless agents never lose work). Default true. */
  autosave?: boolean;
  /** Frame indexes and derived data such as transcripts. */
  cacheDir?: string;
  /** The app's automation socket, recorded in each project's lock so agents connect to it. */
  socket?: string;
  /** Shows a file in Finder; the app passes its own. */
  reveal?: (path: string) => void;
  /** Where app-wide preferences are kept (`preferences.json`): Beacon's Application Support folder. */
  configDir?: string;
  /** Where secrets (API keys) are kept: the login Keychain. */
  secrets?: Secrets;
}

const DEFAULT_CONFIG_DIR = join(homedir(), "Library/Application Support/Beacon");

interface OpenProject {
  path: string;
  store: ProjectStore;
  session: SessionStore;
  data: DerivedData;
  frames: FrameRenderer;
  view?: LiveView;
  /** Set while playback itself moves the playhead, so it isn't taken as a seek. */
  ticking: boolean;
  listeners: Set<(e: CoreEvent) => void>;
  saveTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Screenshot of the app window showing a project, provided by the app, with
 * where the canvas view sits in it (image pixels) and pixels per point.
 */
export type Snapshotter = (h: ProjectHandle) => Promise<{
  png: Uint8Array;
  canvas?: { x: number; y: number; width: number; height: number };
  scale: number;
  /** What the window reports it has drawn, as text. */
  shown?: string;
}>;

/** A narration being recorded: the span it plays, and when its sound was first heard (kept as playback ticks). */
interface Narration {
  from: number;
  until: number;
  hear: boolean;
  /** Nothing after the playhead to play: it records there, without playback, until stopped. */
  still: boolean;
  heard?: PlaybackHeard;
}

const PLAYBACK = new Set(["playback.play", "playback.toggle", "playback.shuttle"]);

/** Preview jobs (proxies) built at once: Quietly keeps the fans off, Fast builds two. */
const PREVIEW_JOBS_AT_ONCE = { quiet: 1, fast: 2 } as const;

/** Finished jobs kept for `job()`/`jobs()`; older ones are forgotten. */
const KEEP_FINISHED_JOBS = 50;

interface JobEntry {
  info: Omit<JobInfo, "elapsed">;
  /** The project it belongs to: closing the project cancels it. None for a download. */
  project?: string;
  /** Processes it has running (ffmpeg, whisper, beacon-worker), killed when it is cancelled. */
  processes: JobProcesses;
  /** What the job works on, for finding a running job again. */
  subject?: string;
  started: number;
  done: Promise<unknown>;
}

const MAX_SHEET = 100;

const UI_STATE: { id: string; description: string; args: z.ZodType; resource: QueryInfo["resource"]; summary?: boolean } = {
  id: "ui.state",
  description: "The editor's state: playhead, playing, selection, in/out range, visible timeline span, open panels, inspector tab, canvas zoom",
  args: z.strictObject({}),
  resource: { uri: "beacon://ui/state", name: "Editor state", mimeType: "application/json" },
};

/** Short enough for agents to read back; unique enough within one project. */
const shortId = (prefix: string) => randomId(prefix, 8);
/** Bytes in a file, or in a folder and everything under it; 0 if missing. */
async function diskSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return s.size;
    const sizes = await Promise.all((await readdir(path)).map((f) => diskSize(join(path, f))));
    return sizes.reduce((n, b) => n + b, 0);
  } catch {
    return 0;
  }
}

/** The encoding options of an export call, without its other fields. */
const encoding = ({ output: _, overwrite: _o, from: _f, to: _t, ...rest }: ExportOptions) => rest;

/** A project's queue of preview jobs, and the media it has prepared or is preparing. */
interface PreviewQueue {
  todo: { asset: Asset; def: { id: string } }[];
  running: Map<string, number>;
  /** Running job id → its asset. */
  jobs: Map<string, string>;
}

/** In-process core: owns the documents, runs the engine, reads and writes `.beproj` folders (PLAN §7.1). */
/** A take's default name: when it began, sortable ("2026-10-13 21.43.05"). */
function takeName(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
}

export class LocalCore implements BeaconCore {
  readonly registry: FeatureRegistry;
  readonly cacheDir: string;
  readonly #autosave: boolean;
  readonly #socket?: string;
  readonly #reveal: (path: string) => void;
  readonly #projects = new Map<ProjectHandle, OpenProject>();
  readonly #jobs = new Map<string, JobEntry>();
  /** The last copies in any project, so they paste into the next one opened. */
  #shared: SharedSession = { clipboard: null, properties: null };

  readonly #configDir: string;
  readonly #secrets: Secrets;
  #prefs: Record<string, string>;
  readonly #pref = (id: string): string => {
    const def = this.registry.preferences.get(id);
    if (!def) throw new Error(`no preference "${id}"`);
    const v = this.#prefs[id];
    return v !== undefined && def.options.some((o) => o.id === v) ? v : def.default;
  };

  constructor(opts: LocalCoreOptions = {}) {
    this.registry = opts.registry ?? createRegistry();
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.#configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
    this.#secrets = opts.secrets ?? keychain;
    try {
      this.#prefs = JSON.parse(readFileSync(join(this.#configDir, "preferences.json"), "utf8")) as Record<string, string>;
    } catch {
      this.#prefs = {};
    }
    this.#autosave = opts.autosave ?? true;
    this.#socket = opts.socket;
    this.#reveal = opts.reveal ?? ((path) => void Bun.spawn(["open", "-R", path]));
  }

  #get(h: ProjectHandle): OpenProject {
    const p = this.#projects.get(h);
    if (!p) throw new Error(`project ${h} is not open`);
    return p;
  }

  #attach(path: string, doc: Project): ProjectHandle {
    let current = doc;
    const data = new DerivedData(this.registry, this.cacheDir, () => current, this.#pref);
    const store = new ProjectStore(this.registry, doc, { newId: shortId, data: data.get });
    lock(path, this.#socket);
    store.subscribe((e) => void (current = e.doc));
    const p: OpenProject = {
      path,
      store,
      session: new SessionStore(this.registry, doc, this.#shared),
      data,
      frames: new FrameRenderer(this.registry, this.cacheDir),
      ticking: false,
      listeners: new Set(),
    };
    store.subscribe((e) => {
      this.#emit(p, { kind: e.kind, label: e.label, patches: e.patches });
      p.session.reconcile(e.doc);
      p.view?.refresh();
    });
    p.session.subscribe((c) => this.#sessionChanged(p, c));
    this.#projects.set(path, p);
    return path;
  }

  #emit(p: OpenProject, e: CoreEvent) {
    for (const l of p.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async open(path: string): Promise<ProjectHandle> {
    const dir = resolve(path);
    if (this.#projects.has(dir)) return dir;
    const { doc, stale } = readProject(dir, this.registry);
    const h = this.#attach(dir, doc);
    // Locked first: another process may hold it, and must not have it rewritten under it.
    if (stale) writeProject(dir, doc);
    return h;
  }

  async create(opts: NewProjectOptions): Promise<ProjectHandle> {
    const dir = resolve(opts.path);
    if (existsSync(dir)) throw new Error(`${dir} already exists`);
    if (extname(dir) !== ".beproj") throw new Error("project folders end in .beproj");
    let doc: Project;
    if (opts.cmproj) {
      const { project, report } = await importCmproj(resolve(opts.cmproj), this.registry);
      for (const line of report) console.error(`import: ${line}`);
      this.#importReports.set(dir, report);
      doc = { ...project, settings: { ...project.settings, ...opts.settings } };
    } else {
      doc = createProject(this.registry, opts.settings);
    }
    if (opts.standalone) {
      doc = { ...doc, settings: { ...doc.settings, standalone: true } };
      const moved = await this.#copyIn(dir, Object.values(doc.assets));
      doc = { ...doc, assets: { ...doc.assets, ...Object.fromEntries(moved.map((a) => [a.id, a])) } };
    }
    writeProject(dir, doc);
    return this.#attach(dir, doc);
  }

  readonly #importReports = new Map<string, string[]>();

  /**
   * Copies media from outside the project folder into its `media` folder: the assets as they will be, each with
   * its copy's path and the results (transcripts) its original had. Missing files are left as they are.
   */
  async #copyIn(dir: string, assets: Asset[]): Promise<Asset[]> {
    const outside = assets.filter((a) => !isInside(dir, a.path) && existsSync(a.path));
    if (!outside.length) return [];
    const copies = await copyIntoProject(dir, outside.map((a) => a.path));
    const data = new DerivedData(this.registry, this.cacheDir, () => ({ assets: {} }) as unknown as Project, this.#pref);
    return outside.map((a) => {
      const path = copies.get(a.path)!;
      const copy = { ...a, path, fingerprint: fileFingerprint(path) };
      data.carry(a, copy);
      return copy;
    });
  }

  /** Standalone on: what is outside the project is copied in, and the project points at the copies, as one undo step. */
  async #makeStandalone(p: OpenProject, args: unknown, opts: RunOptions): Promise<CommandResult> {
    const assets = Object.values(p.store.doc.assets);
    const moved = await this.#copyIn(p.path, assets);
    const missing = assets.filter((a) => !isInside(p.path, a.path) && !existsSync(a.path));
    const r = this.#saved(p, p.store.transaction(opts.label ?? "Make Project Standalone", (tx) => {
      tx.run("project.settings.set", args);
      for (const a of moved) tx.run("asset.relink", { asset: a.id, path: a.path, fingerprint: a.fingerprint });
    }));
    return missing.length ? { ...r, diff: [...r.diff, `(${missing.length} missing file(s) stay where they were: ${missing.map((a) => basename(a.path)).join(", ")})`] } : r;
  }

  /** What a project made from a Camtasia project (`create` with `cmproj`) left out or changed, line by line. */
  importReport(h: ProjectHandle): string[] {
    return this.#importReports.get(resolve(h)) ?? [];
  }

  async save(h: ProjectHandle): Promise<void> {
    const p = this.#get(h);
    writeProject(p.path, p.store.doc);
    this.#emit(p, { kind: "saved", path: p.path });
  }

  async saveAs(h: ProjectHandle, path: string, opts: { standalone?: boolean } = {}): Promise<string> {
    const p = this.#get(h);
    const to = resolve(path);
    if (extname(to) !== ".beproj") throw new Error("project folders end in .beproj");
    if (existsSync(to)) throw new Error(`${basename(to)} already exists`);
    if (isInside(p.path, to)) throw new Error("a project can't be saved inside itself");
    const doc = p.store.doc;
    const standalone = opts.standalone ?? !!doc.settings.standalone;
    // Its own folders come whole (takes, snapshots, and anything else kept there), but not its lock or a save in
    // progress; links are followed, so the copy doesn't depend on what they pointed at.
    await copyFollowingLinks(p.path, to, (src) => dirname(src) !== p.path || !/^(lock|\.project\.json\..*\.tmp)$/.test(basename(src)));
    const assets = Object.values(doc.assets);
    const inside = assets.filter((a) => isInside(p.path, a.path)).map((a) => {
      const copy = { ...a, path: to + a.path.slice(p.path.length) };
      p.data.carry(a, copy);
      return copy;
    });
    const outside = standalone ? await this.#copyIn(to, assets.filter((a) => !isInside(p.path, a.path))) : [];
    const { standalone: _, ...settings } = doc.settings;
    writeProject(to, {
      ...doc,
      settings: standalone ? { ...settings, standalone: true } : settings,
      assets: { ...doc.assets, ...Object.fromEntries([...inside, ...outside].map((a) => [a.id, a])) },
    });
    return to;
  }

  async reveal(h: ProjectHandle): Promise<void> {
    this.#reveal(this.#get(h).path);
  }

  /** Saves and releases the project; if the save fails it is still released, and the failure is the error. */
  async close(h: ProjectHandle): Promise<void> {
    // A take being recorded for it is stopped and imported first, rather than left in its folder.
    if (this.#recording?.h === h) await this.recordStop();
    const p = this.#get(h);
    clearTimeout(p.saveTimer);
    // Exports render a copy of the document taken when they started: they finish after the project closes.
    this.#cancelJobsOf(p.path, (j) => j.info.kind !== "export");
    let failed: unknown;
    try {
      writeProject(p.path, p.store.doc);
    } catch (e) {
      failed = e;
    }
    try {
      p.view?.close();
      p.frames.close();
      unlock(p.path);
    } finally {
      this.#projects.delete(h);
    }
    if (failed) throw new Error(`closed ${p.path}, but its latest changes could not be saved: ${failed instanceof Error ? failed.message : failed}`);
  }

  /**
   * Renames the project's folder to `name`.beproj beside it, closing it first (its undo history ends there);
   * media kept inside it (recordings, snapshots) follow. Returns the new path, for `open`.
   */
  async rename(h: ProjectHandle, name: string): Promise<string> {
    const p = this.#get(h);
    const clean = name.trim().replace(/\.beproj$/i, "");
    if (!clean || /[/:]/.test(clean) || clean.startsWith(".")) throw new Error(`"${name}" can't be a project name`);
    const to = join(dirname(p.path), `${clean}.beproj`);
    if (to === p.path) return to;
    // A change of case only is the same folder on macOS's disks.
    if (existsSync(to) && to.toLowerCase() !== p.path.toLowerCase()) throw new Error(`${basename(to)} already exists`);
    // Media inside it is stored relative to it, so it follows.
    await this.close(h);
    renameSync(p.path, to);
    return to;
  }

  /** Releases every lock; call on exit. */
  closeAll() {
    this.#cancelJobsOf(undefined);
    for (const p of this.#projects.values()) {
      // A drag's last change is saved after a pause; quitting must not lose it.
      if (p.saveTimer !== undefined) {
        clearTimeout(p.saveTimer);
        try {
          if (this.#autosave) writeProject(p.path, p.store.doc);
        } catch (e) {
          console.error(`could not save ${p.path} on exit:`, e);
        }
      }
      p.view?.close();
      p.frames.close();
      unlock(p.path);
    }
    this.#projects.clear();
  }

  doc(h: ProjectHandle): Project {
    return this.#get(h).store.doc;
  }

  async run(h: ProjectHandle, command: string, args: unknown, opts: RunOptions = {}): Promise<CommandResult> {
    const p = this.#get(h);
    if (p.session.has(command)) return this.#runSession(p, command, args, opts);
    if (command === "project.settings.set" && (args as { standalone?: unknown } | null)?.standalone === true && !p.store.doc.settings.standalone && !opts.dryRun) {
      return this.#makeStandalone(p, args, opts);
    }
    const action = this.registry.actions.get(command);
    if (action) return this.#runAction(p, action, args, opts);
    if (opts.coalesce && !opts.dryRun) {
      const r = p.store.run(command, args, opts);
      this.#saveSoon(p);
      return r;
    }
    return this.#saved(p, p.store.run(command, args, opts));
  }

  /** A drag changes the document many times a second: write it once things settle. */
  #saveSoon(p: OpenProject) {
    if (!this.#autosave) return;
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => {
      p.saveTimer = undefined;
      if (this.#projects.get(p.path) !== p) return;
      try {
        writeProject(p.path, p.store.doc);
        this.#emit(p, { kind: "saved", path: p.path });
      } catch (e) {
        // The next save writes the whole document, so a later change or close retries this one.
        this.#emit(p, { kind: "error", message: `could not save ${p.path}: ${e instanceof Error ? e.message : e}` });
      }
    }, 300);
  }

  /** An editor action: its editor steps, then its document steps as one undo step, then editor steps that follow from them. */
  #runAction(p: OpenProject, action: ActionDef, args: unknown, opts: RunOptions): CommandResult {
    const parsed = action.args.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`${action.id}: ${formatIssues(parsed.error)}`);
    const scope = editScope(p.store.doc, p.session.state.group, nestedOf(this.registry));
    const plan = action.resolve(parsed.data, { project: p.store.doc, session: p.session.state, registry: this.registry, scope: { tracks: scopedProject(p.store.doc, scope).tracks, group: scope.group } });
    const label = opts.label ?? plan.label;
    if (opts.dryRun) {
      const r = plan.steps?.length ? p.store.transaction(label, (tx) => plan.steps!.forEach((s) => tx.run(s.command, s.args ?? {})), { dryRun: true }) : undefined;
      const lines = [...(plan.before ?? []), ...(plan.steps ?? [])].map((s) => `${s.command} ${JSON.stringify(s.args ?? {})}`);
      return { label, patches: r?.patches ?? [], inverse: r?.inverse ?? [], results: r?.results ?? [], diff: [...lines, ...(r?.diff ?? [])], dryRun: true };
    }
    const before = p.session.state;
    let result: CommandResult;
    try {
      for (const s of plan.before ?? []) p.session.run(s.command, s.args, p.store.doc);
      result = plan.steps?.length
        ? this.#saved(p, p.store.transaction(label, (tx) => plan.steps!.forEach((s) => tx.run(s.command, s.args ?? {}))))
        : { label, patches: [], inverse: [], results: [], diff: [], dryRun: false };
    } catch (e) {
      // A Cut that couldn't delete must not have replaced the clipboard either.
      if (p.session.state !== before) p.session.restore(before);
      throw e;
    }
    // The document change is committed: an editor step after it that fails is reported, not thrown, or a retry would apply the change twice.
    try {
      for (const s of plan.after?.(result.results) ?? []) p.session.run(s.command, s.args, p.store.doc);
    } catch (e) {
      return { ...result, diff: [...result.diff, `(editor step after the change failed: ${e instanceof Error ? e.message : String(e)})`] };
    }
    return result;
  }

  async transaction(h: ProjectHandle, label: string, steps: TransactionStep[], opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const p = this.#get(h);
    const editor = steps.find((s) => p.session.has(s.command));
    if (editor) throw new Error(`${editor.command} changes the editor, not the project; run it on its own, outside a transaction`);
    if (steps.some((s) => s.command === "project.settings.set" && (s.args as { standalone?: unknown } | null)?.standalone === true)) {
      throw new Error("standalone copies media into the project: run project.settings.set on its own, outside a transaction");
    }
    return this.#saved(p, p.store.transaction(label, (tx) => {
      for (const s of steps) tx.run(s.command, s.args ?? {});
    }, opts));
  }

  #runSession(p: OpenProject, command: string, args: unknown, opts: RunOptions): CommandResult {
    if (PLAYBACK.has(command) && !p.view && !p.session.state.playing) throw new Error(`${command} needs the Beacon app: playback plays in its window`);
    const before = p.session.state;
    const { session, changed } = p.session.run(command, args, p.store.doc, { dryRun: opts.dryRun });
    const diff = changed.map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(session[k])}`);
    return { label: opts.label ?? command, patches: [], inverse: [], results: [session], diff, dryRun: !!opts.dryRun };
  }

  #sessionChanged(p: OpenProject, { session, changed }: SessionChange) {
    if (changed.includes("clipboard") || changed.includes("properties")) {
      this.#shared = { clipboard: session.clipboard, properties: session.properties };
      for (const other of this.#projects.values()) if (other !== p) other.session.share(this.#shared);
    }
    this.#emit(p, { kind: "session", changes: Object.fromEntries(changed.map((k) => [k, session[k]])) as Partial<Session>, changed });
    // A narration lasts while the timeline plays on from where it began: a pause or a seek ends it there.
    if (this.#recording?.narration && !this.#recording.narration.still && this.#recording.h === p.path && ((changed.includes("playing") && !session.playing) || (changed.includes("playhead") && !p.ticking))) {
      void this.recordStop().catch((e: unknown) => this.#emit(p, { kind: "error", message: `narration: ${e instanceof Error ? e.message : e}` }));
    }
    const view = p.view;
    if (!view || p.ticking) return;
    if (changed.includes("playing") && !session.playing) view.pause();
    else if (session.playing && (changed.includes("playing") || changed.includes("playhead") || changed.includes("rate"))) view.play(session.playhead, session.rate);
    else if (changed.includes("playhead")) view.show(session.playhead);
  }

  async session(h: ProjectHandle): Promise<Session> {
    return this.#get(h).session.state;
  }

  #snapshotter?: Snapshotter;

  /** The app provides window screenshots for `snapshot`. */
  setSnapshotter(fn: Snapshotter | undefined) {
    this.#snapshotter = fn;
  }

  async snapshot(h: ProjectHandle): Promise<Snapshot> {
    const p = this.#get(h);
    const shot = this.#snapshotter && p.view ? await this.#snapshotter(h) : undefined;
    const image = shot && pngImage(this.#withCanvas(p, shot));
    const stats = p.view?.stats();
    const preview = stats ? `\npreview: ${stats.width}x${stats.height} px, ${stats.shown} frames drawn, last ${stats.lastMs.toFixed(1)} ms${stats.error ? `, error: ${stats.error}` : ""}${stats.lastError && stats.lastError !== stats.error ? `, last error: ${stats.lastError}` : ""}` : "";
    const window = shot?.shown ? `\nwindow shows: ${shot.shown}` : "";
    const description = describeSession(p.session.state, p.store.doc) + preview + window + (image ? "" : "\n(no app window is showing this project, so there is no screenshot)");
    return { ...(image ? { image } : {}), session: p.session.state, description };
  }

  /**
   * The screenshot with the canvas drawn into it at the playhead: a window
   * behind others gets no new frames (macOS skips occluded Metal layers),
   * so the screenshot alone can show a stale preview.
   */
  #withCanvas(p: OpenProject, shot: Awaited<ReturnType<Snapshotter>>): Uint8Array {
    const s = p.session.state;
    if (!shot.canvas || s.playing) return shot.png;
    const doc = p.store.doc;
    const { x, y, width, height } = shot.canvas;
    const at = placeCanvas(doc.settings, { width, height }, s.canvas.zoom, s.canvas.pan ?? [0, 0], shot.scale);
    const [cw, ch] = [Math.round(doc.settings.width * at.k), Math.round(doc.settings.height * at.k)];
    // Only a canvas wholly inside the view is pasted.
    if (at.x < 0 || at.y < 0 || at.x + cw > width || at.y + ch > height || cw > doc.settings.width * 2) return shot.png;
    const frame = p.frames.frame(doc, snapSeconds(s.playhead, doc.settings.fps, "floor"), p.data.get, cw);
    return pastePng(shot.png, frame, x + at.x, y + at.y);
  }

  /**
   * Shows the project in a native view (the app's canvas) and plays it
   * there; session playback follows. Replaces any previous view.
   * `proxies`: build seek-friendly copies of the media in the background (default for native views).
   */
  attachView(h: ProjectHandle, target: ViewTarget, opts: { silent?: boolean; proxies?: boolean } = {}): LiveView {
    const p = this.#get(h);
    p.view?.close();
    const view = new LiveView(target, {
      registry: this.registry,
      cacheDir: this.cacheDir,
      project: () => p.store.doc,
      data: p.data.get,
      onTime: (t) => {
        p.ticking = true;
        try {
          p.session.run("playhead.set", { time: t }, p.store.doc);
        } finally {
          p.ticking = false;
        }
        const n = this.#recording?.h === p.path ? this.#recording.narration : undefined;
        if (!n) return;
        n.heard = view.heard() ?? n.heard;
        if (t >= n.until - ticksToSeconds(ticksPerFrame(p.store.doc.settings.fps)) / 2) p.session.run("playback.pause", {}, p.store.doc);
      },
      onEnd: () => p.session.run("playback.pause", {}, p.store.doc),
      silent: opts.silent,
    });
    p.view = view;
    view.show(p.session.state.playhead);
    if (opts.proxies ?? "layer" in target) {
      this.#previewJobs(p);
      // Transcripts an import started but a quit cancelled: made now, not when Remove Silences or Captions needs one.
      this.#importAnalyses(p.path, Object.keys(p.store.doc.assets));
    }
    return view;
  }

  /** The Media Bin's preview document: the asset alone, placed as importing it would, on a canvas of its picture's size. */
  #previewDoc(h: ProjectHandle, assetId: string): { doc: Project; info: AssetPreview } {
    const p = this.#get(h);
    const base = p.store.doc;
    const asset = base.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const media = asset.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined;
    const picture = media?.streams?.find((s) => s.kind === "video" && s.width && s.height);
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const settings = picture ? { ...base.settings, width: even(picture.width!), height: even(picture.height!) } : base.settings;
    const store = new ProjectStore(this.registry, { ...base, settings, tracks: [], markers: [] }, { newId: shortId, data: p.data.get });
    store.run("asset.place", { asset: assetId, time: 0 });
    const doc = store.doc;
    const kind = asset.kind === "image" ? "image" : picture ? "video" : "audio";
    const duration = kind === "image" ? 0 : ticksToSeconds(projectDuration(doc));
    return { doc, info: { kind, duration, width: settings.width, height: settings.height, fps: rationalToNumber(settings.fps) } };
  }

  /** What the Media Bin's preview of an asset shows (a double-click). */
  assetPreviewInfo(h: ProjectHandle, assetId: string): AssetPreview {
    return this.#previewDoc(h, assetId).info;
  }

  /** Shows an asset alone in a view of its own, to play and scrub; nothing is saved. Close the view when done. */
  previewAsset(h: ProjectHandle, assetId: string, target: ViewTarget, opts: { onTime?: (t: number) => void; onEnd?: () => void } = {}): LiveView {
    const p = this.#get(h);
    const { doc } = this.#previewDoc(h, assetId);
    const view = new LiveView(target, { registry: this.registry, cacheDir: this.cacheDir, project: () => doc, data: p.data.get, onTime: opts.onTime, onEnd: opts.onEnd });
    view.show(0);
    return view;
  }

  /** Starts the analyzers the app needs (proxies) for assets that lack them; the view redraws as each finishes. */
  /**
   * Proxies and the like, a few at a time (each ffmpeg uses every core; a project of 28 media started them
   * all at once and the fans ran), media near the playhead first. Later ones start only while the project
   * is still shown.
   */
  #previewJobs(p: OpenProject) {
    const doc = p.store.doc;
    const at = secondsToTicks(p.session.state.playhead);
    const distance = new Map<string, number>();
    for (const { clip, offset } of walkClips(doc.tracks, this.registry)) {
      if (!clip.assetId) continue;
      const [a, b] = [offset + clip.start, offset + clip.start + clip.duration];
      const d = at < a ? a - at : at > b ? at - b : 0;
      distance.set(clip.assetId, Math.min(d, distance.get(clip.assetId) ?? Infinity));
    }
    const wanted = Object.values(doc.assets)
      .flatMap((asset) =>
        [...this.registry.jobAnalyzers.values()].filter((def) => def.when === "preview" && def.applies(asset) && !p.data.has(asset, def.id) && this.#automatic(def.id, asset) && existsSync(asset.path)).map((def) => ({ asset, def })),
      )
      .sort((x, y) => (distance.get(x.asset.id) ?? Infinity) - (distance.get(y.asset.id) ?? Infinity));
    // One queue per project: asked again (media imported), it is refilled rather than doubled.
    const queue = this.#previewQueues.get(p);
    if (queue) {
      queue.todo.splice(0, queue.todo.length, ...wanted);
      return void this.#preparing(p, queue);
    }
    if (!wanted.length) return;
    const state: PreviewQueue = { todo: wanted, running: new Map(), jobs: new Map() };
    const todo = state.todo;
    this.#previewQueues.set(p, state);
    const unwatch = this.watchJobs((j) => {
      if (j.state === "running" && state.jobs.has(j.id)) this.#preparing(p, state);
    });
    let workers = 0;
    const next = (): Promise<void> | undefined => {
      const item = todo.shift();
      if (!item || this.#projects.get(p.path) !== p || !p.view) {
        if (--workers === 0) {
          this.#previewQueues.delete(p);
          unwatch();
          this.#emit(p, { kind: "preparing", assets: {} });
        }
        return;
      }
      let job: Job;
      try {
        job = this.#analyze(p.path, item.def.id, item.asset.id);
      } catch {
        return next();
      }
      const id = item.asset.id;
      state.running.set(id, (state.running.get(id) ?? 0) + 1);
      state.jobs.set(job.id, id);
      this.#preparing(p, state);
      const finished = () => {
        state.running.set(id, state.running.get(id)! - 1);
        state.jobs.delete(job.id);
        this.#preparing(p, state);
        return next();
      };
      return job.done.then(() => {
        if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
        return finished();
      }, finished);
    };
    // Counted before each starts: a worker that finds nothing left stops at once, and must not be restarted here.
    const started = Math.min(PREVIEW_JOBS_AT_ONCE[this.#jobMode], todo.length);
    workers = started;
    for (let i = 0; i < started; i++) void next();
  }

  readonly #previewQueues = new WeakMap<OpenProject, PreviewQueue>();

  #jobMode: "quiet" | "fast" = "quiet";

  /**
   * How background analyses run (the app's setting): "quiet" (default), one preview job at a time at
   * macOS background priority, slower but the fans stay off; "fast", two at once at normal priority.
   * Jobs already running keep their mode.
   */
  setJobMode(mode: "quiet" | "fast") {
    this.#jobMode = mode;
  }

  /** Which analyses start on their own (the app's settings: proxies), on import, when shown or when a preference changes; the rest run only when asked. */
  #automatic: (analyzer: string, asset: Asset) => boolean = () => true;

  /** Sets which analyses (e.g. proxies) start on their own; projects shown now follow at once. */
  setAutomatic(fn: (analyzer: string, asset: Asset) => boolean) {
    this.#automatic = fn;
    for (const p of this.#projects.values()) if (p.view) this.#previewJobs(p);
  }

  /** Tells the window each medium's progress, for those with a job queued or running. */
  #preparing(p: OpenProject, q: PreviewQueue) {
    const left = new Set([...q.todo.map((i) => i.asset.id), ...[...q.running].filter(([, n]) => n > 0).map(([id]) => id)]);
    // A medium's progress is its jobs' average, a queued one counting as none.
    const assets: Record<string, number> = {};
    for (const id of left) {
      const jobs = [...q.jobs].filter(([, a]) => a === id).map(([j]) => this.#job(j).progress);
      const queued = q.todo.filter((i) => i.asset.id === id).length;
      assets[id] = jobs.reduce((a, b) => a + b, 0) / Math.max(1, jobs.length + queued);
    }
    this.#emit(p, { kind: "preparing", assets });
  }

  detachView(h: ProjectHandle) {
    const p = this.#get(h);
    if (p.session.state.playing) p.session.run("playback.pause", {}, p.store.doc);
    p.view?.close();
    p.view = undefined;
  }

  /** Derived data for an asset (e.g. "waveform"), once its analyzer has run. */
  derived<T>(h: ProjectHandle, assetId: string, key: string): T | undefined {
    return this.#get(h).data.get<T>(assetId, key);
  }

  /** PNG of a video clip's first frame, `height` pixels tall, read from its proxy when there is one; undefined for other clips. */
  async thumbnail(h: ProjectHandle, clipId: string, height: number): Promise<Uint8Array | undefined> {
    const p = this.#get(h);
    const doc = p.store.doc;
    const top = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    // A group or stitched clip shows what its first frame shows.
    const shown = top && this.#mediaShown(top, top.mediaStart ?? 0);
    if (!shown) return undefined;
    const { clip, at } = shown;
    const asset = doc.assets[clip.assetId!]!;
    const stream = Number((clip.props.media as { stream?: number } | undefined)?.stream ?? 0);
    const proxy = p.data.get<{ streams: Record<number, { path: string }> }>(asset.id, "proxy")?.streams[stream];
    const time = asset.kind === "image" ? 0 : ticksToSeconds(at);
    const src = proxy ? { path: proxy.path, stream: 0 } : streamSource(asset.path, asset.derived.media as MediaInfo, "video", stream);
    return this.#cachedThumb(asset, stream, time, height, () => (asset.kind === "image" ? thumbnailPng(asset.path, 0, 0, height) : thumbnailPng(src.path, src.stream, time, height)));
  }

  /** The visual media clip showing at `at` (media time) in `clip`, looking inside groups and stitched clips, top track first; and its media time there. */
  #mediaShown(clip: Clip, at: Ticks): { clip: Clip; at: Ticks } | undefined {
    if (clip.assetId && this.registry.hasTrait(clip.type, "visual") && this.registry.hasTrait(clip.type, "media")) return { clip, at };
    for (const g of this.registry.groupsFor(clip.type)) {
      if (!g.nested || !clip.props[g.id]) continue;
      for (const track of [...g.nested(clip.props[g.id])].reverse()) {
        if (track.hidden) continue;
        const inner = track.clips.find((c) => c.start <= at && at < c.start + c.duration);
        const found = inner && this.#mediaShown(inner, (inner.mediaStart ?? 0) + at - inner.start);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Thumbnails are kept on disk by media file, stream, time and height: a project's are made once, not on
   * every open (the benchmark project's 304 clips cost ~50 s of ffmpeg each time).
   */
  async #cachedThumb(asset: Asset, stream: number, time: number, height: number, make: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const key = Bun.hash(`${asset.path}\0${asset.fingerprint}\0${stream}\0${time.toFixed(3)}\0${height}`).toString(16);
    const file = join(this.cacheDir, "thumbs", `${key}.png`);
    if (existsSync(file)) return new Uint8Array(await Bun.file(file).arrayBuffer());
    const png = await make();
    if (png.length) {
      mkdirSync(dirname(file), { recursive: true });
      await Bun.write(`${file}.${process.pid}.tmp`, png);
      renameSync(`${file}.${process.pid}.tmp`, file);
    }
    return png;
  }

  /** PNG of an asset for the media bin: its first video stream `at` seconds in (a second by default; the screen, for a recording). */
  async assetThumbnail(h: ProjectHandle, assetId: string, height: number, at?: number): Promise<Uint8Array | undefined> {
    const p = this.#get(h);
    const asset = p.store.doc.assets[assetId];
    if (!asset || asset.kind === "audio") return undefined;
    const proxy = p.data.get<{ streams: Record<number, { path: string }> }>(asset.id, "proxy")?.streams[0];
    const time = asset.kind === "image" ? 0 : (at ?? 1);
    const src = proxy ? { path: proxy.path, stream: 0 } : streamSource(asset.path, asset.derived.media as MediaInfo, "video", 0);
    return this.#cachedThumb(asset, -1, time, height, () => thumbnailPng(src.path, src.stream, time, height));
  }

  /** Reported by the app so "canvas.zoom in" can step from the fitted size. */
  setFitPercent(h: ProjectHandle, percent: number) {
    this.#get(h).session.fitPercent = percent;
  }

  async undo(h: ProjectHandle) {
    const p = this.#get(h);
    return this.#saved(p, p.store.undo())?.label;
  }

  async redo(h: ProjectHandle) {
    const p = this.#get(h);
    return this.#saved(p, p.store.redo())?.label;
  }

  /** Autosave after a change; a failed save is the caller's error, not a log line. */
  #saved<T extends { patches: unknown[]; dryRun?: boolean } | undefined>(p: OpenProject, change: T): T {
    if (!this.#autosave || !change || change.dryRun || !change.patches.length) return change;
    try {
      writeProject(p.path, p.store.doc);
      this.#emit(p, { kind: "saved", path: p.path });
    } catch (e) {
      this.#emit(p, { kind: "error", message: `could not save ${p.path}: ${e instanceof Error ? e.message : e}` });
      throw new Error(`the change was made but could not be saved to ${p.path}: ${e instanceof Error ? e.message : e}`);
    }
    return change;
  }

  async history(h: ProjectHandle) {
    return this.#get(h).store.history;
  }

  async query(h: ProjectHandle, name: string, args: unknown = {}): Promise<unknown> {
    const p = this.#get(h);
    if (name === UI_STATE.id) return { session: p.session.state, description: describeSession(p.session.state, p.store.doc) };
    return await this.registry.runQuery(name, args, { project: p.store.doc, registry: this.registry, data: p.data.get });
  }

  async frame(h: ProjectHandle, time: number, opts: FrameOptions = {}): Promise<Image> {
    const p = this.#get(h);
    const doc = p.store.doc;
    return pngImage(p.frames.frame(doc, snapSeconds(time, doc.settings.fps), p.data.get, opts.width ?? 0));
  }

  async captureFrame(h: ProjectHandle, time?: number, opts: { folder?: string } = {}): Promise<{ asset: string; path: string }> {
    const p = this.#get(h);
    const doc = p.store.doc;
    if (opts.folder !== undefined && !existsSync(opts.folder)) throw new Error(`${opts.folder} doesn't exist`);
    const t = snapSeconds(time ?? p.session.state.playhead, doc.settings.fps);
    const img = await this.frame(h, ticksToSeconds(t));
    const dir = opts.folder ?? join(p.path, "media");
    mkdirSync(dir, { recursive: true });
    const fps = Math.round(doc.settings.fps.num / doc.settings.fps.den);
    const frames = Math.round(ticksToSeconds(t) * fps);
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${Math.floor(frames / fps / 3600)}-${two(Math.floor(frames / fps / 60) % 60)}-${two(Math.floor(frames / fps) % 60)}-${two(frames % fps)}`;
    let path = join(dir, `Snapshot ${stamp}.png`);
    for (let n = 2; existsSync(path); n++) path = join(dir, `Snapshot ${stamp} ${n}.png`);
    // The project's own media folder is where snapshots go by default; anywhere else is checked as any write is.
    if (opts.folder !== undefined) this.#checkOutput(h, path);
    writeFileSync(path, img.png);
    const asset = { kind: "image", path, fingerprint: fileFingerprint(path), derived: { media: await probeMedia(path) } };
    const r = this.#saved(p, p.store.run<string>("asset.add", asset, { label: "Snapshot" }));
    return { asset: r.result, path };
  }

  async sheet(h: ProjectHandle, opts: SheetOptions): Promise<Image & { times: number[] }> {
    const p = this.#get(h);
    const doc = p.store.doc;
    const count = Math.min(MAX_SHEET, Math.max(1, Math.round(opts.count)));
    const spaced = Array.from({ length: count }, (_, i) => opts.from + (count === 1 ? 0 : (i * (opts.to - opts.from)) / (count - 1)));
    // The last frame of a range is `to` minus a frame, so a sheet up to the end shows content.
    const last = snapSeconds(opts.to, doc.settings.fps) - ticksPerFrame(doc.settings.fps);
    const ticks = spaced.map((t) => Math.min(last, snapSeconds(t, doc.settings.fps)));
    const img = pngImage(p.frames.sheet(doc, ticks, p.data.get, opts.columns ?? Math.min(count, 4), opts.width ?? 480));
    return { ...img, times: ticks.map((t) => roundSeconds(ticksToSeconds(t))) };
  }

  async checkOutput(h: ProjectHandle, path: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    this.#checkOutput(h, path, opts);
  }

  #checkOutput(h: ProjectHandle, path: string, opts: { overwrite?: boolean } = {}): void {
    const out = resolve(path);
    const doc = this.#get(h).store.doc;
    if (Object.values(doc.assets).some((a) => resolve(a.path) === out)) throw new Error(`${out} is media used by the project; write somewhere else`);
    const bundle = out.split(sep).find((part) => /\.(cmproj|beproj)$/i.test(part));
    if (bundle) throw new Error(`${out} is inside ${bundle}; write outside project folders`);
    if (opts.overwrite || !existsSync(out)) return;
    if (statSync(out).isDirectory() ? readdirSync(out).length > 0 : true) throw new Error(`${out} already exists; pass overwrite to replace it`);
  }

  async export(h: ProjectHandle, opts: ExportOptions): Promise<Job> {
    const p = this.#get(h);
    const project = p.store.doc;
    const output = resolve(opts.output);
    this.#checkOutput(h, output, { overwrite: opts.overwrite });
    // Refused before the job starts, not after a render.
    if (!opts.output.endsWith("/") && videoFormat(output) === "mp4" && opts.codec === "prores") throw new Error("ProRes exports to .mov, not .mp4");
    // Edits made while it renders must not reach the export, its derived data included.
    const data = new DerivedData(this.registry, this.cacheDir, () => project, this.#pref);
    // Beside a video, files features write from the same range (captions as .srt), named after it.
    const range = { from: opts.from ?? 0, to: opts.to ?? ticksToSeconds(projectDuration(project)) };
    const sides = opts.output.endsWith("/")
      ? []
      : [...this.registry.exportFiles.values()].flatMap((f) => {
          const text = f.write(range, { project, registry: this.registry, data: data.get });
          return text === undefined ? [] : [{ path: join(dirname(output), basename(output, extname(output)) + f.extension), text }];
        });
    for (const f of sides) this.#checkOutput(h, f.path, { overwrite: opts.overwrite });
    return this.#startJob(p, "export", `Export ${basename(output)}`, async (progress) => {
      const from = opts.from === undefined ? undefined : secondsToTicks(opts.from);
      const to = opts.to === undefined ? undefined : secondsToTicks(opts.to);
      const { frames } = await renderProject(project, this.registry, {
        output: opts.output.endsWith("/") ? { kind: "png", dir: output } : { kind: "video", ...encoding(opts), path: output },
        from,
        to,
        cacheDir: this.cacheDir,
        data: data.get,
        onProgress: (f, total) => progress(f / total),
      });
      for (const f of sides) writeFileSync(f.path, f.text);
      return { output, frames, seconds: ticksToSeconds((to ?? projectDuration(project)) - (from ?? 0)), ...(sides.length ? { files: sides.map((f) => f.path) } : {}) };
    });
  }

  /** All or nothing: every file is probed first, then they are added in one undo step. */
  async import(h: ProjectHandle, files: string[], opts: ImportOptions = {}): Promise<ImportResult> {
    const p = this.#get(h);
    const result: ImportResult = { assets: [], clips: [], jobs: [] };
    const probed: { file: string; importer: MediaImporterDef; asset: Omit<Asset, "id"> }[] = [];
    for (const file of files.map((f) => resolve(f))) {
      const importer = this.registry.importerFor(extname(file));
      if (!importer) throw new Error(`no feature imports ${extname(file) || "files without an extension"} (${file})`);
      const media = await probeMedia(file);
      const loudness = await measureLoudness(file, media);
      probed.push({ file, importer, asset: { kind: importer.kind, path: file, fingerprint: fileFingerprint(file), derived: { media, ...(Object.keys(loudness).length ? { loudness } : {}) } } });
    }
    let at = opts.at === undefined ? projectDuration(p.store.doc) : secondsToTicks(opts.at);
    const label = probed.length === 1 ? `Import ${basename(probed[0]!.file)}` : `Import ${probed.length} files`;
    const copies = p.store.doc.settings.standalone ? await this.#copyIn(p.path, probed.map(({ asset }, i) => ({ id: String(i), ...asset }))) : [];
    for (const { id, path, fingerprint } of copies) Object.assign(probed[Number(id)]!.asset, { path, fingerprint });
    try {
      this.#saved(p, p.store.transaction(label, (tx) => {
        for (const { importer, asset } of probed) {
          const id = tx.run<string>("asset.add", asset);
          result.assets.push(id);
          result.clips.push(...tx.run<string[]>("asset.place", { asset: id, time: ticksToSeconds(at), ...(opts.track ? { track: opts.track } : {}) }));
          at += Math.max(0, ...importer.clips({ id, ...asset }, p.store.doc).map((s) => s.duration));
        }
      }));
    } catch (e) {
      for (const c of copies) rmSync(c.path, { recursive: true, force: true });
      throw e;
    }
    // The app's view needs proxies and waveforms of new media as well.
    if (p.view) this.#previewJobs(p);
    const { jobs, needs } = this.#importAnalyses(h, result.assets);
    result.jobs.push(...jobs);
    return needs ? { ...result, needs } : result;
  }

  /**
   * Starts the analyses new media gets (transcripts), except those waiting for a resource that isn't downloaded:
   * those are reported, to the caller and as a `needs` event, and start when it arrives.
   */
  #importAnalyses(h: ProjectHandle, assets: string[]): { jobs: string[]; needs?: string[] } {
    const p = this.#get(h);
    const jobs: string[] = [];
    const needs = new Set<string>();
    for (const id of assets) {
      for (const def of this.registry.jobAnalyzers.values()) {
        const a = p.store.doc.assets[id]!;
        if ((def.when ?? "import") !== "import" || !def.applies(a) || p.data.has(a, def.id) || !this.#automatic(def.id, a)) continue;
        const need = this.#needsOf(def);
        if (need && !this.#resourceReady(need)) needs.add(need);
        else if (existsSync(a.path)) jobs.push(this.#analyze(h, def.id, id).id);
      }
    }
    for (const id of needs) this.#emit(p, { kind: "needs", resource: this.#resourceInfo(this.registry.resources.get(id)!) });
    return needs.size ? { jobs, needs: [...needs] } : { jobs };
  }

  async analyze(h: ProjectHandle, key: string, assetId: string): Promise<Job> {
    return this.#analyze(h, key, assetId);
  }

  async forget(h: ProjectHandle, key: string, assetId: string): Promise<boolean> {
    const p = this.#get(h);
    const def = this.#jobAnalyzer(key);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const subject = `${key}:${asset.path}\0${asset.fingerprint}`;
    for (const j of this.#jobs.values()) if (j.subject === subject && j.info.state === "running") await this.cancelJob(j.info.id).then(() => j.done).catch(() => {});
    const had = p.data.drop(asset, def);
    this.#emit(p, { kind: "derived", asset: assetId, key, present: false });
    if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
    return had;
  }

  #jobAnalyzer(key: string) {
    const def = this.registry.jobAnalyzers.get(key);
    if (!def) throw new Error(`no background analyzer "${key}"; there are: ${[...this.registry.jobAnalyzers.keys()].join(", ")}`);
    return def;
  }

  /** The analyzer's cached results of every version, and its folder. */
  #analysisFiles(key: string): string[] {
    const def = this.#jobAnalyzer(key);
    const derived = join(this.cacheDir, "derived");
    const results = existsSync(derived) ? readdirSync(derived).filter((f) => f.startsWith(`${key}-v`) && /^\d+(-[a-z0-9]+)?-[0-9a-f]{16}\.json$/.test(f.slice(key.length + 2))).map((f) => join(derived, f)) : [];
    return def.folder ? [...results, join(this.cacheDir, def.folder)] : results;
  }

  #recorder = new Recorder();
  #recording?: { h: ProjectHandle; dir: string; narration?: Narration };
  #lastNarration?: RecordResult;

  async recorderDevices() {
    return this.#recorder.devices();
  }

  async recorderAccess(kind: "camera" | "microphone") {
    return this.#recorder.access(kind);
  }

  async recorderSetOutput(output: string) {
    return this.#recorder.setOutput(output);
  }

  async recorderPreview(sources: RecorderSources, fn?: (e: RecorderPreviewEvent) => void) {
    return this.#recorder.preview(sources, fn);
  }

  async recordStart(h: ProjectHandle, opts: RecordOptions = {}): Promise<{ take: string }> {
    const p = this.#get(h);
    if (this.#recording) throw new Error(`already recording ${basename(this.#recording.dir)}`);
    if (opts.narrate) return this.#narrate(p, opts);
    const sources: RecorderSources = opts.sources ?? { screen: {}, microphone: {}, systemAudio: true };
    const dir = join(p.path, "recordings", `${opts.name ?? takeName(new Date())}.brec`);
    mkdirSync(dirname(dir), { recursive: true });
    await this.#recorder.start(dir, sources, opts.monitor);
    this.#recording = { h, dir };
    return { take: dir };
  }

  /** Records the microphone while the app's view plays the timeline from the playhead, or through the range. */
  async #narrate(p: OpenProject, opts: RecordOptions): Promise<{ take: string }> {
    const view = p.view;
    if (!view) throw new Error("a narration plays the timeline in the Beacon app: open the project there");
    const { screen, camera, systemAudio, microphone, ...rest } = opts.sources ?? { microphone: {} };
    if (screen || camera || systemAudio) throw new Error("a narration records only a microphone");
    const doc = p.store.doc;
    const frame = ticksToSeconds(ticksPerFrame(doc.settings.fps));
    const { range, playhead } = p.session.state;
    const from = range?.in ?? playhead;
    const until = range?.out ?? ticksToSeconds(projectDuration(doc));
    // Nothing to play after the playhead (an empty timeline, or the playhead on its last frame): it records there until stopped.
    const still = from >= until - frame * 1.5;
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
      if (playhead !== from) p.session.run("playhead.set", { time: from }, p.store.doc);
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

  async recordSyncCheck(sources: RecorderSources, show: () => Promise<void>) {
    if (this.#recording) throw new Error(`recording ${basename(this.#recording.dir)}: stop it first`);
    const dir = join(this.cacheDir, "sync-check", `${takeName(new Date())}.brec`);
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

  async recordStatus(): Promise<RecordStatus> {
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

  async recordStop(opts: RecordStopOptions = {}): Promise<RecordResult> {
    const rec = this.#recording;
    if (!rec) throw new Error("not recording");
    this.#recording = undefined;
    const p = this.#projects.get(rec.h);
    const n = rec.narration;
    // Read before playback stops: pausing lets go of the audio clock.
    const heard = n && (p?.view?.heard() ?? n.heard);
    if (n && p) {
      if (p.session.state.playing) p.session.run("playback.pause", {}, p.store.doc);
      if (p.view) p.view.muted = false;
    }
    const take = await this.#recorder.stop();
    if (take.errors.length) console.warn(`recording ${basename(rec.dir)}: ${take.errors.join("; ")}`);
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
      result = { ...(await this.#placeNarration(rec.h, rec.dir, at, n.from)), take: rec.dir, duration: take.duration };
    } else return { ...(await this.import(rec.h, [rec.dir], opts)), take: rec.dir, duration: take.duration };
    if (n && p) {
      this.#lastNarration = result;
      this.#emit(p, { kind: "narrated", result });
    }
    return result;
  }

  /**
   * A narration on a new track at `from`, starting as far into its file as the timeline was heard after the
   * microphone began, so each word sits under what was playing as it was spoken. One undo step.
   */
  async #placeNarration(h: ProjectHandle, dir: string, at: number, from: number): Promise<ImportResult> {
    const p = this.#get(h);
    const file = resolve(dir);
    const importer = this.registry.importerFor(".brec")!;
    const media = await probeMedia(file);
    const loudness = await measureLoudness(file, media);
    const asset: Omit<Asset, "id"> = { kind: importer.kind, path: file, fingerprint: fileFingerprint(file), derived: { media, ...(Object.keys(loudness).length ? { loudness } : {}) } };
    const fps = p.store.doc.settings.fps;
    // The clip begins at `from`, or later if the take began after it.
    const start = Math.max(ticksToSeconds(snapSeconds(from, fps)), ticksToSeconds(snapSeconds(at, fps, "ceil")));
    const result: ImportResult = { assets: [], clips: [], jobs: [] };
    this.#saved(p, p.store.transaction("Record Narration", (tx) => {
      const id = tx.run<string>("asset.add", asset);
      const [spec] = importer.clips({ id, ...asset }, p.store.doc);
      if (!spec) throw new Error(`${basename(dir)} has no audio`);
      const track = tx.run<string>("track.add", { name: "Narration" });
      const mediaStart = start - at + ticksToSeconds(spec.mediaStart ?? 0);
      const duration = ticksToSeconds(spec.duration) - (start - at);
      result.assets.push(id);
      result.clips.push(tx.run<string>("clip.add", { track, type: spec.type, start, duration, mediaStart, assetId: id, props: spec.props }));
    }));
    if (p.view) this.#previewJobs(p);
    const { jobs, needs } = this.#importAnalyses(h, result.assets);
    result.jobs.push(...jobs);
    return needs ? { ...result, needs } : result;
  }

  async missing(h: ProjectHandle): Promise<string[]> {
    return Object.values(this.#get(h).store.doc.assets).filter((a) => !existsSync(a.path)).map((a) => a.id);
  }

  async relink(h: ProjectHandle, assetId: string, path: string): Promise<void> {
    const p = this.#get(h);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const file = resolve(path);
    if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
    if (this.registry.importerFor(extname(file))?.kind !== asset.kind) throw new Error(`${basename(file)} isn't the same kind of media as ${basename(asset.path)}`);
    const was = asset.derived.media as Awaited<ReturnType<typeof probeMedia>> | undefined;
    const now = await probeMedia(file);
    const shape = (m: typeof now) => m.streams.map((s) => `${s.kind}:${s.width ?? ""}x${s.height ?? ""}`).join(",");
    if (was && (shape(was) !== shape(now) || Math.abs(was.duration - now.duration) > 0.1)) {
      throw new Error(`${basename(file)} isn't the same media as ${basename(asset.path)}: its streams or length differ`);
    }
    this.#saved(p, p.store.run("asset.relink", { asset: assetId, path: file, fingerprint: fileFingerprint(file) }, { label: `Locate ${basename(file)}` }));
    if (p.view) this.#previewJobs(p);
  }

  async replace(h: ProjectHandle, assetId: string, path: string): Promise<{ jobs: string[]; needs?: string[] }> {
    const p = this.#get(h);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const file = resolve(path);
    if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
    const kind = this.registry.importerFor(extname(file))?.kind;
    if (asset.kind === "recording") throw new Error(`${assetName(asset)} is a recording: it can't be replaced`);
    const like = { video: "video", image: "image", audio: "audio file" }[asset.kind];
    if (kind !== asset.kind) throw new Error(`${assetName(asset)} can only be replaced with another ${like}`);
    const media = await probeMedia(file);
    const loudness = await measureLoudness(file, media);
    const derived = { media, ...(Object.keys(loudness).length ? { loudness } : {}) };
    this.#saved(p, p.store.run("asset.replace", { asset: assetId, path: file, fingerprint: fileFingerprint(file), derived }, { label: `Replace with ${basename(file)}` }));
    if (p.view) this.#previewJobs(p);
    return this.#importAnalyses(h, [assetId]);
  }

  async analysisSize(key: string): Promise<number> {
    const sizes = await Promise.all(this.#analysisFiles(key).map(diskSize));
    return sizes.reduce((n, b) => n + b, 0);
  }

  async forgetAll(key: string): Promise<number> {
    const def = this.#jobAnalyzer(key);
    for (const p of this.#projects.values()) {
      const q = this.#previewQueues.get(p);
      q?.todo.splice(0, q.todo.length, ...q.todo.filter((i) => i.def.id !== key));
    }
    const running = [...this.#jobs.values()].filter((j) => j.info.kind === key && j.info.state === "running");
    for (const j of running) this.#cancelJob(j);
    await Promise.all(running.map((j) => j.done.catch(() => {})));
    const before = await this.analysisSize(key);
    for (const file of this.#analysisFiles(key)) {
      if (!file.endsWith(".json")) continue;
      // Without a folder, the result names the files it made.
      if (!def.folder) {
        try {
          def.discard?.(JSON.parse(readFileSync(file, "utf8")));
        } catch {}
      }
      rmSync(file, { force: true });
    }
    if (def.folder) rmSync(join(this.cacheDir, def.folder), { recursive: true, force: true });
    for (const p of this.#projects.values()) {
      p.data.dropAll(def);
      for (const asset of Object.values(p.store.doc.assets)) if (def.applies(asset)) this.#emit(p, { kind: "derived", asset: asset.id, key, present: false });
      if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
    }
    return before - (await this.analysisSize(key));
  }

  #analyze(h: ProjectHandle, key: string, assetId: string): Job {
    const p = this.#get(h);
    const def = this.#jobAnalyzer(key);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    if (!existsSync(asset.path)) throw new Error(`${basename(asset.path)} is missing: it was moved, renamed or deleted (Locate… in the Media Bin's menu finds it)`);
    const variant = def.variant?.(this.#pref);
    const subject = `${key}:${asset.path}\0${asset.fingerprint}${variant ? `\0${variant}` : ""}`;
    const running = [...this.#jobs.values()].find((j) => j.subject === subject && j.info.state === "running");
    if (running) return { id: running.info.id, done: running.done };
    const need = this.#needsOf(def);
    if (need && !this.#resourceReady(need)) {
      const r = this.registry.resources.get(need)!;
      throw new Error(`${key} needs the ${r.title} (${Math.round(r.bytes / 1e6)} MB), which isn't downloaded; download it (fetchResource "${r.id}") once the user agrees`);
    }
    return this.#startJob(
      p,
      key,
      `${key} ${asset.path}`,
      async (progress) => {
        const value = await def.analyze(asset, progress, {
          cacheDir: this.cacheDir,
          quiet: this.#jobMode === "quiet",
          resource: (id) => this.#resourcePath(this.registry.resources.get(id)!),
          pref: this.#pref,
          secret: (id) => this.#secrets.get(id),
        });
        // Made for the variant it started under (a transcriber since changed): stored there it would be taken for the new one's.
        if (def.variant?.(this.#pref) !== variant) throw new Error(`${key} was for a setting since changed`);
        jobSignal()?.throwIfAborted();
        p.data.store(asset, def, value);
        this.#emit(p, { kind: "derived", asset: assetId, key, present: true });
        return { asset: assetId };
      },
      subject,
      assetId,
    );
  }

  #startJob(p: OpenProject | undefined, kind: string, label: string, fn: (progress: (f: number) => void) => Promise<unknown>, subject?: string, asset?: string): Job {
    const id = shortId("job");
    const entry: JobEntry = { info: { id, kind, label, state: "running", progress: 0, ...(asset ? { asset } : {}) }, ...(p ? { project: p.path } : {}), processes: { procs: new Set(), cancelled: false, abort: new AbortController() }, subject, started: performance.now(), done: Promise.resolve() };
    const report = () => {
      const e = { kind: "job" as const, job: this.#job(id) };
      if (p) this.#emit(p, e);
      for (const l of this.#jobListeners) l(e.job);
    };
    // Progress is reported each whole percent, so a window can show it without a flood of events.
    let shown = 0;
    this.#forgetFinishedJobs();
    entry.done = jobProcesses
      .run(entry.processes, () =>
        fn((f) => {
          entry.info.progress = Math.min(1, Math.max(0, f));
          if (Math.floor(entry.info.progress * 100) > shown) {
            shown = Math.floor(entry.info.progress * 100);
            report();
          }
        }),
      )
      .then(
      (result) => {
        Object.assign(entry.info, { state: "done", progress: 1, result });
        report();
        return result;
      },
      (err: unknown) => {
        Object.assign(entry.info, { state: "failed", error: entry.processes.cancelled ? "cancelled" : err instanceof Error ? err.message : String(err) });
        report();
        throw entry.processes.cancelled ? new Error(`${label}: cancelled`) : err;
      },
    );
    // Failures are read through job(); an unawaited rejection must not crash the process.
    entry.done.catch(() => {});
    this.#jobs.set(id, entry);
    report();
    return { id, done: entry.done };
  }

  /** Stops a running job: kills its processes, so it fails as "cancelled". */
  #cancelJob(entry: JobEntry) {
    if (entry.info.state !== "running") return;
    entry.processes.cancelled = true;
    entry.processes.abort?.abort();
    for (const proc of entry.processes.procs) proc.kill();
  }

  #cancelJobsOf(path: string | undefined, which: (j: JobEntry) => boolean = () => true) {
    for (const j of this.#jobs.values()) if ((path === undefined || j.project === path) && which(j)) this.#cancelJob(j);
  }

  #forgetFinishedJobs() {
    const finished = [...this.#jobs.entries()].filter(([, j]) => j.info.state !== "running");
    for (const [id] of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_JOBS))) this.#jobs.delete(id);
  }

  #resourcePath(def: ResourceDef): string {
    return join(this.cacheDir, def.folder, def.file);
  }

  /** Its hash was checked when it was downloaded; after that, being there is enough. */
  #resourceReady(id: string): boolean {
    return existsSync(this.#resourcePath(this.registry.resources.get(id)!));
  }

  #resourceInfo(def: ResourceDef): ResourceInfo {
    const job = [...this.#jobs.values()].find((j) => j.subject === `resource:${def.id}` && j.info.state === "running");
    return { id: def.id, title: def.title, description: def.description, bytes: def.bytes, present: this.#resourceReady(def.id), ...(job ? { job: job.info.id } : {}) };
  }

  #needsOf(def: JobAnalyzerDef): string | undefined {
    return typeof def.needs === "function" ? def.needs(this.#pref) : def.needs;
  }

  async preferences(): Promise<PreferenceInfo[]> {
    return Promise.all(
      [...this.registry.preferences.values()].map(async (def) => ({
        id: def.id,
        title: def.title,
        description: def.description,
        value: this.#pref(def.id),
        options: await Promise.all(
          def.options.map(async (o) => ({
            id: o.id,
            title: o.title,
            description: o.description,
            ...(o.secret ? { secret: { id: o.secret, title: this.registry.secrets.get(o.secret)!.title, set: (await this.#secrets.get(o.secret)) !== undefined } } : {}),
          })),
        ),
      })),
    );
  }

  async setPreference(id: string, value: string): Promise<void> {
    const def = this.registry.preferences.get(id);
    if (!def) throw new Error(`no preference "${id}"; there are: ${[...this.registry.preferences.keys()].join(", ")}`);
    const option = def.options.find((o) => o.id === value);
    if (!option) throw new Error(`${def.title}: "${value}" isn't one of ${def.options.map((o) => `"${o.id}"`).join(", ")}`);
    if (option.secret && (await this.#secrets.get(option.secret)) === undefined) {
      throw new Error(`${option.title} needs the ${this.registry.secrets.get(option.secret)!.title}, which only the user can add (Settings › General)`);
    }
    if (this.#pref(id) === value) return;
    this.#prefs = { ...this.#prefs, [id]: value };
    mkdirSync(this.#configDir, { recursive: true });
    const file = join(this.#configDir, "preferences.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(this.#prefs, null, 2));
    renameSync(`${file}.tmp`, file);
    const decided = new Set([...this.registry.jobAnalyzers.values()].filter((d) => d.variant).map((d) => d.id));
    this.#cancelJobsOf(undefined, (j) => decided.has(j.info.kind));
    for (const p of this.#projects.values()) {
      this.#emit(p, { kind: "preference", id, value });
      this.#importAnalyses(p.path, Object.keys(p.store.doc.assets));
    }
  }

  /** What a new user's Favorites panel holds. */
  static readonly DEFAULT_FAVORITES = ["annotation:text", "annotation:rectangle", "annotation:spotlight", "effect:round-corners", "effect:crt-monitor", "effect:drop-shadow", "effect:motion-blur"];

  #favorites(): string[] {
    try {
      const items = JSON.parse(readFileSync(join(this.#configDir, "favorites.json"), "utf8")) as unknown;
      if (Array.isArray(items)) return items.filter((i): i is string => typeof i === "string" && this.#favoriteKnown(i));
    } catch {}
    return LocalCore.DEFAULT_FAVORITES.filter((i) => this.#favoriteKnown(i));
  }

  /** An item the panels have: an annotation preset, an effect (not a cursor-only one), or an audio fade. */
  #favoriteKnown(item: string): boolean {
    const [kind, id = ""] = item.split(":", 2);
    if (kind === "annotation") return annotationPresets().includes(id);
    if (kind === "effect") return this.registry.effects.has(id);
    return kind === "audio" && (id === "fade-in" || id === "fade-out");
  }

  #saveFavorites(items: string[]): string[] {
    mkdirSync(this.#configDir, { recursive: true });
    const file = join(this.#configDir, "favorites.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(items, null, 2));
    renameSync(`${file}.tmp`, file);
    for (const p of this.#projects.values()) this.#emit(p, { kind: "favorites", items });
    return items;
  }

  async favorites(): Promise<string[]> {
    return this.#favorites();
  }

  async favoriteAdd(item: string, index?: number): Promise<string[]> {
    if (!this.#favoriteKnown(item)) throw new Error(`"${item}" isn't an item of the panels: annotation:<preset> (${annotationPresets().join(", ")}), effect:<id> or audio:fade-in / audio:fade-out`);
    const items = this.#favorites();
    if (items.includes(item)) return items;
    items.splice(index === undefined ? items.length : Math.max(0, Math.min(index, items.length)), 0, item);
    return this.#saveFavorites(items);
  }

  async favoriteRemove(item: string): Promise<string[]> {
    const items = this.#favorites();
    if (!items.includes(item)) return items;
    return this.#saveFavorites(items.filter((i) => i !== item));
  }

  async favoriteMove(item: string, index: number): Promise<string[]> {
    const items = this.#favorites();
    const from = items.indexOf(item);
    if (from < 0) throw new Error(`"${item}" isn't a favourite; there are: ${items.join(", ")}`);
    items.splice(from, 1);
    items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
    return this.#saveFavorites(items);
  }

  /** Sets or removes a secret (an API key): the app's Settings, never agents. Removed, a choice that needs it goes back to its default. */
  async setSecret(id: string, value: string | null): Promise<void> {
    if (!this.registry.secrets.has(id)) throw new Error(`no secret "${id}"`);
    await this.#secrets.set(id, value);
    if (value !== null) return;
    for (const def of this.registry.preferences.values()) {
      if (def.options.find((o) => o.id === this.#pref(def.id))?.secret === id) await this.setPreference(def.id, def.default);
    }
  }

  async resources(): Promise<ResourceInfo[]> {
    return [...this.registry.resources.values()].map((def) => this.#resourceInfo(def));
  }

  async fetchResource(id: string): Promise<Job> {
    const def = this.registry.resources.get(id);
    if (!def) throw new Error(`no resource "${id}"; there are: ${[...this.registry.resources.keys()].join(", ")}`);
    const subject = `resource:${id}`;
    const running = [...this.#jobs.values()].find((j) => j.subject === subject && j.info.state === "running");
    if (running) return { id: running.info.id, done: running.done };
    const path = this.#resourcePath(def);
    return this.#startJob(undefined, "resource", `Download ${def.title}`, async (progress) => {
      if (!this.#resourceReady(id)) await download(def, path, progress);
      this.#resumeWaiting(id);
      return { path };
    }, subject);
  }

  /** A resource arrived: the analyses that were waiting for it start, in every open project. */
  #resumeWaiting(resource: string) {
    for (const p of this.#projects.values()) {
      for (const def of this.registry.jobAnalyzers.values()) {
        if (this.#needsOf(def) !== resource || (def.when ?? "import") !== "import") continue;
        for (const a of Object.values(p.store.doc.assets)) if (def.applies(a) && !p.data.has(a, def.id) && existsSync(a.path)) this.#analyze(p.path, def.id, a.id);
      }
    }
  }

  async job(id: string): Promise<JobInfo> {
    return this.#job(id);
  }

  #job(id: string): JobInfo {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`no job "${id}"`);
    return { ...j.info, elapsed: Number(((performance.now() - j.started) / 1000).toFixed(1)) };
  }

  async cancelJob(id: string): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`no job "${id}"`);
    this.#cancelJob(j);
  }

  async jobs(): Promise<JobInfo[]> {
    return [...this.#jobs.keys()].map((id) => this.#job(id));
  }

  commands(): CommandInfo[] {
    const owner = this.#owners();
    return [
      ...[...this.registry.commands.values()].map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: owner.get(c.id) ?? "core" })),
      ...SESSION_COMMANDS.map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: "session" })),
      ...[...this.registry.sessionCommands.values()].map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: owner.get(c.id) ?? "session" })),
      ...[...this.registry.actions.values()].map((a) => ({ id: a.id, description: a.description, args: jsonSchemaOf(a.args), feature: owner.get(a.id) ?? "core" })),
    ];
  }

  queries(): QueryInfo[] {
    const owner = this.#owners();
    return [UI_STATE, ...this.registry.queries.values()].map((q) => ({
      id: q.id,
      description: q.description,
      args: jsonSchemaOf(q.args),
      feature: q === UI_STATE ? "session" : (owner.get(q.id) ?? "core"),
      ...(q.resource ? { resource: q.resource } : {}),
      ...(q.summary ? { summary: true } : {}),
    }));
  }

  /** Command and query id → the feature that registered it; core's own are absent. */
  #owners(): Map<string, string> {
    return new Map([...this.registry.features.values()].flatMap((f) => [...(f.commands ?? []), ...(f.queries ?? []), ...(f.actions ?? []), ...(f.sessionCommands ?? [])].map((x) => [x.id, f.id] as const)));
  }

  /** The registered summary query's text, if any. */
  async summary(h: ProjectHandle): Promise<string> {
    const q = [...this.registry.queries.values()].find((x) => x.summary);
    return q ? String(await this.query(h, q.id)) : `project ${h}`;
  }

  schema(): SchemaInfo {
    const r = this.registry;
    return {
      clipTypes: [...r.clipTypes.values()].map((t) => ({
        id: t.id,
        description: t.description,
        traits: t.traits,
        props: r.groupsFor(t.id).map((g) => g.id),
        effects: [...r.effects.values()].filter((e) => e.traits.some((x) => t.traits.includes(x))).map((e) => e.id),
        ...((g) => (g ? { nested: g.id } : {}))(r.groupsFor(t.id).find((g) => g.nested)),
      })),
      props: [...r.propGroups.values()].map((g) => ({ id: g.id, description: g.description, animatable: g.animatable ?? [], schema: jsonSchemaOf(g.schema) })),
      effects: [...r.effects.values()].map((e) => ({ id: e.id, description: e.description, traits: e.traits, schema: jsonSchemaOf(e.params) })),
    };
  }

  readonly #jobListeners = new Set<(job: JobInfo) => void>();

  /** Every job's changes, whichever project started it, and after that project is closed (an export carries on). */
  watchJobs(fn: (job: JobInfo) => void): () => void {
    this.#jobListeners.add(fn);
    return () => this.#jobListeners.delete(fn);
  }

  watch(h: ProjectHandle, fn: (e: CoreEvent) => void): () => void {
    const p = this.#get(h);
    p.listeners.add(fn);
    return () => p.listeners.delete(fn);
  }
}

/** Width and height from the PNG header. */
function pngImage(png: Uint8Array): Image {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { png, width: v.getUint32(16), height: v.getUint32(20) };
}
