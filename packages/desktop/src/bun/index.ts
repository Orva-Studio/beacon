import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Pointer } from "bun:ffi";
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, ContextMenu, GlobalShortcut, Tray, Utils, WGPUView } from "electrobun/main";
import { patchInfoPlist } from "./info-plist";

// The engine ships inside the app; set before anything loads it.
const engineDir = join(import.meta.dir, "../engine");
if (existsSync(join(engineDir, "libbeacon_ffi.dylib"))) {
  process.env.BEACON_FFI_PATH ??= join(engineDir, "libbeacon_ffi.dylib");
  process.env.BEACON_WORKER_PATH ??= join(engineDir, "beacon-worker");
  process.env.BEACON_RECORDER_PATH ??= join(engineDir, "beacon-recorder");
}

// `electrobun dev` builds and launches in one step, so a dev bundle gets its Info.plist entries here (a built one
// has them from `bun run build`); Launch Services then learns the `.brec` package type.
const bundle = import.meta.dir.match(/^(.*?\.app)\/Contents\//)?.[1];
if (bundle && patchInfoPlist(join(bundle, "Contents/Info.plist"))) {
  Bun.spawnSync(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", bundle]);
}

const { captureWindow, DEFAULT_SOCKET, enginePlacement, findDropped, fitPercent, LocalCore, summarizeReport, locateTrack, placeCanvas, serveCore, walkClips, windowNumber } = await import("@beacon/core");
type LiveView = import("@beacon/core").LiveView;
type Session = import("@beacon/core").Session;
type ExportSettings = import("@beacon/ui").ExportSettings;
type RecordSources = import("@beacon/ui").RecordSources;
type AppSettings = import("@beacon/ui").AppSettings;
type CanvasValues = import("@beacon/ui").CanvasValues;
const { DEFAULT_EXPORT, exportOptions } = await import("@beacon/ui");
const keymap = (await import("../../../../keymaps/default.json")).default.bindings as import("@beacon/ui").Init["keymap"];

const socket = process.env.BEACON_SOCKET ?? DEFAULT_SOCKET;
const keyLog = process.env.BEACON_KEYLOG ? join(homedir(), "Library/Logs/beacon-keys.log") : undefined;
const core = new LocalCore({ socket });

interface Current {
  path: string;
  /** `rect`: the canvas view in the window, in points. */
  view?: { id: number; live: LiveView; scale: number; rect: { x: number; y: number; width: number; height: number } };
  unwatch: () => void;
  /** Already released by core (renamed): switching away must not close it again. */
  closed?: boolean;
}
let current: Current | undefined;
/** The selection, handles and guides the window last asked the canvas to draw. */
let lastMarks: import("@beacon/ui").CanvasMark[] = [];
/** The window's colour around the canvas, for previews made after it was sent. */
let lastSurround: [number, number, number] | undefined;

/** Marks' sizes are points; the native view draws in physical pixels. */
function scaledMarks(marks: import("@beacon/ui").CanvasMark[], scale: number) {
  return marks.map((m) => (m.kind === "line" ? { ...m, width: m.width * scale } : { ...m, radius: m.radius * scale, width: m.width * scale }));
}
/** The revision of the document the window was last sent: one per patches message, so it can tell if it missed one. */
let rev = 0;

async function openedPayload(h: string): Promise<import("@beacon/ui").Opened> {
  return { path: h, name: basename(h, ".beproj"), project: core.doc(h), session: await core.session(h), rev };
}
let shown: import("@beacon/ui").Shown | undefined;

const send = () => win.webview.rpc!.send;

const status = (text: string) => send().status({ text });

/** The session's canvas zoom and pan, placed in the native view (physical pixels) as the overlay places it in points. */
function placement(c: Session["canvas"], view: { rect: { width: number; height: number }; scale: number }): [number, number, number] {
  const canvas = core.doc(current!.path).settings;
  const px = { width: Math.max(1, Math.round(view.rect.width * view.scale)), height: Math.max(1, Math.round(view.rect.height * view.scale)) };
  return enginePlacement(canvas, px, placeCanvas(canvas, px, c.zoom, c.pan ?? [0, 0], view.scale));
}

/** File > Open Recent: the last projects opened, newest first. */
const RECENT_FILE = join(homedir(), "Library/Application Support/Beacon/recent.json");
let recent: string[] = (() => {
  try {
    return (JSON.parse(readFileSync(RECENT_FILE, "utf8")) as string[]).filter((p) => existsSync(p));
  } catch {
    return [];
  }
})();
function setRecent(list: string[]) {
  recent = list.slice(0, 10);
  try {
    mkdirSync(dirname(RECENT_FILE), { recursive: true });
    writeFileSync(RECENT_FILE, JSON.stringify(recent));
  } catch (e) {
    status(`could not remember recent projects: ${e instanceof Error ? e.message : e}`);
  }
  setMenu();
}

/** Opens run one at a time: two at once would both pass the "already open" check and interleave the switch. */
let opening: Promise<unknown> = Promise.resolve();
function open(path: string): Promise<void> {
  const next = opening.then(() => switchTo(path));
  opening = next.catch(() => {});
  return next;
}

async function switchTo(path: string) {
  const dir = resolve(path);
  if (current?.path === dir && !current.closed) return;
  const h = await core.open(dir);
  // The webview keeps its canvas element across projects, so it won't report it again.
  const canvas = current?.view;
  if (current) {
    current.unwatch();
    // A failed final save still releases the old project; say so and finish switching.
    if (!current.closed) await core.close(current.path).catch((e: unknown) => status(e instanceof Error ? e.message : String(e)));
  }
  const unwatch = core.watch(h, (e) => {
    tally(`event ${e.kind}`);
    if (e.kind === "apply" || e.kind === "undo" || e.kind === "redo") {
      send().patches({ patches: e.patches, label: e.label, kind: e.kind, rev: ++rev });
      void sendThumbs();
      void sendMissing();
    }
    else if (e.kind === "session") {
      send().session({ changes: e.changes });
      if (e.changes.canvas && current?.view) current.view.live.place(...placement(e.changes.canvas, current.view));
    } else if (e.kind === "saved") {
      send().saved({ ok: true });
    } else if (e.kind === "preparing") {
      proxyProgress.queued = e.assets;
      sendPreparing();
    } else if (e.kind === "derived" && e.key === "proxy") {
      send().media({ proxies: { [e.asset]: e.present } });
    } else if (e.kind === "error") {
      if (e.message.startsWith("could not save")) send().saved({ ok: false });
      status(e.message);
    } else if (e.kind === "job" && e.job.kind !== "export") {
      if (e.job.state === "failed" && e.job.error !== "cancelled") status(`${e.job.label}: ${e.job.error}`);
      if (e.job.kind === "proxy" && e.job.asset) {
        if (e.job.state === "running") proxyProgress.jobs[e.job.asset] = e.job.progress;
        else delete proxyProgress.jobs[e.job.asset];
        sendPreparing();
      }
      if (e.job.state === "done" && e.job.kind === "waveform") sendWaveforms();
      if (e.job.state === "done" && e.job.kind === "proxy") void sendThumbs();
    }
  });
  current = { path: h, unwatch };
  setRecent([h, ...recent.filter((p) => p !== h)]);
  win.setTitle(`${basename(h)} — Beacon`);
  thumbs.clear();
  proxyProgress = { queued: {}, jobs: {} };
  send().opened(await openedPayload(h));
  if (canvas) await canvasView(canvas.id, canvas.rect, canvas.scale);
  sendWaveforms();
  sendProxies();
  lastMissing = undefined;
  void sendMissing();
  void sendThumbs();
}

/** The missing media last sent, so the check below only sends changes. */
let lastMissing: string | undefined;
let checkingMissing: Promise<void> | undefined;
let recheckMissing = false;
/**
 * Tells the window which media's files are gone (moved or deleted, even while the project is open). One check
 * at a time, and one more if asked meanwhile: overlapping checks could finish out of order and send a stale list.
 */
function sendMissing(): Promise<void> {
  if (checkingMissing) {
    recheckMissing = true;
    return checkingMissing;
  }
  checkingMissing = (async () => {
    do {
      recheckMissing = false;
      const path = current?.path;
      if (!path) return;
      const missing = await core.missing(path).catch(() => []);
      const key = missing.join(",");
      if (current?.path !== path || key === lastMissing) continue;
      lastMissing = key;
      send().media({ missing });
    } while (recheckMissing);
  })().finally(() => (checkingMissing = undefined));
  return checkingMissing;
}
setInterval(() => void sendMissing(), 3000);

function sendPreparing() {
  send().media({ preparing: { ...proxyProgress.queued, ...proxyProgress.jobs } });
}

function sendProxies() {
  if (!current) return;
  const proxies: Record<string, boolean> = {};
  for (const id of Object.keys(core.doc(current.path).assets)) proxies[id] = core.derived(current.path, id, "proxy") !== undefined;
  send().media({ proxies });
}

/** Where new projects (and copies of Camtasia projects) go. */
const PROJECTS = join(homedir(), "Movies/Beacon");

/** `name`.beproj in the projects folder, numbered if taken. */
function freshProject(name: string): string {
  mkdirSync(PROJECTS, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(PROJECTS, `${name}${n > 1 ? ` ${n}` : ""}.beproj`);
    if (!existsSync(path)) return path;
  }
}

/** Opens a .beproj, or a Camtasia .cmproj as a new Beacon project beside the others (the .cmproj is only read). */
async function openDialog() {
  const [path] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: "~/" });
  if (path) await openProject(path);
}

