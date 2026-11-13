import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { diagnosticsReport, projectsRedactor, type DiagnosticsExtra } from "./diagnostics";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createRegistry } from "@beacon/features";
import { fileFingerprint, pastePng, probeMedia, type RecorderPreviewEvent, type RecorderSources } from "@beacon/media";
import {
  changedSettings,
  createProject,
  describeSession,
  SESSION_COMMANDS,
  type SharedSession,
  projectDuration,
  ProjectStore,
  roundSeconds,
  SessionStore,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type CommandResult,
  type Asset,
  type FeatureRegistry,
  type Project,
  type Session,
  type SessionChange,
  placeCanvas,
  rationalToNumber,
  assetName,
  type Keys,
  type ShortcutInfo,
  type AppSettings,
  SETTINGS_TABS,
  type SettingsTab,
  type SettingsPatch,
  withEffectParams,
  withPatches,
  type Memory,
  MemoryChangeSchema,
  type MemoryChange,
  type MemoryState,
  projectFormat,
  agentName,
  anyAgent,
  authorIs,
} from "@beacon/model";
import { DEFAULT_CACHE_DIR, DerivedData, FrameRenderer, LiveView, type ViewTarget } from "@beacon/render";
import type {
  AgentAbout,
  AgentSession,
  ScriptResult,
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
  SecretInfo,
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
import { Exporter } from "./exporter";
import { Importer } from "./importer";
import { Jobs } from "./jobs";
import { keychain, type Secrets } from "./keychain";
import { copyFollowingLinks, isInside, realPath } from "./media-copy";
import { lock, projectName, readEditor, readProject, unlock, writeEditor, writeProject, type OwnerInfo } from "./persist";
import { pngImage, probeAsset, shortId, type CoreParts, type OpenProject, type Preview } from "./project";
import { Recording } from "./recording";
import { registryInfo, UI_STATE } from "./registry-info";
import { currentAuthor } from "./author";
import { AgentRuns, type RunAgent } from "./agent-run";
import { loadScriptEngine, runScript, SCRIPT_SECONDS, type ScriptHost } from "./script";
import { Tasks } from "./tasks";
import { assetThumbnail, clipThumbnail } from "./thumbnails";

export interface LocalCoreOptions {
  registry?: FeatureRegistry;
  /** Frame indexes and derived data such as transcripts. */
  cacheDir?: string;
  /** The app's automation socket, recorded in each project's lock so agents connect to it. */
  socket?: string;
  /** Who this process is, in each project's lock, so another that finds it locked can say so ("Beacon dev"). */
  name?: string;
  /** A windowless process's control socket (`serveControl`), in each lock, so the app can ask it to let go. */
  control?: string;
  /** Shows a file in Finder; the app passes its own. */
  reveal?: (path: string) => void;
  /** Where app-wide preferences are kept (`preferences.json`): Beacon's Application Support folder. */
  configDir?: string;
  /** Where secrets (API keys) are kept: the login Keychain. */
  secrets?: Secrets;
  /** Where agent sessions' control sockets are (`agents`); tests keep the user's out. */
  controlDir?: string;
  /** The agent CLIs Beacon may start a run of, by name (`codex`); unset, those installed are found. Tests give their own. */
  agentClis?: Partial<Record<RunAgent, string>>;
  /**
   * Asks the user before an agent records (the screen, camera, microphone): the app shows Record / Don't. Without it,
   * as in a windowless agent's own process, an agent can't record (the user, 2026-11-05).
   */
  confirmAgentRecording?: (agent: string, what: string) => Promise<boolean>;
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

/** In-process core: owns the documents, runs the engine, reads and writes `.beproj` folders (PLAN §7.1). */
export class LocalCore implements BeaconCore {
  readonly registry: FeatureRegistry;
  readonly cacheDir: string;
  readonly #owner: OwnerInfo;
  readonly #reveal: (path: string) => void;
  readonly #projects = new Map<ProjectHandle, OpenProject>();
  /** Every background job: exports, analyses, downloads. */
  readonly #jobs = new Jobs((e) => {
    for (const l of this.#appListeners) l(e);
  });
  /** The last copies in any project, so they paste into the next one opened. */
  #shared: SharedSession = { clipboard: null, properties: null };

  /** Preferences, panel items' use, settings and keys, and the secrets. */
  readonly #config: AppConfig;
  readonly #pref: (id: string) => string;
  readonly #parts: CoreParts;
  readonly #analyses: Analyses;
  readonly #recording: Recording;
  readonly #exporter: Exporter;
  readonly #importer: Importer;
  readonly #tasks: Tasks;
  readonly #agentRuns: AgentRuns;
  readonly #confirmAgentRecording: LocalCoreOptions["confirmAgentRecording"];

  constructor(opts: LocalCoreOptions = {}) {
    this.registry = opts.registry ?? createRegistry();
    this.#confirmAgentRecording = opts.confirmAgentRecording;
    this.cacheDir = opts.cacheDir ?? process.env.BEACON_CACHE_DIR ?? DEFAULT_CACHE_DIR;
    // BEACON_CONFIG_DIR: tests keep the user's preferences, settings and keys out of their runs (bunfig's preload).
    this.#config = new AppConfig(opts.configDir ?? process.env.BEACON_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, this.registry, opts.secrets ?? keychain, (e) => {
      for (const l of this.#appListeners) l(e);
    });
    this.#pref = this.#config.pref;
    this.#owner = { ...(opts.name ? { name: opts.name } : {}), ...(opts.socket ? { socket: opts.socket } : {}), ...(opts.control ? { control: opts.control } : {}) };
    this.#reveal = opts.reveal ?? ((path) => void Bun.spawn(["/usr/bin/open", "-R", path]));
    this.#parts = {
      registry: this.registry,
      cacheDir: this.cacheDir,
      get: (h) => this.#get(h),
      find: (h) => this.#projects.get(h),
      projects: () => this.#projects.values(),
      emit: (p, e) => this.#emit(p, e),
      saved: (p, change, analyse) => this.#saved(p, change, analyse),
      startJob: (p, kind, label, fn, subject, asset) =>
        this.#jobs.start(kind, label, fn, { ...(p ? { project: p.path, report: (e) => this.#emit(p, e) } : {}), ...(subject ? { subject } : {}), ...(asset ? { asset } : {}) }),
    };
    this.#analyses = new Analyses(this.#parts, this.#jobs, this.#config, (fn) => this.watchApp(fn));
    this.#exporter = new Exporter(this.#parts, this.#jobs, this.#config, this.#analyses);
    this.#importer = new Importer(this.#parts, this.#config, this.#analyses);
    this.#tasks = new Tasks(this.#parts, this.#config);
    this.#agentRuns = new AgentRuns({
      parts: this.#parts,
      control: opts.control,
      socket: opts.socket,
      controlDir: opts.controlDir,
      agentClis: opts.agentClis,
      reply: (request, status, text) => void this.agentReply(request, status, text),
    });
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
    const project = Bun.hash(path).toString(36);
    const memory: Memory = {
      decisions: () => (this.#config.learning() ? this.#config.decisions() : []),
      record: (ds) => this.#config.recordDecisions(ds.map((d) => ({ ...d, format: projectFormat(current.settings), project, at: Date.now() }))),
    };
    // Commands only read the decisions: what they cut is recorded by the plan that runs them.
    const store = new ProjectStore(this.registry, doc, { newId: shortId, data: data.get, memory: { ...memory, record: () => {} }, author: currentAuthor, authorName: (a) => (a === undefined ? "you" : agentName(a)) });
    lock(path, this.#owner);
    store.subscribe((e) => void (current = e.doc));
    const p: OpenProject = {
      path,
      store,
      memory,
      decided: new WeakMap(),
      session: new SessionStore(this.registry, doc, this.#shared, this.#pref, data.get, memory),
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
    const kept = readEditor(path);
    p.session.reopen(Object.fromEntries([...this.registry.features.values()].filter((f) => f.sessionSaved && kept[f.id] !== undefined).map((f) => [f.id, kept[f.id]])));
    p.editorSaved = JSON.stringify(this.#editorState(p.session.state));
    p.session.subscribe((c) => this.#sessionChanged(p, c));
    this.#projects.set(path, p);
    return path;
  }

  /** What the features keep of the editor's state with the project (the safe areas shown), by feature id. */
  #editorState(s: Session): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.registry.features.values()) {
      const v = f.sessionSaved?.(s.features[f.id]);
      if (v !== undefined) out[f.id] = v;
    }
    return out;
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
      const project = await this.#importer.cmproj(dir, opts.cmproj);
      doc = { ...project, settings: changedSettings(project.settings, opts.settings ?? {}) };
    } else {
      const created = createProject(this.registry);
      doc = { ...created, settings: changedSettings(created.settings, opts.settings ?? {}) };
    }
    // Refused before anything is written: a bad setting mustn't leave a folder that blocks trying again.
    this.registry.validate(doc);
    try {
      if (opts.standalone) {
        doc = { ...doc, settings: { ...doc.settings, standalone: true } };
        const moved = await this.#importer.copyIn(dir, Object.values(doc.assets));
        doc = { ...doc, assets: { ...doc.assets, ...Object.fromEntries(moved.map((a) => [a.id, a])) } };
      }
      writeProject(dir, doc);
    } catch (e) {
      // The folder didn't exist: a copy that failed half way mustn't block trying again.
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return this.#attach(dir, doc);
  }

  /** Standalone on: what is outside the project is copied in, and the project points at the copies, as one undo step. */
  async #makeStandalone(p: OpenProject, args: unknown, opts: RunOptions): Promise<CommandResult> {
    const assets = Object.values(p.store.doc.assets);
    const moved = await this.#importer.copyIn(p.path, assets);
    const missing = assets.filter((a) => !isInside(p.path, a.path) && !existsSync(a.path));
    const r = this.#saved(p, p.store.transaction(opts.label ?? "Make Project Standalone", (tx) => {
      tx.run("project.settings.set", args);
      for (const a of moved) tx.run("asset.relink", { asset: a.id, path: a.path, fingerprint: a.fingerprint });
    }));
    return missing.length ? { ...r, diff: [...r.diff, `(${missing.length} missing file(s) stay where they were: ${missing.map((a) => basename(a.path)).join(", ")})`] } : r;
  }

  /** What a project made from a Camtasia project (`create` with `cmproj`) left out or changed, line by line. */
  importReport(h: ProjectHandle): string[] {
    return this.#importer.report(h);
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
    // Links inside a project are followed only to media it uses or to its own files: a crafted project linking to
    // ~/.ssh mustn't have that copied into the new one.
    const own = realPath(p.path) + sep;
    const media = new Set(Object.values(p.store.doc.assets).map((a) => realPath(resolve(p.path, a.path))));
    await copyFollowingLinks(p.path, to, (src) => dirname(src) !== p.path || !/^(lock|\.project\.json\..*\.tmp)$/.test(basename(src)), (target) => target.startsWith(own) || media.has(target));
    const assets = Object.values(doc.assets);
    const inside = assets.filter((a) => isInside(p.path, a.path)).map((a) => {
      const copy = { ...a, path: to + a.path.slice(p.path.length) };
      p.data.carry(a, copy);
      return copy;
    });
    const outside = standalone ? await this.#importer.copyIn(to, assets.filter((a) => !isInside(p.path, a.path))) : [];
    const { standalone: _, ...settings } = doc.settings;
    writeProject(to, {
      ...doc,
      settings: standalone ? { ...settings, standalone: true } : settings,
      assets: { ...doc.assets, ...Object.fromEntries([...inside, ...outside].map((a) => [a.id, a])) },
    });
    return to;
  }

  async reveal(h: ProjectHandle, path?: string): Promise<void> {
    const dir = this.#get(h).path;
    if (path !== undefined && !isInside(dir, path)) throw new Error("only files in the project's folder can be shown");
    if (path !== undefined && !existsSync(path)) throw new Error(`${basename(path)} isn't there any more`);
    this.#reveal(path ?? dir);
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
          writeProject(p.path, p.store.doc);
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
    if (command === "project.settings.set" && (args as { standalone?: unknown } | null)?.standalone === true && !p.store.doc.settings.standalone && !opts.dryRun) {
      return this.#makeStandalone(p, args, opts);
    }
    return this.#runNow(p, command, args, opts);
  }

  /** A command, action or editor command, done before it returns: what a batch is made of. */
  #runNow(p: OpenProject, command: string, args: unknown, opts: RunOptions = {}): CommandResult {
    if (p.session.has(command)) return this.#runSession(p, command, args, opts);
    const action = this.registry.actions.get(command);
    if (action) return this.#tasks.runAction(p, action, args, opts);
    if (opts.coalesce && !opts.dryRun) {
      const r = p.store.run(command, args, opts);
      this.#saveSoon(p);
      return r;
    }
    return this.#saved(p, p.store.run(command, args, opts));
  }

  /**
   * `fn`'s changes as one undo step, all or nothing: each applied (and shown) as it is made, every one taken back
   * if it throws or this is a dry run, the editor's state with them. Saved once, at the end.
   */
  #batch<T>(p: OpenProject, label: string, fn: () => T, opts: { dryRun?: boolean } = {}): { value: T; result: CommandResult } {
    if (p.batch) throw new Error("a batch is already being made in this project");
    const session = p.session.state;
    p.store.begin(label);
    p.batch = { later: [] };
    let value: T;
    try {
      value = fn();
    } catch (e) {
      p.batch = undefined;
      p.store.abort();
      if (p.session.state !== session) p.session.restore(session);
      throw e;
    }
    const later = p.batch.later;
    p.batch = undefined;
    if (opts.dryRun) {
      const result = p.store.abort();
      if (p.session.state !== session) p.session.restore(session);
      return { value, result };
    }
    const result = this.#saved(p, p.store.commit());
    const lines = later.flatMap((f) => {
      try {
        return f() ?? [];
      } catch (e) {
        return [`(${e instanceof Error ? e.message : String(e)})`];
      }
    });
    return { value, result: { ...result, diff: [...result.diff, ...lines] } };
  }

  /** A drag changes the document many times a second: write it once things settle. */
  #saveSoon(p: OpenProject) {
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

  async transaction(h: ProjectHandle, label: string, steps: TransactionStep[], opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const p = this.#get(h);
    const names = this.#scriptNames();
    steps = steps.map((s) => ({ ...s, command: names.get(s.command)?.id ?? s.command }));
    if (steps.some((s) => s.command === "project.settings.set" && (s.args as { standalone?: unknown } | null)?.standalone === true)) {
      throw new Error("standalone copies media into the project: run project.settings.set on its own, outside a transaction");
    }
    const plain = steps.every((s) => !p.session.has(s.command) && !this.registry.actions.has(s.command));
    if (plain) {
      return this.#saved(p, p.store.transaction(label, (tx) => {
        for (const s of steps) tx.run(s.command, s.args ?? {});
      }, opts));
    }
    // Actions and editor commands are planned on the document as the steps before them left it, so each is made in turn.
    const { value, result } = this.#batch(p, label, () => steps.map((s, i) => {
      try {
        const r = this.#runNow(p, s.command, s.args ?? {});
        return r.results.length === 1 ? r.results[0] : r.results;
      } catch (e) {
        throw new Error(`step ${i + 1} (${s.command}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }), opts);
    return { ...result, results: value };
  }

  /**
   * An agent's script (`script.ts`): its `beacon.run` calls made as one undo step, all or nothing, and what it returns.
   * Commands, actions, editor commands and queries are named by id or tool name (`clip.set` or `clip_set`).
   */
  async script(h: ProjectHandle, code: string, opts: { label?: string; dryRun?: boolean; seconds?: number } = {}): Promise<ScriptResult> {
    const p = this.#get(h);
    const names = this.#scriptNames();
    const id = (name: string, kind: string) => {
      const found = names.get(name) ?? names.get(name.replaceAll("_", "."));
      if (!found || (kind === "query") !== (found.kind === "query")) {
        throw new Error(`no ${kind === "query" ? "query" : "command"} "${name}"${found ? `: it is a ${found.kind === "query" ? "query, for beacon.query" : "command, for beacon.run"}` : ""}`);
      }
      return found.id;
    };
    const host: ScriptHost = {
      run: (name, args) => {
        const r = this.#runNow(p, id(name, "run"), args ?? {});
        return r.results.length === 1 ? r.results[0] : r.results;
      },
      query: (name, args) => {
        const q = id(name, "query");
        const v = q === UI_STATE.id ? { session: p.session.state, description: describeSession(p.session.state, p.store.doc) } : this.registry.runQuery(q, args ?? {}, this.#queryContext(p));
        if (v instanceof Promise) throw new Error(`${q} takes time (it waits on something): call it outside the script`);
        return v;
      },
    };
    await loadScriptEngine();
    const label = opts.label ?? "Script";
    let logs: string[] = [];
    const { value, result } = this.#batch(p, label, () => {
      const outcome = runScript(code, host, Math.min(opts.seconds ?? SCRIPT_SECONDS, 30));
      logs = outcome.logs;
      return outcome.value;
    }, opts);
    return { value, logs, diff: result.diff, label, dryRun: !!opts.dryRun, changed: result.patches.length > 0 };
  }

  #scriptNames(): Map<string, { id: string; kind: "run" | "query" }> {
    const names = new Map<string, { id: string; kind: "run" | "query" }>();
    const put = (id: string, kind: "run" | "query") => (names.set(id, { id, kind }), names.set(id.replaceAll(".", "_"), { id, kind }));
    for (const c of this.registry.commands.keys()) put(c, "run");
    for (const a of this.registry.actions.keys()) put(a, "run");
    for (const c of [...SESSION_COMMANDS.map((c) => c.id), ...this.registry.sessionCommands.keys()]) put(c, "run");
    for (const q of this.registry.queries.keys()) put(q, "query");
    put(UI_STATE.id, "query");
    return names;
  }

  #runSession(p: OpenProject, command: string, args: unknown, opts: RunOptions): CommandResult {
    if (PLAYBACK.has(command) && !p.view && !p.session.state.playing) throw new Error(`${command} needs the Beacon app: playback plays in its window`);
    const before = p.session.state;
    const { session, changed } = p.session.run(command, args, p.store.doc, { dryRun: opts.dryRun });
    const diff = changed.map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(session[k])}`);
    return { label: opts.label ?? command, patches: [], inverse: [], results: [session], diff, dryRun: !!opts.dryRun };
  }

  #sessionChanged(p: OpenProject, { session, changed }: SessionChange) {
    if (changed.includes("features")) {
      const kept = this.#editorState(session);
      const json = JSON.stringify(kept);
      if (json !== p.editorSaved) {
        try {
          writeEditor(p.path, kept);
          p.editorSaved = json;
        } catch (err) {
          console.error(err);
        }
      }
    }
    if (changed.includes("clipboard") || changed.includes("properties")) {
      this.#shared = { clipboard: session.clipboard, properties: session.properties };
      for (const other of this.#projects.values()) if (other !== p) other.session.share(this.#shared);
    }
    this.#emit(p, { kind: "session", changes: Object.fromEntries(changed.map((k) => [k, session[k]])) as Partial<Session>, changed });
    this.#recording.sessionChanged(p, session, changed);
    const view = p.view;
    if (!view || p.ticking) return;
    if (changed.includes("playing") && session.playing) p.preview = undefined;
    // A pause leaves the playhead on the frame shown. It went on to where the sound sent to the device ended, the
    // output's latency ahead (0.2 s and more over some), and the picture redrawn there jumped back for a moment
    // (the user, 2026-11-06); a play from it may repeat that much sound, as in other editors.
    if (changed.includes("playing") && !session.playing) view.stop();
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
    if (tab === "project") throw new Error("Project Settings is a dialog of its own: dialog projectSettings");
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
      project: () => this.#shown(p),
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
    this.#analyses.effectJobs(p);
    return view;
  }

  /** What the canvas shows: the document, with an effect previewed over it. */
  #shown(p: OpenProject): Project {
    const doc = p.store.doc;
    if (!p.preview) return doc;
    if (p.previewDoc?.doc === doc) return p.previewDoc.shown;
    let shown = doc;
    try {
      shown = this.#previewed(p, p.preview);
    } catch {
      // Its clip or effect is gone: nothing left to preview.
      p.preview = undefined;
    }
    p.previewDoc = { doc, shown };
    return shown;
  }

  #previewed(p: OpenProject, preview: Preview): Project {
    if ("command" in preview) return withPatches(p.store.doc, p.store.run(preview.command, preview.args, { dryRun: true }).patches);
    return withEffectParams(p.store.doc, this.registry, preview.clip, preview.effect, preview.params);
  }

  /**
   * Shows an effect with these params, or what a command would do, on the canvas without editing anything (a look
   * under the pointer); null shows it as it is again. The document, undo history, saves, agents and exports never see
   * it; playing ends it.
   */
  async previewEffect(h: ProjectHandle, preview: Preview | null): Promise<void> {
    const p = this.#get(h);
    if (preview) this.#previewed(p, preview);
    if (!preview && !p.preview) return;
    p.preview = preview ?? undefined;
    p.previewDoc = undefined;
    p.view?.refresh();
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
    const store = new ProjectStore(this.registry, { ...base, settings, tracks: [], markers: [], sections: [] }, { newId: shortId, data: p.data.get });
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

  /** Undoes the caller's own last step: the user's (skipping the agents'), or an agent's own. */
  async undo(h: ProjectHandle) {
    const p = this.#get(h);
    const entry = this.#saved(p, p.store.undo(authorIs(currentAuthor())));
    const d = entry && p.decided.get(entry.patches);
    if (d) d.undone = this.#config.dropDecisions(d.step);
    return entry?.label;
  }

  /** Edit › Undo Agents' Last Change: the newest step of any agent's. */
  async undoAgents(h: ProjectHandle) {
    const p = this.#get(h);
    const entry = this.#saved(p, p.store.undo(anyAgent));
    // What it learned from the agent's choices goes too, as ⌘Z takes it.
    const d = entry && p.decided.get(entry.patches);
    if (d) d.undone = this.#config.dropDecisions(d.step);
    return entry?.label;
  }

  async redo(h: ProjectHandle) {
    const p = this.#get(h);
    const entry = this.#saved(p, p.store.redo(authorIs(currentAuthor())));
    const d = entry && p.decided.get(entry.patches);
    if (d?.undone) this.#config.recordDecisions(d.undone);
    return entry?.label;
  }

  /** Autosave after a change; a failed save is the caller's error, not a log line. */
  #saved<T extends { patches: unknown[]; dryRun?: boolean } | undefined>(p: OpenProject, change: T, analyse = true): T {
    if (!change || change.dryRun || !change.patches.length) return change;
    this.#analyses.effectJobs(p);
    try {
      writeProject(p.path, p.store.doc);
      this.#emit(p, { kind: "saved", path: p.path });
    } catch (e) {
      this.#emit(p, { kind: "error", message: `could not save ${p.path}: ${e instanceof Error ? e.message : e}` });
      throw new Error(`the change was made but could not be saved to ${p.path}: ${e instanceof Error ? e.message : e}`);
    }
    if (!analyse) return change;
    // Media an edit brought in (a task's result, a paste, asset.add), as an import would: waveforms, proxies, transcripts.
    const added = (change.patches as { op: string; path: (string | number)[] }[]).flatMap((x) => (x.op === "add" && x.path[0] === "assets" && x.path.length === 2 && p.store.doc.assets[x.path[1]!] ? [String(x.path[1])] : []));
    if (added.length) {
      if (p.view) this.#analyses.previewJobs(p);
      this.#analyses.importAnalyses(p, added);
    }
    return change;
  }

  async history(h: ProjectHandle) {
    const store = this.#get(h).store;
    return { ...store.history, steps: store.steps };
  }

  async query(h: ProjectHandle, name: string, args: unknown = {}): Promise<unknown> {
    const p = this.#get(h);
    if (name === UI_STATE.id) return { session: p.session.state, description: describeSession(p.session.state, p.store.doc) };
    return await this.registry.runQuery(name, args, this.#queryContext(p));
  }

  #queryContext(p: OpenProject) {
    return { project: p.store.doc, registry: this.registry, data: p.data.get, pref: p.data.pref, memory: p.memory, session: p.session.state, secret: (id: string) => this.#config.secrets.get(id) };
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
    if (opts.folder !== undefined) this.#exporter.checkOutput(p, path);
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
    this.#exporter.checkOutput(this.#get(h), path, opts);
  }

  async export(h: ProjectHandle, opts: ExportOptions): Promise<Job> {
    return this.#exporter.export(this.#get(h), opts);
  }

  /** All or nothing: every file is probed first, then they are added in one undo step. */
  async import(h: ProjectHandle, files: string[], opts: ImportOptions = {}): Promise<ImportResult> {
    return this.#importer.import(this.#get(h), files, opts);
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
    const p = this.#get(h);
    const agent = currentAuthor();
    if (agent !== undefined) {
      const ask = this.#confirmAgentRecording;
      if (!ask) throw new Error("an agent records only with the project open in the Beacon app, which asks the user first");
      const s = opts.narrate ? { microphone: {} } : (opts.sources ?? { screen: {}, microphone: {}, systemAudio: true });
      const what = [s.screen && "the screen", s.camera && "the camera", s.microphone && "the microphone", s.systemAudio && "the Mac's sound"].filter(Boolean).join(", ");
      if (!(await ask(agentName(agent), what))) throw new Error("the user didn't let the agent record");
    }
    return this.#recording.start(p, opts);
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
    const importer = this.registry.importerFor(extname(file));
    if (importer?.kind !== asset.kind) throw new Error(`${basename(file)} isn't the same kind of media as ${basename(asset.path)}`);
    let derived: Record<string, unknown> | undefined;
    if (importer.probe) {
      // A file an effect reads is checked by reading it, as on import; what it holds now (a LUT's domain) replaces what the old file held.
      derived = await importer.probe(file);
    } else {
      const was = asset.derived.media as Awaited<ReturnType<typeof probeMedia>> | undefined;
      const now = await probeMedia(file);
      const shape = (m: typeof now) => m.streams.map((s) => `${s.kind}:${s.width ?? ""}x${s.height ?? ""}`).join(",");
      if (was && (shape(was) !== shape(now) || Math.abs(was.duration - now.duration) > 0.1)) {
        throw new Error(`${basename(file)} isn't the same media as ${basename(asset.path)}: its streams or length differ`);
      }
    }
    this.#saved(p, p.store.run("asset.relink", { asset: assetId, path: file, fingerprint: fileFingerprint(file), ...(derived ? { derived } : {}) }, { label: `Locate ${basename(file)}` }));
    if (p.view) this.#analyses.previewJobs(p);
  }

  async replace(h: ProjectHandle, assetId: string, path: string): Promise<{ jobs: string[]; needs?: string[] }> {
    const p = this.#get(h);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const file = resolve(path);
    if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
    const importer = this.registry.importerFor(extname(file));
    const kind = importer?.kind;
    if (asset.kind === "recording") throw new Error(`${assetName(asset)} is a recording: it can't be replaced`);
    const like = { video: "video", image: "image", audio: "audio file", file: `${extname(asset.path)} file` }[asset.kind];
    if (kind !== asset.kind || (kind === "file" && extname(file).toLowerCase() !== extname(asset.path).toLowerCase())) throw new Error(`${assetName(asset)} can only be replaced with another ${like}`);
    const derived = await (importer!.probe ?? probeAsset)(file);
    this.#saved(p, p.store.run("asset.replace", { asset: assetId, path: file, fingerprint: fileFingerprint(file), derived }, { label: `Replace with ${basename(file)}` }));
    if (p.view) this.#analyses.previewJobs(p);
    return this.#analyses.importAnalyses(p, [assetId]);
  }

  preferences(): Promise<PreferenceInfo[]> {
    return this.#config.preferences();
  }

  async setPreference(id: string, value: string): Promise<void> {
    // A slider's last setting (a range) decides no analysis, so it mustn't restart transcripts.
    const def = this.registry.preferences.get(id)!;
    // A slider's setting or a feature's list isn't a choice analyzers make their data by.
    if ((await this.#config.setPreference(id, value)) && !def.range && !def.schema) this.#analyses.preferenceChanged();
  }

  /** The preferences again, after another process or a hand edit may have written them (the app watches the file): a change is told and followed as `setPreference`'s are. */
  reloadPreferences(): void {
    const decides = (id: string) => {
      const def = this.registry.preferences.get(id)!;
      return !def.range && !def.schema;
    };
    if (this.#config.reloadPreferences().some(decides)) this.#analyses.preferenceChanged();
  }

  async secrets(): Promise<SecretInfo[]> {
    return Promise.all([...this.registry.secrets.values()].map(async (s) => ({ id: s.id, title: s.title, set: (await this.#config.secrets.get(s.id)) !== undefined })));
  }

  /** Sets or removes a secret (an API key): the app's Settings, never agents. Removed, a choice that needs it goes back to its default. */
  async setSecret(id: string, value: string | null): Promise<void> {
    for (const pref of await this.#config.setSecret(id, value)) await this.setPreference(pref, this.registry.preferences.get(pref)!.default);
  }

  /** Where the app-wide files (preferences, panel items' use, settings, keys) are kept. */
  get configDir(): string {
    return this.#config.dir;
  }

  /** A JSON file of the app's own (panel items' use, settings, keys, the desktop's recent projects); undefined when missing or unreadable. */
  readConfig(name: string): unknown {
    return this.#config.read(name);
  }

  /** Writes one atomically, so a crash never leaves it half written. */
  writeConfig(name: string, value: unknown) {
    this.#config.write(name, value);
  }

  async recentItems(): Promise<string[]> {
    return this.#config.recentItems();
  }

  async itemUsed(item: string): Promise<string[]> {
    return this.#config.itemUsed(item);
  }

  async agents(): Promise<AgentSession[]> {
    return this.#agentRuns.agents();
  }

  async askAgent(socket: string, prompt: string, about: AgentAbout): Promise<string> {
    return this.#agentRuns.ask(socket, prompt, about);
  }

  async agentStatus(h: ProjectHandle, text: string): Promise<void> {
    const p = this.#get(h);
    this.#emit(p, { kind: "agentStatus", agent: agentName(currentAuthor() ?? "agent"), text: text.slice(0, 120) });
  }

  async agentReply(request: string, status: "received" | "done", text?: string): Promise<void> {
    for (const l of this.#appListeners) l({ kind: "agent", request, status, ...(text ? { text } : {}) });
  }

  async settings(): Promise<AppSettings> {
    return this.#config.settings();
  }

  /** The settings again, after another process may have written them (the app watches the file): a change is told as `setSettings`'s are. */
  reloadSettings(): AppSettings {
    return this.#config.reloadSettings();
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

  async memory(): Promise<MemoryState> {
    return this.#config.memory();
  }

  async memoryChange(change: MemoryChange): Promise<MemoryState> {
    return this.#config.memoryChange(MemoryChangeSchema.parse(change));
  }

  async shortcutReset(action?: string): Promise<ShortcutInfo[]> {
    return this.#config.shortcutReset(action);
  }

  async resources(): Promise<ResourceInfo[]> {
    return this.#analyses.resources();
  }

  /** A report to send when something goes wrong: this Mac, Beacon's setup and the open projects in numbers (diagnostics.ts). */
  async diagnostics(extra: DiagnosticsExtra = {}): Promise<string> {
    const [preferences, secrets, resources, jobs, settings] = await Promise.all([this.preferences(), this.secrets(), this.resources(), this.jobs(), this.settings()]);
    return diagnosticsReport({ projects: [...this.#projects.values()].map((p) => ({ path: p.path, doc: p.store.doc })), settings, preferences, secrets, resources, jobs }, extra);
  }

  /** `text` redacted as the diagnostics report is: the home folder, open projects' and media names, and paths replaced. */
  redact(text: string): string {
    return projectsRedactor([...this.#projects.values()].map((p) => ({ path: p.path, doc: p.store.doc })))(text);
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
