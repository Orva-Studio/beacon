import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { importCmproj } from "@beacon/camtasia";
import { createRegistry } from "@beacon/features";
import { fileFingerprint, pastePng, probeMedia, type RecorderPreviewEvent, type RecorderSources } from "@beacon/media";
import {
  changedSettings,
  createProject,
  describeSession,
  formatIssues,
  type ActionDef,
  type SharedSession,
  editScope,
  nestedOf,
  projectDuration,
  ProjectStore,
  roundSeconds,
  secondsToTicks,
  SessionStore,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type CommandResult,
  type Asset,
  type FeatureRegistry,
  type MediaImporterDef,
  type Project,
  type Session,
  type SessionChange,
  placeCanvas,
  rationalToNumber,
  scopedProject,
  assetName,
  type Keys,
  type ShortcutInfo,
  type AppSettings,
  SETTINGS_TABS,
  type SettingsTab,
  type SettingsPatch,
} from "@beacon/model";
import { DEFAULT_CACHE_DIR, DerivedData, FrameRenderer, LiveView, renderProject, videoFormat, type ViewTarget } from "@beacon/render";
import type {
  AssetPreview,
  CommandInfo,
  AppEvent,
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
  UiDialog,
} from "./api";
import { Analyses } from "./analyses";
import { AppConfig } from "./config";
import { Jobs } from "./jobs";
import { keychain, type Secrets } from "./keychain";
import { copyFollowingLinks, copyIntoProject, isInside } from "./media-copy";
import { lock, projectName, readProject, unlock, writeProject } from "./persist";
import { probeAsset, shortId, type CoreParts, type OpenProject } from "./project";
import { Recording } from "./recording";
import { registryInfo, UI_STATE } from "./registry-info";
import { assetThumbnail, clipThumbnail } from "./thumbnails";

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

const PLAYBACK = new Set(["playback.play", "playback.toggle", "playback.shuttle"]);

const MAX_SHEET = 100;

/** The encoding options of an export call, without its other fields. */
const encoding = ({ output: _, overwrite: _o, from: _f, to: _t, ...rest }: ExportOptions) => rest;