const isProject = (path: string) => /\.(cmproj|beproj)\/?$/.test(path);

/** Media into the open project; a project among them (Import or a Finder drop of a .cmproj) is opened instead. */
async function importPaths(paths: string[], at: { time?: number; track?: string } = {}) {
  const media = paths.filter((p) => !isProject(p));
  const project = paths.find(isProject);
  if (media.length) {
    if (!current) throw new Error("Open or create a project first");
    const r = await core.import(current.path, media, { ...(at.time !== undefined ? { at: at.time } : {}), ...(at.track ? { track: at.track } : {}) });
    status(`Imported ${r.assets.length} file${r.assets.length === 1 ? "" : "s"}`);
  }
  if (project) await openProject(project.replace(/\/$/, ""));
}

async function openProject(path: string) {
  if (path.endsWith(".cmproj")) {
    const to = freshProject(basename(path, ".cmproj"));
    status(`Importing ${basename(path)}…`);
    await core.create({ path: to, cmproj: path });
    await open(to);
    const left = summarizeReport(core.importReport(to));
    if (left.length) send().notice({ title: `Opened "${basename(path, ".cmproj")}"`, message: "Some of the Camtasia project isn't supported yet and was left out or changed:", lines: left.map((l) => (l.count > 1 ? `${l.message} (×${l.count})` : l.message)) });
    return status(`Opened ${basename(path)} as ${to}; the Camtasia project is unchanged`);
  }
  if (!path.endsWith(".beproj")) throw new Error(`${path} is neither a Beacon project (.beproj) nor a Camtasia project (.cmproj)`);
  await open(path);
}

/** File > New Project: the window asks for the name, then `createProject`. */
function newProject() {
  send().newProjectSheet({ name: "Untitled Project" });
}

async function createProject(name: string, canvas?: CanvasValues) {
  if (/[/:]/.test(name) || name.startsWith(".") || !name.trim()) throw new Error(`"${name}" can't be a project name`);
  const to = freshProject(name.trim());
  const settings = canvas && {
    width: canvas.width,
    height: canvas.height,
    fps: { num: canvas.fps, den: 1 },
    background: canvas.background,
    // Off: no target (a new project's default has one).
    ...(canvas.normalize ? {} : { loudnessTarget: undefined }),
  };
  await core.create({ path: to, ...(settings ? { settings } : {}) });
  await open(to);
  status(`New project: ${to}`);
}

/** Clicking the project's name: its folder takes the new name, and Open Recent follows. */
function renameProject(name: string): Promise<void> {
  const next = opening.then(async () => {
    if (!current) throw new Error("Open a project first");
    const from = current.path;
    const to = await core.rename(from, name);
    if (to === from) return;
    current.closed = true;
    await switchTo(to);
    setRecent(recent.filter((p) => p !== from));
  });
  opening = next.catch(() => {});
  return next;
}

/** Import Media (⌘I): recordings, video, audio and images onto the timeline, after what is there. */
async function importMedia() {
  const files = await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true, startingFolder: "~/" });
  if (files.filter(Boolean).length) await importPaths(files.filter(Boolean));
}

/** Export (⌘E): the whole project as an MP4 into a chosen folder, named after the project; progress shows in the status line. */
/** The Export dialog's last folder and settings, offered next time. */
const EXPORT_FILE = join(homedir(), "Library/Application Support/Beacon/export.json");
type ExportPrefs = { folder: string; settings: ExportSettings };
function exportPrefs(): ExportPrefs {
  try {
    const saved = JSON.parse(readFileSync(EXPORT_FILE, "utf8")) as Partial<ExportPrefs>;
    return { folder: saved.folder && existsSync(saved.folder) ? saved.folder : join(homedir(), "Movies"), settings: { ...DEFAULT_EXPORT, ...saved.settings } };
  } catch {
    return { folder: join(homedir(), "Movies"), settings: DEFAULT_EXPORT };
  }
}

/** Beacon > Settings… > General (`~/Library/Application Support/Beacon/settings.json`). */
const SETTINGS_FILE = join(homedir(), "Library/Application Support/Beacon/settings.json");
let appSettings: AppSettings = (() => {
  // Proxies are off until turned on: the preview reads originals in process, and a proxy is one more copy to build.
  const defaults: AppSettings = { exportColorSpace: "bt709", autoProxy: { recording: false, video: false }, proxyMode: "quiet" };
  try {
    return { ...defaults, ...(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<AppSettings>) };
  } catch {
    return defaults;
  }
})();
function setAppSettings(next: AppSettings) {
  appSettings = next;
  applyAutoProxy();
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings));
  } catch (e) {
    status(`could not save settings: ${e instanceof Error ? e.message : e}`);
  }
}

/** Proxies start on their own only for the kinds of media the settings name. */
function applyAutoProxy() {
  core.setJobMode(appSettings.proxyMode);
  core.setAutomatic((analyzer, asset) => analyzer !== "proxy" || (asset.kind === "recording" ? appSettings.autoProxy.recording : appSettings.autoProxy.video));
}
applyAutoProxy();

/** Exports started from the window, by job id: their output files. */
const exports = new Map<string, string>();
// Exports report here rather than through the open project: one keeps going when another project is opened.
// Agents' exports too: until it is done, an export started elsewhere is known by its label.
core.watchJobs((job) => {
  if (job.kind !== "export") return;
  const { id, state, progress, error, result, label } = job;
  const output = exports.get(id) ?? (result as { output?: string } | undefined)?.output ?? label.replace(/^Export /, "");
  send().exportJob({ id, output, state, progress, ...(error ? { error } : {}) });
  if (state !== "running") exports.delete(id);
});

/** File > Export… opens the window's Export dialog, offering the in/out range when there is one; Export Selection… requires it. */
async function exportDialog(selection = false) {
  if (!current) return status("Open a project first");
  const range = (await core.session(current.path)).range ?? undefined;
  if (selection && !range) return status("Set an in/out range first: ⌘-drag from the playhead");
  const name = basename(current.path, ".beproj");
  const { width, height, fps } = core.doc(current.path).settings;
  send().exportSheet({ name: selection ? `${name} selection` : name, ...exportPrefs(), ...(range ? { range } : {}), canvas: { width, height, fps: Math.round((fps.num / fps.den) * 100) / 100 } });
}

async function startExport({ name, folder, settings, range, overwrite }: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; overwrite?: boolean }) {
  if (!current) throw new Error("Open a project first");
  if (!name || /[/:]/.test(name)) throw new Error("Give the file a name without / or :");
  const output = join(folder, `${name}.${settings.format}`);
  if (!overwrite && existsSync(output)) throw new Error(`${basename(output)} already exists in ${basename(folder)}`);
  try {
    mkdirSync(dirname(EXPORT_FILE), { recursive: true });
    writeFileSync(EXPORT_FILE, JSON.stringify({ folder, settings }));
  } catch {}
  const job = await core.export(current.path, { output, overwrite: true, ...exportOptions(settings), colorSpace: appSettings.exportColorSpace, ...(range ? { from: range.in, to: range.out } : {}) });
  exports.set(job.id, output);
  send().exportJob({ id: job.id, output, state: "running", progress: 0 });
}

/** The Record dialog's last sources, offered next time. */
const RECORD_FILE = join(homedir(), "Library/Application Support/Beacon/record.json");
const recordPrefs = (): RecordSources => {
  try {
    return JSON.parse(readFileSync(RECORD_FILE, "utf8")) as RecordSources;
  } catch {
    return { screen: { fps: 60 }, microphone: {}, systemAudio: true };
  }
};

/** File > Record… (⌘R): the Record dialog, with what the recorder can use. */
async function recordDialog() {
  if (!current) return status("Open a project first");
  if (recording) return status("Already recording: stop from the menu bar or ⌘⇧2");
  send().recordSheet({ ...(await core.recorderDevices()), sources: recordPrefs() });
}

const STOP_SHORTCUT = "CommandOrControl+Shift+2";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
let recording: { tray: Tray; timer: ReturnType<typeof setInterval> } | undefined;