/** In-process core: owns the documents, runs the engine, reads and writes `.beproj` folders (PLAN §7.1). */
export class LocalCore implements BeaconCore {
  readonly registry: FeatureRegistry;
  readonly cacheDir: string;
  readonly #autosave: boolean;
  readonly #socket?: string;
  readonly #reveal: (path: string) => void;
  readonly #projects = new Map<ProjectHandle, OpenProject>();
  /** Every background job: exports, analyses, downloads. */
  readonly #jobs = new Jobs((e) => {
    for (const l of this.#appListeners) l(e);
  });
  /** The last copies in any project, so they paste into the next one opened. */
  #shared: SharedSession = { clipboard: null, properties: null };

  /** Preferences, favourites, settings and keys, and the secrets. */
  readonly #config: AppConfig;
  readonly #pref: (id: string) => string;
  readonly #parts: CoreParts;
  readonly #analyses: Analyses;
  readonly #recording: Recording;

  constructor(opts: LocalCoreOptions = {}) {
    this.registry = opts.registry ?? createRegistry();
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    // BEACON_CONFIG_DIR: tests keep the user's preferences, settings and keys out of their runs (bunfig's preload).
    this.#config = new AppConfig(opts.configDir ?? process.env.BEACON_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, this.registry, opts.secrets ?? keychain, (e) => {
      for (const l of this.#appListeners) l(e);
    });
    this.#pref = this.#config.pref;
    this.#autosave = opts.autosave ?? true;
    this.#socket = opts.socket;
    this.#reveal = opts.reveal ?? ((path) => void Bun.spawn(["/usr/bin/open", "-R", path]));
    this.#parts = {
      registry: this.registry,
      cacheDir: this.cacheDir,
      get: (h) => this.#get(h),
      find: (h) => this.#projects.get(h),
      projects: () => this.#projects.values(),
      emit: (p, e) => this.#emit(p, e),
      saved: (p, change) => this.#saved(p, change),
      startJob: (p, kind, label, fn, subject, asset) =>
        this.#jobs.start(kind, label, fn, { ...(p ? { project: p.path, report: (e) => this.#emit(p, e) } : {}), ...(subject ? { subject } : {}), ...(asset ? { asset } : {}) }),
    };
    this.#analyses = new Analyses(this.#parts, this.#jobs, this.#config, (fn) => this.watchApp(fn));
    this.#recording = new Recording(this.#parts, this.#config, this.#analyses, (h, files, o) => this.import(h, files, o));
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
      doc = { ...project, settings: changedSettings(project.settings, opts.settings ?? {}) };
    } else {
      const created = createProject(this.registry);
      doc = { ...created, settings: changedSettings(created.settings, opts.settings ?? {}) };
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
    // A take being recorded for it is stopped and imported first, rather than left in its folder; one that can't be
    // (a narration stopped before it played) mustn't keep the project open and locked.
    let stopped: unknown;
    if (this.#recording.recordingFor(h)) await this.recordStop().catch((e: unknown) => void (stopped = e));
    const p = this.#get(h);
    clearTimeout(p.saveTimer);
    // Exports render a copy of the document taken when they started: they finish after the project closes.
    this.#jobs.cancelOf(p.path, (j) => j.info.kind !== "export");
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
    if (stopped) throw new Error(`closed ${p.path}, but the take being recorded couldn't be placed: ${stopped instanceof Error ? stopped.message : stopped}`);
  }

  /**
   * Renames the project's folder to `name`.beproj beside it, closing it first (its undo history ends there);
   * media kept inside it (recordings, snapshots) follow. Returns the new path, for `open`.
   */
  async rename(h: ProjectHandle, name: string): Promise<string> {
    const p = this.#get(h);
    const to = join(dirname(p.path), `${projectName(name)}.beproj`);
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
    this.#jobs.cancelOf(undefined);
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
    this.#recording.sessionChanged(p, session, changed);
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

  #uiOpener?: (h: ProjectHandle, dialog: UiDialog | null, tab?: SettingsTab) => void;

  /** The app's window, which shows the dialogs `uiOpen` asks for. */
  setUiOpener(fn: ((h: ProjectHandle, dialog: UiDialog | null, tab?: SettingsTab) => void) | undefined) {
    this.#uiOpener = fn;
  }

  async uiOpen(h: ProjectHandle, dialog: UiDialog | null, tab?: string): Promise<void> {
    this.#get(h);
    if (!this.#uiOpener) throw new Error("no window shows this project: dialogs open only with the project open in the Beacon app");
    if (tab !== undefined && dialog !== "settings") throw new Error(`\`tab\` is Settings' (${SETTINGS_TABS.join(", ")})`);
    if (tab !== undefined && !(SETTINGS_TABS as readonly string[]).includes(tab)) throw new Error(`Settings has no "${tab}" tab: ${SETTINGS_TABS.join(", ")}`);
    this.#uiOpener(h, dialog, tab as SettingsTab | undefined);
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
        this.#recording.ticked(p, view, t);
      },
      onEnd: () => p.session.run("playback.pause", {}, p.store.doc),
      silent: opts.silent,
    });
    p.view = view;
    view.show(p.session.state.playhead);
    if (opts.proxies ?? "layer" in target) {
      this.#analyses.previewJobs(p);
      // Transcripts an import started but a quit cancelled: made now, not when Remove Silences or Captions needs one.
      this.#analyses.importAnalyses(p, Object.keys(p.store.doc.assets));
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

  /**
   * Narrows which analyses start on their own, on import, when shown or when a preference changes (proxies already
   * follow Settings › General); projects shown now follow at once.
   */
  setAutomatic(fn: (analyzer: string, asset: Asset) => boolean) {
    this.#analyses.setAutomatic(fn);
  }

  /** The project's view, while one is attached. */
  view(h: ProjectHandle): LiveView | undefined {
    return this.#get(h).view;
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
    return clipThumbnail(this.registry, this.cacheDir, this.#get(h), clipId, height);
  }

  /** PNG of an asset for the media bin: its first video stream `at` seconds in (a second by default; the screen, for a recording). */
  async assetThumbnail(h: ProjectHandle, assetId: string, height: number, at?: number): Promise<Uint8Array | undefined> {
    return assetThumbnail(this.cacheDir, this.#get(h), assetId, height, at);
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
    // Settings' folder unless one is given; gone, the project's media folder.
    const chosen = this.#config.settings().snapshotFolder;
    if (opts.folder === undefined && chosen && existsSync(chosen)) opts = { ...opts, folder: chosen };
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
    mkdirSync(opts.output.endsWith("/") ? output : dirname(output), { recursive: true });
    const colorSpace = this.#config.settings().exportColorSpace;
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
    return this.#parts.startJob(p, "export", `Export ${basename(output)}`, async (progress) => {
      const from = opts.from === undefined ? undefined : secondsToTicks(opts.from);
      const to = opts.to === undefined ? undefined : secondsToTicks(opts.to);
      const { frames } = await renderProject(project, this.registry, {
        output: opts.output.endsWith("/") ? { kind: "png", dir: output } : { kind: "video", ...encoding({ ...opts, colorSpace: opts.colorSpace ?? colorSpace }), path: output },
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
    const todo = files.map((f) => resolve(f)).map((file) => {
      const importer = this.registry.importerFor(extname(file));
      if (!importer) throw new Error(`no feature imports ${extname(file) || "files without an extension"} (${file})`);
      return { file, importer };
    });
    // A few at a time: each decodes its audio once for its loudness.
    const probed: { file: string; importer: MediaImporterDef; asset: Omit<Asset, "id"> }[] = new Array(todo.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < todo.length; i = next++) {
        const { file, importer } = todo[i]!;
        try {
          probed[i] = { file, importer, asset: { kind: importer.kind, path: file, fingerprint: fileFingerprint(file), derived: await probeAsset(file) } };
        } catch (e) {
          // The import fails: the others stop rather than decode the rest for nothing.
          next = todo.length;
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
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
    return this.#analyses.imported(p, result);
  }

  async analyze(h: ProjectHandle, key: string, assetId: string): Promise<Job> {
    return this.#analyses.analyze(this.#get(h), key, assetId);
  }

  async forget(h: ProjectHandle, key: string, assetId: string): Promise<boolean> {
    return this.#analyses.forget(this.#get(h), key, assetId);
  }

  async analysisSize(key: string): Promise<number> {
    return this.#analyses.analysisSize(key);
  }

  async forgetAll(key: string): Promise<number> {
    return this.#analyses.forgetAll(key);
  }

  async recorderDevices() {
    return this.#recording.devices();
  }

  async recorderAccess(kind: "camera" | "microphone") {
    return this.#recording.access(kind);
  }

  async recorderSetOutput(output: string) {
    return this.#recording.setOutput(output);
  }

  async recorderPreview(sources: RecorderSources, fn?: (e: RecorderPreviewEvent) => void) {
    return this.#recording.preview(sources, fn);
  }

  async recordStart(h: ProjectHandle, opts: RecordOptions = {}): Promise<{ take: string }> {
    return this.#recording.start(this.#get(h), opts);
  }

  async recordSyncCheck(sources: RecorderSources, show: () => Promise<void>) {
    return this.#recording.syncCheck(sources, show);
  }

  async recordStatus(): Promise<RecordStatus> {
    return this.#recording.status();
  }

  async recordStop(opts: RecordStopOptions = {}): Promise<RecordResult> {
    return this.#recording.stop(opts);
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
    if (p.view) this.#analyses.previewJobs(p);
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
    const derived = await probeAsset(file);
    this.#saved(p, p.store.run("asset.replace", { asset: assetId, path: file, fingerprint: fileFingerprint(file), derived }, { label: `Replace with ${basename(file)}` }));
    if (p.view) this.#analyses.previewJobs(p);
    return this.#analyses.importAnalyses(p, [assetId]);
  }

  preferences(): Promise<PreferenceInfo[]> {
    return this.#config.preferences();
  }

  async setPreference(id: string, value: string): Promise<void> {
    if (await this.#config.setPreference(id, value)) this.#analyses.preferenceChanged();
  }

  /** Sets or removes a secret (an API key): the app's Settings, never agents. Removed, a choice that needs it goes back to its default. */
  async setSecret(id: string, value: string | null): Promise<void> {
    for (const pref of await this.#config.setSecret(id, value)) await this.setPreference(pref, this.registry.preferences.get(pref)!.default);
  }

  /** Where the app-wide files (preferences, favourites, settings, keys) are kept. */
  get configDir(): string {
    return this.#config.dir;
  }

  /** A JSON file of the app's own (favourites, settings, keys, the desktop's recent projects); undefined when missing or unreadable. */
  readConfig(name: string): unknown {
    return this.#config.read(name);
  }

  /** Writes one atomically, so a crash never leaves it half written. */
  writeConfig(name: string, value: unknown) {
    this.#config.write(name, value);
  }

  async favorites(): Promise<string[]> {
    return this.#config.favorites();
  }

  async favoriteAdd(item: string, index?: number): Promise<string[]> {
    return this.#config.favoriteAdd(item, index);
  }

  async favoriteRemove(item: string): Promise<string[]> {
    return this.#config.favoriteRemove(item);
  }

  async favoriteMove(item: string, index: number): Promise<string[]> {
    return this.#config.favoriteMove(item, index);
  }

  async settings(): Promise<AppSettings> {
    return this.#config.settings();
  }

  async setSettings(patch: SettingsPatch): Promise<AppSettings> {
    return this.#config.setSettings(patch);
  }

  async shortcuts(): Promise<ShortcutInfo[]> {
    return this.#config.shortcuts();
  }

  async shortcutSet(action: string, keys: Keys[], replace = false): Promise<ShortcutInfo[]> {
    return this.#config.shortcutSet(action, keys, replace);
  }

  async shortcutReset(action?: string): Promise<ShortcutInfo[]> {
    return this.#config.shortcutReset(action);
  }

  async resources(): Promise<ResourceInfo[]> {
    return this.#analyses.resources();
  }

  async fetchResource(id: string): Promise<Job> {
    return this.#analyses.fetchResource(id);
  }

  async job(id: string): Promise<JobInfo> {
    return this.#jobs.info(id);
  }

  async cancelJob(id: string): Promise<void> {
    this.#jobs.cancel(id);
  }

  async jobs(): Promise<JobInfo[]> {
    return this.#jobs.list();
  }

  commands(): CommandInfo[] {
    return registryInfo(this.registry).commands;
  }

  queries(): QueryInfo[] {
    return registryInfo(this.registry).queries;
  }

  /** The registered summary query's text, if any. */
  async summary(h: ProjectHandle): Promise<string> {
    const q = [...this.registry.queries.values()].find((x) => x.summary);
    return q ? String(await this.query(h, q.id)) : `project ${h}`;
  }

  schema(): SchemaInfo {
    return registryInfo(this.registry).schema;
  }

  readonly #appListeners = new Set<(e: AppEvent) => void>();

  watchApp(fn: (e: AppEvent) => void): () => void {
    this.#appListeners.add(fn);
    return () => this.#appListeners.delete(fn);
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