/** Record: Beacon hides while the take records; a menu-bar item shows the time and stops it, as ⌘⇧2 does. */
async function startRecording({ sources }: { sources: RecordSources }) {
  if (!current) throw new Error("Open a project first");
  if (recording) throw new Error("Already recording");
  // Asked while the window is up, so macOS's prompt has somewhere to show.
  const { permissions } = await core.recorderDevices();
  for (const kind of ["camera", "microphone"] as const) {
    if (!sources[kind] || permissions[kind] === "granted") continue;
    if ((await core.recorderAccess(kind)) !== "granted") throw new Error(`Allow Beacon in System Settings › Privacy & Security › ${kind === "camera" ? "Camera" : "Microphone"}`);
  }
  try {
    mkdirSync(dirname(RECORD_FILE), { recursive: true });
    writeFileSync(RECORD_FILE, JSON.stringify(sources));
  } catch {}
  win.hide();
  try {
    await core.recordStart(current.path, { sources });
  } catch (e) {
    win.show();
    throw e;
  }
  const tray = new Tray({ title: "● 0:00" });
  tray.setMenu([{ type: "normal", label: "Stop Recording  (⌘⇧2)", action: "stopRecording" }]);
  tray.on("tray-clicked", (e) => {
    if ((e as { data?: { action?: string } }).data?.action === "stopRecording") void stopRecording();
  });
  const started = Date.now();
  const timer = setInterval(() => tray.setTitle(`● ${clock((Date.now() - started) / 1000)}`), 1000);
  GlobalShortcut.register(STOP_SHORTCUT, () => void stopRecording());
  recording = { tray, timer };
}

/** Stops the take, imports it at the end of the timeline and brings Beacon back. */
async function stopRecording() {
  const r = recording;
  if (!r) return;
  recording = undefined;
  clearInterval(r.timer);
  GlobalShortcut.unregister(STOP_SHORTCUT);
  r.tray.remove();
  try {
    const take = await core.recordStop();
    status(`Recorded ${basename(take.take, ".brec")} (${clock(take.duration)})`);
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
  } finally {
    win.show();
    win.activate();
  }
}

/** Attaches the project's preview to the canvas's native view, or follows its new size; returns the fit zoom in percent. */
async function canvasView(id: number, rect: { x: number; y: number; width: number; height: number }, scale: number): Promise<number> {
  if (!current) return 100;
  const w = Math.max(1, Math.round(rect.width * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  if (current.view?.id !== id) {
    const native = WGPUView.getById(id);
    const layer = native?.getNativeHandle() as Pointer | null;
    if (!native || !layer) throw new Error(`no native view ${id}`);
    const live = core.attachView(current.path, { layer, width: w, height: h });
    current.view = { id, live, scale, rect };
    // The window sends marks only when they change; a new preview starts from the last ones.
    live.marks(scaledMarks(lastMarks, scale));
    if (lastSurround) live.surround(...lastSurround);
    // Stop drawing before Electrobun takes the view away (the canvas element remounted or the page reloaded).
    native.onBeforeRemove(() => {
      if (current?.view?.id !== id) return;
      core.detachView(current.path);
      current.view = undefined;
    });
  } else {
    current.view.scale = scale;
    current.view.rect = rect;
    current.view.live.resize(w, h);
  }
  // Fitted placement depends on the view's size, so it is resent whenever the view changes.
  current.view.live.place(...placement((await core.session(current.path)).canvas, current.view));
  const percent = Math.round(fitPercent(core.doc(current.path).settings, rect));
  core.setFitPercent(current.path, percent);
  return percent;
}

/** The Media Bin preview: the asset, and its view once the window's native view is up. */
let preview: { asset: string; id?: number; live?: LiveView; rect?: { width: number; height: number }; scale?: number } | undefined;

function closePreview() {
  const live = preview?.live;
  preview = undefined;
  if (!live) return;
  // Silence it now; freeing the renderer waits for its thread and decoders, so the window updates first.
  live.pause();
  setTimeout(() => live.close(), 100);
}

function previewView(id: number, rect: { x: number; y: number; width: number; height: number }, scale: number) {
  if (!current || !preview) return;
  const px = { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
  if (preview.id !== id) {
    const native = WGPUView.getById(id);
    const layer = native?.getNativeHandle() as Pointer | null;
    if (!native || !layer) throw new Error(`no native view ${id}`);
    preview.live?.close();
    let last = 0;
    const live = core.previewAsset(current.path, preview.asset, { layer, ...px }, {
      onTime: (t) => send().previewClock({ time: (last = t), playing: live.playing }),
      onEnd: () => send().previewClock({ time: last, playing: false }),
    });
    Object.assign(preview, { id, live });
    native.onBeforeRemove(() => {
      if (preview?.id === id) closePreview();
    });
  } else preview.live?.resize(px.width, px.height);
  const settings = core.assetPreviewInfo(current.path, preview.asset);
  const canvas = { width: settings.width, height: settings.height };
  preview.live?.place(...enginePlacement(canvas, px, placeCanvas(canvas, px, "fit", [0, 0], scale)));
  if (lastSurround) preview.live?.surround(...lastSurround);
}

const THUMB_HEIGHT = 64;
/** Proxies being made: from the app's own queue, and those asked for in the Media Bin. */
let proxyProgress: { queued: Record<string, number>; jobs: Record<string, number> } = { queued: {}, jobs: {} };

const thumbs = new Map<string, string>();
let thumbing = false;
/** Asked for while a pass was running: its list may miss new clips. */
let thumbAgain = false;

/** First-frame thumbnails for clips that lack one, a few at a time, sent as they are made. */
async function sendThumbs() {
  if (!current) return;
  if (thumbing) return void (thumbAgain = true);
  thumbing = true;
  thumbAgain = false;
  try {
    const h = current.path;
    const doc = core.doc(h);
    const todo = [...Object.keys(doc.assets).map((id) => `asset:${id}`), ...doc.tracks.flatMap((t) => t.clips.map((c) => c.id))].filter((id) => !thumbs.has(id));
    // A few at a time: each is an ffmpeg decode, and a large project has hundreds.
    for (let i = 0; i < todo.length && current?.path === h; i += 3) {
      const batch: Record<string, string> = {};
      await Promise.all(
        todo.slice(i, i + 3).map(async (id) => {
          const png = await (id.startsWith("asset:") ? core.assetThumbnail(h, id.slice(6), THUMB_HEIGHT * 2) : core.thumbnail(h, id, THUMB_HEIGHT)).catch(() => undefined);
          thumbs.set(id, png?.length ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : "");
          if (png?.length) batch[id] = thumbs.get(id)!;
        }),
      );
      if (Object.keys(batch).length) send().media({ thumbs: batch });
    }
  } finally {
    thumbing = false;
  }
  if (thumbAgain) await sendThumbs();
}

function sendWaveforms() {
  if (!current) return;
  const waveforms: Record<string, Record<number, number[]>> = {};
  for (const id of Object.keys(core.doc(current.path).assets)) {
    const w = core.derived<{ streams: Record<number, number[]> }>(current.path, id, "waveform");
    if (w) waveforms[id] = w.streams;
  }
  if (Object.keys(waveforms).length) send().media({ waveforms });
}

const reply = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * BEACON_DIAG=1: every 5 s, how late the event loop runs, which window messages and core events arrived and how
 * often, and the running jobs, to `~/Library/Logs/beacon-diag.log` (for a main process that keeps busy).
 */
const diag = process.env.BEACON_DIAG ? join(homedir(), "Library/Logs/beacon-diag.log") : undefined;
const calls = new Map<string, number>();
const tally = (name: string) => diag && calls.set(name, (calls.get(name) ?? 0) + 1);
function counted<T extends Record<string, (...a: never[]) => unknown>>(handlers: T): T {
  if (!diag) return handlers;
  return Object.fromEntries(Object.entries(handlers).map(([k, f]) => [k, (...a: never[]) => (tally(`rpc ${k}`), f(...a))])) as T;
}
if (diag) {
  let expected = performance.now() + 5000;
  setInterval(async () => {
    const lag = Math.round(performance.now() - expected);
    expected = performance.now() + 5000;
    const cpu = process.cpuUsage();
    const jobs = (await core.jobs()).filter((j) => j.state === "running").map((j) => `${j.kind} ${Math.round(j.progress * 100)}%`);
    appendFileSync(diag, `${new Date().toISOString()} lag ${lag} ms, cpu ${Math.round((cpu.user + cpu.system) / 1000)} ms total, ${JSON.stringify(Object.fromEntries(calls))}, jobs [${jobs.join(", ")}], playing ${current?.view?.live.playing ?? "-"}\n`);
    calls.clear();
  }, 5000);
}

const rpc = BrowserView.defineRPC<import("@beacon/ui").AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: counted({
      resync: async () => (current ? openedPayload(current.path) : undefined),
      init: async () => {
        // The webview may load after the project opened: send its pictures again once it asks.
        setTimeout(() => {
          thumbs.clear();
          sendWaveforms();
          void sendThumbs();
        }, 50);
        const schema = core.schema();
        return {
          opened: current ? await openedPayload(current.path) : undefined,
          keymap,
          propGroups: schema.props.map((p) => ({ id: p.id, description: p.description })),
          effects: schema.effects.map((e) => ({ id: e.id, description: e.description, traits: e.traits, schema: e.schema })),
          clipTypes: Object.fromEntries(schema.clipTypes.map((c) => [c.id, c.traits])),
          nested: Object.fromEntries(schema.clipTypes.flatMap((c) => (c.nested ? [[c.id, c.nested]] : []))),
          keyLog: !!keyLog,
          socket,
        };
      },
      run: ({ command, args, label, coalesce }) =>
        reply(async () => current && (await core.run(current.path, command, args ?? {}, { ...(label ? { label } : {}), ...(coalesce ? { coalesce } : {}) }))),
      query: async ({ name, args }) => {
        try {
          if (!current) throw new Error("no project is open");
          return { ok: true, result: await core.query(current.path, name, args ?? {}) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      undo: () => reply(async () => current && (await core.undo(current.path))),
      redo: () => reply(async () => current && (await core.redo(current.path))),
      openDialog: () => reply(openDialog),
      chooseFolder: async ({ start }) => (await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: start }))[0] || null,
      startExport: (params) => reply(() => startExport(params)),
      startRecording: (params) => reply(() => startRecording(params)),
      recordPreview: (devices) => reply(() => core.recorderPreview(devices, (e) => send().recordPreview(e))),
      cancelExport: ({ id }) => reply(() => core.cancelJob(id)),
      setAppSettings: (next) => setAppSettings(next),
      proxySpace: () => core.analysisSize("proxy"),
      deleteAllProxies: async () => (await core.forgetAll("proxy"), core.analysisSize("proxy")),
      newProject: ({ name, settings }) => reply(() => createProject(name, settings)),
      previewOpen: ({ asset }) => {
        closePreview();
        if (!current) return null;
        void core.run(current.path, "playback.pause", {});
        preview = { asset };
        return core.assetPreviewInfo(current.path, asset);
      },
      previewView: ({ id, x, y, width, height, scale }) => previewView(id, { x, y, width, height }, scale),
      previewControl: ({ op, time = 0 }) => {
        const live = preview?.live;
        if (op === "close") return closePreview();
        if (!live) return;
        if (op === "play") return live.play(time);
        // A seek while playing carries on from there.
        const playing = live.playing;
        live.pause();
        if (op === "seek" && playing) return live.play(time);
        send().previewClock({ time: op === "seek" ? live.show(time) : time, playing: false });
      },
      renameProject: ({ name }) => reply(() => renameProject(name)),
      showFile: ({ path, open }) => {
        if (open) Bun.spawn(["open", path]);
        else Utils.showItemInFolder(path);
      },
      // Right-click on the canvas away from any clip.
      canvasMenu: async () => {
        if (!current) return;
        const clipboard = !!(await core.session(current.path)).clipboard;
        ContextMenu.showContextMenu([
          { label: "Project Settings…", action: "app:projectSettings" },
          { type: "separator" },
          { label: "Paste", action: "run:edit.paste", enabled: clipboard },
          { label: "Zoom to Fit", action: "run:canvas.zoom:fit" },
        ]);
      },
      clipMenu: async ({ clip, canvas }) => {
        if (!current) return;
        // The clip menu, acting on the selection (the clicked clip is selected first). Items for later phases are shown disabled.
        const item = (label: string, action?: string) => ({ label, ...(action ? { action: `${action}:${clip}` } : { enabled: false }) });
        const sep = { type: "separator" as const };
        const colors = ["Red", "Purple", "Blue", "Green", "Yellow", "Orange", "Default"].map((c) => item(c));
        // Inside an opened group the clicked clip is one of its own.
        const target = [...walkClips(core.doc(current.path).tracks, core.registry)].find((l) => l.clip.id === clip)?.clip;
        const linked = !!target?.linkId;
        const many = (await core.session(current.path)).selection.length > 1;
        ContextMenu.showContextMenu([
          item("Cut", "edit.cut"),
          item("Copy", "edit.copy"),
          sep,
          item("Delete", "edit.delete"),
          item("Ripple Cut", "edit.rippleCut"),
          item("Ripple Delete", "edit.rippleDelete"),
          ...(linked ? [sep, item("Unlink Recording", "unlink")] : []),
          sep,
          item("Hide Properties", "hideProperties"),
          sep,
          item("Select in Media Bin", "selectInBin"),
          sep,
          item("Copy Properties", "edit.copyProperties"),
          item("Paste Properties", "edit.pasteProperties"),
          sep,
          ...(target?.type === "group" ? [item("Open Group", "openGroup"), item("Ungroup", "edit.ungroup")] : [item("Group", "edit.group")]),
          ...(target?.type === "stitched" ? [item("Remove All Stitches", "edit.unstitch")] : many ? [item("Stitch Selected Media", "edit.stitch")] : []),
          sep,
          { label: "Add Color Label", submenu: colors },
          sep,
          item("Add Clip Speed", "clipSpeed"),
          sep,
          item("Split at Playhead", "edit.split"),
          // From the canvas, where media usually covers it all, the canvas's own items too.
          ...(canvas ? [sep, { label: "Project Settings…", action: "app:projectSettings" }, { label: "Zoom to Fit", action: "run:canvas.zoom:fit" }] : []),
        ]);
      },
      importMedia: () => void importMedia().catch((e: Error) => status(e.message)),
      binMenu: ({ asset }) => {
        if (!current) return;
        const used = [...walkClips(core.doc(current.path).tracks, core.registry)].some((l) => l.clip.assetId === asset);
        const item = (label: string, op: string, enabled = true) => ({ label, action: `media:${op}:${asset}`, enabled });
        const sep = { type: "separator" as const };
        const a = core.doc(current.path).assets[asset];
        const proxyable = !!a && !!core.registry.jobAnalyzers.get("proxy")?.applies(a);
        const hasProxy = core.derived(current.path, asset, "proxy") !== undefined;
        const making = asset in proxyProgress.queued || asset in proxyProgress.jobs;
        const missing = !!a && !existsSync(a.path);
        ContextMenu.showContextMenu([
          ...(missing ? [item("Locate Media…", "locate"), sep] : []),
          item("Add to Timeline at Playhead", "add"),
          ...(proxyable ? [{ label: "Proxy Video", submenu: [item("Create Proxy Video", "proxyCreate", !hasProxy && !making), item("Delete Proxy Video", "proxyDelete", hasProxy || making)] }] : []),
          sep,
          item("Delete", "delete"),
          item("Rename…", "rename"),
          sep,
          item("Reveal in Finder", "reveal"),
          item("Select on Timeline", "select", used),
          sep,
          item("Import Media…", "import"),
        ]);
      },
      dropFiles: ({ files, time, track }) =>
        reply(async () => importPaths(await findDropped(files), { time, track })),
      trackMenu: ({ track }) => {
        if (!current) return;
        const sep = { type: "separator" as const };
        if (track === null) {
          ContextMenu.showContextMenu([
            { label: "Insert Track", action: "track:insertTop:" },
            { label: "Remove All Empty Tracks", action: "track:removeEmpty:" },
            sep,
            { label: "Enable Timeline Snapping", action: "run:timeline.snapping" },
          ]);
          return;
        }
        const found = trackAt(current.path, track);
        if (!found) return;
        const { track: t, top } = found;
        const item = (label: string, op: string) => ({ label, action: `track:${op}:${track}` });
        ContextMenu.showContextMenu([
          // A group's own tracks come with it; tracks are added on the main timeline.
          ...(top ? [item("Insert Track Above", "insertAbove"), item("Insert Track Below", "insertBelow"), sep] : []),
          item("Rename…", "rename"),
          item(t.locked ? "Unlock Track" : "Lock Track", "lock"),
          item(t.magnetic ? "Disable Magnetic Track" : "Enable Magnetic Track", "magnetic"),
          item(t.hidden ? "Enable Track" : "Disable Track", "hidden"),
          sep,
          item("Remove Track", "remove"),
          item("Remove All Empty Tracks", "removeEmpty"),
        ]);
      },
      captureFrame: () =>
        reply(async () => {
          if (!current) return;
          // A folder chosen in Settings that has since gone: the project's own media folder instead.
          const folder = appSettings.snapshotFolder && existsSync(appSettings.snapshotFolder) ? appSettings.snapshotFolder : undefined;
          if (appSettings.snapshotFolder && !folder) status(`${appSettings.snapshotFolder} is missing: saved in the project's media folder`);
          const r = await core.captureFrame(current.path, undefined, folder ? { folder } : {});
          send().snapshotSaved({ path: r.path });
          send().media({ highlight: r.asset });
          void sendThumbs();
        }),
      frameImage: async () => {
        if (!current) return null;
        const img = await core.frame(current.path, (await core.session(current.path)).playhead);
        return `data:image/png;base64,${Buffer.from(img.png).toString("base64")}`;
      },
      canvasView: async ({ id, x, y, width, height, scale, surround }) => {
        lastSurround = surround;
        return { fitPercent: await canvasView(id, { x, y, width, height }, scale) };
      },
    }),
    messages: counted({
      shown: (s) => void (shown = s),
      keyLog: ({ line }) => keyLog && appendFileSync(keyLog, `${new Date().toISOString()} ${line}\n`),
      canvasMarks: ({ marks }) => {
        const v = current?.view;
        if (!v) return;
        // Positions are canvas pixels; sizes are points, drawn in physical pixels.
        lastMarks = marks;
        v.live.marks(scaledMarks(marks, v.scale));
      },
    }),
  },
});

// Cut, copy and paste stay roles: they reach the webview as clipboard events, which run the edit actions
// there and keep text fields working. The rest run commands here, without key equivalents: the webview's keymap has them.
const run = (action: string) => ({ label: MENU[action]!, action: `run:${action}` });
const MENU: Record<string, string> = {
  "edit.delete": "Delete",
  "edit.rippleCut": "Ripple Cut",
  "edit.rippleDelete": "Ripple Delete",
  "edit.duplicate": "Duplicate",
  "edit.silenceAudio": "Silence Audio",
  "edit.restoreAudio": "Restore Audio",
  "edit.addAudioPoint": "Add Audio Point",
  "edit.split": "Split",
  "edit.splitAll": "Split All",
  "edit.trimToPlayhead:start": "Trim Start to Playhead",
  "edit.trimToPlayhead:end": "Trim End to Playhead",
  "selection.all": "Select All",
  "selection.side:left": "All Timeline to Left",
  "selection.side:right": "All Timeline to Right",
  "selection.clear": "Deselect All",
  "edit.addMarker": "Add Timeline Marker",
  "timeline.snapping": "Enable Timeline Snapping",
};
function setMenu() {
  ApplicationMenu.setApplicationMenu([
    { submenu: [{ role: "about" }, { type: "separator" }, { label: "Settings…", action: "settings", accelerator: "command+," }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { label: "Quit Beacon", action: "quit", accelerator: "command+q" }] },
    {
      label: "File",
      submenu: [
        { label: "New Project", action: "new", accelerator: "command+n" },
        // ⌘O is handled by the window's own keys.
        { label: "Open Project…  (⌘O)", action: "open" },
        {
          label: "Open Recent",
          submenu: [
            ...recent.map((path) => ({ label: basename(path, ".beproj"), action: `recent:${path}` })),
            ...(recent.length ? [{ type: "separator" as const }] : []),
            { label: "Clear Menu", action: "recentClear", enabled: recent.length > 0 },
          ],
        },
        { type: "separator" },
        { label: "Import Media…", action: "import", accelerator: "command+i" },
        { label: "Record…", action: "record", accelerator: "command+r" },
        { type: "separator" },
        { label: "Export…", action: "export", accelerator: "command+e" },
        { label: "Export Selection…", action: "exportSelection" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", action: "undo" },
        { label: "Redo", action: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        run("edit.delete"),
        run("edit.rippleCut"),
        // WKWebView swallows ⌘⌫ before the page sees it, so the menu owns the key and hands it back to the window's keymap.
        { label: "Ripple Delete", action: "key:command+Backspace", accelerator: "command+backspace" },
        run("edit.duplicate"),
        { type: "separator" },
        run("edit.silenceAudio"),
        run("edit.restoreAudio"),
        run("edit.addAudioPoint"),
        { type: "separator" },
        run("edit.split"),
        run("edit.splitAll"),
        { type: "separator" },
        { label: "Select", submenu: [run("selection.all"), run("selection.side:left"), run("selection.side:right")] },
        run("selection.clear"),
        { label: "Playhead", submenu: [run("edit.trimToPlayhead:start"), run("edit.trimToPlayhead:end")] },
        { type: "separator" },
        run("edit.addMarker"),
      ],
    },
    { label: "View", submenu: [run("timeline.snapping")] },
    {
      label: "Window",
      submenu: [
        { role: "minimize", accelerator: "command+m" },
        { role: "zoom" },
        { type: "separator" },
        { role: "toggleFullScreen", accelerator: "control+command+f" },
        { role: "bringAllToFront" },
      ],
    },
  ]);
}
setMenu();

/** "selection.side:left" → command and args from the menu table's key. */
function menuCommand(key: string): [string, unknown] {
  const [command, arg] = key.split(":");
  if (command === "edit.trimToPlayhead") return [command, { edge: arg }];
  if (command === "selection.side") return [command, { side: arg }];
  if (command === "canvas.zoom") return [command, { zoom: arg }];
  return [command!, {}];
}
ContextMenu.on("context-menu-clicked", (e) => {
  const action = String((e as { data?: { action?: string } }).data?.action ?? "");
  if (current && action.startsWith("run:")) return void core.run(current.path, ...menuCommand(action.slice(4))).catch((err: Error) => status(err.message));
  if (current && action.startsWith("track:")) return trackAction(current.path, action.split(":")[1]!, action.split(":")[2]!);
  if (current && action.startsWith("media:")) return mediaAction(current.path, action.split(":")[1]!, action.split(":")[2]!);
  if (action === "app:projectSettings") return void send().settingsSheet({ ...appSettings, tab: "project" });
  const [op, clip] = action.split(":");
  if (!current || !clip) return;
  const h = current.path;
  const run = (command: string, args: unknown = {}) => core.run(h, command, args).catch((err: Error) => status(err.message));
  if (op!.startsWith("edit.")) void run(op!);
  else if (op === "unlink") void run("clip.unlink", { clip });
  else if (op === "openGroup") void run("group.open", { clip });
  // The clip's properties gain a Speed tab.
  else if (op === "clipSpeed") {
    send().showClipSpeed({ clip });
    void run("panel.show", { properties: true });
    void run("inspector.tab", { tab: "speed" });
  }
  else if (op === "hideProperties") void run("panel.show", { properties: false });
  else if (op === "selectInBin") {
    const asset = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip)?.assetId;
    void run("panel.show", { tool: "media" });
    if (asset) send().media({ highlight: asset });
  }
});

/** Locate Media…: the moved file, picked in Finder, starting where the media was. */
async function locateMedia(h: string, asset: string) {
  const a = core.doc(h).assets[asset];
  if (!a) return;
  let start = dirname(a.path);
  while (!existsSync(start) && start !== "/") start = dirname(start);
  const [file] = await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false, startingFolder: start, allowedFileTypes: extname(a.path).slice(1) });
  if (!file) return;
  await core.relink(h, asset, file);
  status(`Found ${basename(file)}`);
}

/** Media Bin menu items. */
function mediaAction(h: string, op: string, asset: string) {
  const fail = (err: Error) => status(err.message);
  const a = core.doc(h).assets[asset];
  if (!a) return;
  if (op === "add") void core.run(h, "edit.addMedia", { asset }).catch(fail);
  else if (op === "delete") void core.run(h, "edit.deleteMedia", { asset }).catch(fail);
  else if (op === "rename") send().renameMedia({ asset });
  else if (op === "reveal") Bun.spawn(["open", "-R", a.path]);
  else if (op === "select") void core.run(h, "edit.selectMedia", { asset }).catch(fail);
  else if (op === "import") void importMedia().catch(fail);
  else if (op === "proxyCreate") void core.analyze(h, "proxy", asset).catch(fail);
  else if (op === "proxyDelete") void core.forget(h, "proxy", asset).catch(fail);
  else if (op === "locate") void locateMedia(h, asset).catch(fail);
}

/** A track on the timeline or inside a group, and whether it is a timeline one. */
function trackAt(h: string, id: string) {
  const doc = core.doc(h);
  try {
    const { track, list } = locateTrack(doc, id, core.registry);
    return { track, top: list === doc.tracks, index: list.indexOf(track) };
  } catch {
    return undefined;
  }
}

/** Track menu items, as track commands. */
function trackAction(h: string, op: string, track: string) {
  const found = track ? trackAt(h, track) : undefined;
  const t = found?.track;
  const index = found?.index ?? -1;
  const name = "";
  const fail = (err: Error) => status(err.message);
  if (op === "insertTop") void core.run(h, "track.add", { name }, { label: "Insert Track" }).catch(fail);
  else if (op === "removeEmpty") void core.run(h, "track.removeEmpty", {}, { label: "Remove All Empty Tracks" }).catch(fail);
  else if (!t) return;
  else if ((op === "insertAbove" || op === "insertBelow") && !found?.top) return;
  else if (op === "insertAbove") void core.run(h, "track.add", { name, index: index + 1 }, { label: "Insert Track" }).catch(fail);
  else if (op === "insertBelow") void core.run(h, "track.add", { name, index }, { label: "Insert Track" }).catch(fail);
  else if (op === "rename") send().rename({ track });
  else if (op === "lock") void core.run(h, "track.set", { track, locked: !t.locked }, { label: t.locked ? "Unlock Track" : "Lock Track" }).catch(fail);
  else if (op === "magnetic") void core.run(h, "track.set", { track, magnetic: !t.magnetic }, { label: "Magnetic Track" }).catch(fail);
  else if (op === "hidden") void core.run(h, "track.set", { track, hidden: !t.hidden }, { label: t.hidden ? "Enable Track" : "Disable Track" }).catch(fail);
  else if (op === "remove") void core.run(h, "track.remove", { track }, { label: "Remove Track" }).catch(fail);
}

ApplicationMenu.on("application-menu-clicked", (e) => {
  const action = (e as { data?: { action?: string } }).data?.action;
  const report = (err: unknown) => status(err instanceof Error ? err.message : String(err));
  if (action === "open") return void openDialog().catch(report);
  if (action === "new") return newProject();
  if (action === "import") return void importMedia().catch(report);
  if (action === "record") return void recordDialog().catch(report);
  if (action === "export") return void exportDialog().catch(report);
  if (action === "exportSelection") return void exportDialog(true).catch(report);
  if (action === "recentClear") return setRecent([]);
  if (action === "settings") return send().settingsSheet(appSettings);
  // Its own item rather than the Quit role, which ⌘Q did not reach (2026-10-12): close everything, then let Electrobun exit.
  if (action === "quit") {
    quitLog("⌘Q");
    quit();
    return void Utils.quit();
  }
  if (action?.startsWith("key:")) {
    const [mods, code] = action.slice(4).split("+") as [string, string];
    return send().key({ code, meta: mods === "command" });
  }
  if (action?.startsWith("recent:")) {
    const path = action.slice(7);
    if (existsSync(path)) return void open(path).catch(report);
    setRecent(recent.filter((p) => p !== path));
    return status(`${path} no longer exists`);
  }
  if (!current) return;
  const h = current.path;
  const fail = (err: Error) => status(err.message);
  if (action === "undo") core.undo(h).catch(fail);
  else if (action === "redo") core.redo(h).catch(fail);
  else if (action?.startsWith("run:")) core.run(h, ...menuCommand(action.slice(4))).catch(fail);
});

const win = new BrowserWindow({
  title: "Beacon",
  url: "views://mainview/index.html",
  rpc,
  frame: { x: 80, y: 60, width: 1600, height: 1000 },
  titleBarStyle: "hiddenInset",
  // Agents and tests can start the app without taking focus from the user.
  activate: process.env.BEACON_BACKGROUND !== "1",
});

const server = serveCore(core, { path: socket, canOpen: (p) => current?.path === resolve(p) });
core.setSnapshotter(async () => {
  const png = await captureWindow(windowNumber(win.ptr as Pointer));
  const v = current?.view;
  // The capture is in pixels; the webview lays out in points from the window's top-left.
  const scale = v?.scale ?? 2;
  const canvas = v && { x: v.rect.x * scale, y: v.rect.y * scale, width: v.rect.width * scale, height: v.rect.height * scale };
  const s = shown;
  const text =
    s &&
    `${s.project}: ${s.tracks} tracks, ${s.clips} clips, ${s.markers} markers; playhead ${s.playhead.toFixed(2)} s; ` +
      `selected ${s.selection.length ? s.selection.join(", ") : "nothing"}; timeline ${s.timeline.start.toFixed(2)}–${s.timeline.end.toFixed(2)} s; ` +
      `tool panel ${s.tool ?? "closed"}; properties ${s.properties ?? "closed"}`;
  return { png, canvas, scale, shown: text };
});

const initial = process.env.BEACON_PROJECT ?? process.argv.find((a) => a.endsWith(".beproj"));
if (initial) await open(initial).catch((e) => status(String(e)));

let stopped = false;
/** Each quit's steps, timed, appended to ~/Library/Logs/beacon-quit.log: where a quit stalls. */
const quitLog = (step: string) => {
  try {
    appendFileSync(join(homedir(), "Library/Logs/beacon-quit.log"), `${new Date().toISOString()} ${step}\n`);
  } catch {}
};
// Stops decoders and playback, releases the project lock and the socket.
const quit = () => {
  if (stopped) return;
  stopped = true;
  quitLog("closing");
  server.stop();
  core.closeAll();
  quitLog("closed");
};
Electrobun.events.on("before-quit", quit);
process.on("exit", quit);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
