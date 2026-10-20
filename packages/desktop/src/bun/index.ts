import { appendFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Pointer } from "bun:ffi";
import Electrobun, { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import type { ProjectWindow } from "./app";
import { patchInfoPlist } from "./info-plist";
import { checkForUpdates, checkForUpdatesSoon } from "./updates";

// The engine and Beacon's own ffmpeg, ffprobe and whisper-cli ship inside the app; set before anything loads them.
const engineDir = join(import.meta.dir, "../engine");
if (existsSync(join(engineDir, "libbeacon_ffi.dylib"))) {
  process.env.BEACON_FFI_PATH ??= join(engineDir, "libbeacon_ffi.dylib");
  process.env.BEACON_WORKER_PATH ??= join(engineDir, "beacon-worker");
  process.env.BEACON_RECORDER_PATH ??= join(engineDir, "beacon-recorder");
  process.env.BEACON_TOOLS_DIR ??= engineDir;
}

// `electrobun dev` builds and launches in one step, so a dev bundle gets its Info.plist entries here (a built one
// has them from build-hook.ts); Launch Services then learns the `.brec` package type.
const bundle = import.meta.dir.match(/^(.*?\.app)\/Contents\//)?.[1];
if (bundle && patchInfoPlist(join(bundle, "Contents/Info.plist"))) {
  Bun.spawnSync(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", bundle]);
}

const { captureWindow, DEFAULT_SOCKET, focusPage, LocalCore, serveCore, windowNumber } = await import("@beacon/core");
const { initPayload, appBridge, coreRequests, projectBridge, settingsSheet } = await import("@beacon/ui");
const { createRecording } = await import("./recording");
const { createMenus } = await import("./menus");
const { createProjects } = await import("./projects");
const { createViews } = await import("./views");
const { createWindowMedia } = await import("./window-media");
const { createExports } = await import("./exports");
const { errorText } = await import("./app");
type ShortcutInfo = import("@beacon/core").ShortcutInfo;
type Send = import("@beacon/ui").Send;

const socket = process.env.BEACON_SOCKET ?? DEFAULT_SOCKET;
const keyLog = process.env.BEACON_KEYLOG ? join(homedir(), "Library/Logs/beacon-keys.log") : undefined;
const core = new LocalCore({ socket, reveal: (path) => Utils.showItemInFolder(path) });
/** Every action with its keys, the user's over the defaults: the menus show them. */
let shortcuts = await core.shortcuts();

/** One editor window: its project (none on the start screen), native views, Media Bin pictures and exports. */
interface Win extends ProjectWindow {
  win: BrowserWindow;
  /** What the window last said it shows, for `ui_snapshot`. */
  shown?: import("@beacon/ui").Shown;
  views: ReturnType<typeof createViews>;
  media: ReturnType<typeof createWindowMedia>;
  exports: ReturnType<typeof createExports>;
}

/**
 * The editor windows, one per project (macOS's Merge All Windows makes them tabs), and the one menus and keys act
 * on. Each keeps its project, its native canvas and its messages; core holds the projects.
 */
const windows = new Set<Win>();
let focused: Win | undefined;

const winFor = (h: string) => [...windows].find((w) => w.current?.path === h);
/** Messages for every window: what concerns the app (keys, favourites, settings, recent projects). */
const broadcast: Send = (type, data) => {
  for (const w of windows) w.message(type, data);
};
/** The focused window's status line, for what isn't one window's. */
const status = (text: string) => focused?.status(text);
const report = (err: unknown) => status(errorText(err));

async function openedPayload(w: Win, h: string): Promise<import("@beacon/ui").Opened> {
  return { path: h, name: basename(h, ".beproj"), project: core.doc(h), session: await core.session(h), rev: w.current?.path === h ? w.current.bridge.rev() : 0 };
}

/** Set while core saves a window's own change: its "settings" event isn't sent back to that window, over a newer change; the others take it. */
let changedBy: Win | undefined;
/** A change from a Settings window (which shows it already) or Check Sync; core keeps them and applies them. */
function setAppSettings(patch: import("@beacon/ui").SettingsPatch, from?: Win) {
  changedBy = from;
  // Core tells the change before its promise settles, while this is still set.
  core.setSettings(patch).catch((e: unknown) => (from ?? focused)?.status(`could not save settings: ${errorText(e)}`));
  changedBy = undefined;
}

/** Keys rebound (here, by an agent, or in another process's keymap.json): the menus and the windows show them. */
function shortcutsChanged(next: ShortcutInfo[]): ShortcutInfo[] {
  shortcuts = next;
  menus.setMenu();
  broadcast("shortcuts", { shortcuts: next });
  return next;
}

/**
 * An agent's MCP server, with the project not open here, runs its own core and writes the same app-wide files:
 * follow them, so the menus, keys, favourites and settings here don't stay stale (and aren't saved back over it).
 */
function followConfig() {
  const reload: Record<string, () => void> = {
    "settings.json": () => void core.reloadSettings(),
    "keymap.json": () => void core.shortcuts().then((next) => Bun.deepEquals(next, shortcuts) || shortcutsChanged(next)),
    "favorites.json": () => void core.favorites().then((items) => broadcast("favorites", { items })),
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  try {
    mkdirSync(core.configDir, { recursive: true });
    watch(core.configDir, (_, name) => {
      const file = String(name ?? "").replace(/\.tmp$/, "");
      if (!reload[file]) return;
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(reload[file]!, 100));
    });
  } catch (e) {
    status(`won't see agents' changes to settings: ${errorText(e)}`);
  }
}
followConfig();

/** Resources offered this session: the dialog asks once, not on every import. */
const offered = new Set<string>();
/** An import's analysis waits for a resource (the speech model): ask in `w`, unless the user said Not Now before. */
async function offerResource(w: Win, r: import("@beacon/core").ResourceInfo) {
  if (r.present || r.job || offered.has(r.id)) return;
  offered.add(r.id);
  if ((await core.settings()).declinedResources?.includes(r.id)) return w.status(`No transcript: the ${r.title} isn't downloaded (Settings › Transcripts)`);
  w.message("resourceSheet", r);
}
/** A download's progress, for the resource dialog and the status line. */
function resourceJob(job: import("@beacon/core").JobInfo) {
  broadcast("resourceJob", { id: job.id, state: job.state, progress: job.progress, ...(job.error ? { error: job.error } : {}) });
  if (job.state === "done") status(`${job.label.replace(/^Download /, "")} downloaded: transcripts are being made`);
  else if (job.state === "failed" && job.error !== "cancelled") status(`${job.label}: ${job.error}`);
}

/** Beacon > Settings…, in `w`, with the cameras and microphones Settings › Recording picks from. */
async function openSettings(w: Win, tab?: import("@beacon/ui").SettingsTab) {
  const d = await core.recorderDevices().catch(() => undefined);
  const prefs = recorder.recordPrefs();
  const devices = d && { displays: d.displays, display: prefs.screen?.display, outputs: d.outputs, cameras: d.cameras, microphones: d.microphones, camera: prefs.camera?.id, microphone: prefs.microphone?.id };
  w.message("settingsSheet", await settingsSheet(core, { ...(tab ? { tab } : {}), ...(devices ? { devices } : {}) }));
}

const projects = createProjects({
  core,
  focused: () => focused,
  windows: () => windows,
  newWindow: () => openWindow(),
  openFileDialog: (opts) => Utils.openFileDialog(opts),
  watch: (target, h) => {
    const w = target as Win;
    return projectBridge(core, h, w.message, {
      every: (e) => tally(`event ${e.kind}`),
      changed: () => {
        void w.media.sendThumbs();
        void w.media.sendMissing();
      },
      session: (changes) => {
        if (changes.canvas) w.views.place(changes.canvas);
        if (changes.playing) void projects.playing(w);
      },
      other: (e) => {
        if (e.kind === "saved") {
          w.message("saved", { ok: true });
          projects.saveProjectThumbSoon(h);
        } else if (e.kind === "needs") void offerResource(w, e.resource);
        else if (e.kind === "narrated") recorder.narrationEnded(e.result);
        else if (e.kind === "error") {
          if (e.message.startsWith("could not save")) w.message("saved", { ok: false });
          if (e.message.startsWith("narration:")) recorder.narrationEnded();
          w.status(e.message);
        } else if (e.kind === "job" && e.job.kind !== "export") {
          if (e.job.state === "failed" && e.job.error !== "cancelled") w.status(`${e.job.label}: ${e.job.error}`);
          if (e.job.state === "done" && e.job.kind === "proxy") void w.media.sendThumbs();
        }
      },
    });
  },
  leaving: (target) => {
    if (recording === target) recorder.narrationEnded();
  },
  shown: async (target, h, canvas) => {
    const w = target as Win;
    w.win.setTitle(`${basename(h)} — Beacon`);
    w.message("opened", await openedPayload(w, h));
    if (canvas) await w.views.canvasView(canvas.id, canvas.rect, canvas.scale);
    w.current?.bridge.sendWaveforms(true);
    w.media.resend();
    if (w === focused) menus.setMenu();
  },
  recentChanged: () => {
    menus.setMenu();
    broadcast("recent", projects.recentProjects());
  },
});

/** The app's own actions, from their menu items, the command palette or keys a window matched, in that window. */
function appAction(id: string, w: Win | undefined = focused): void {
  if (id === "app.open") return void projects.openDialog().catch(report);
  if (id === "app.checkUpdates") return void checkForUpdates({ status, stopped: () => stopped });
  // With every window closed (the app stays up while the recorder's are open), one comes back for it.
  const target = w ?? openWindow();
  if (id === "app.new") return void projects.newProject(target);
  if (id === "app.import") return void projects.importMedia(target).catch(report);
  if (id === "app.record") return void openRecord(target);
  if (id === "app.narration") return void openRecord(target, "narration");
  if (id === "app.export") return void target.exports.exportDialog().catch(report);
  if (id === "app.exportSelection") return void target.exports.exportDialog(true).catch(report);
  if (id === "app.saveAs") return void projects.saveAsDialog(target);
  if (id === "app.reveal") return void (target.current && core.reveal(target.current.path).catch(report));
  if (id === "app.settings") return void openSettings(target);
  if (id === "app.shortcuts") return void openSettings(target, "shortcuts");
  if (id === "app.projectSettings") return void target.message("projectSettings", {});
  if (id === "app.palette") return void target.message("palette", {});
}

const menus = createMenus({
  core,
  message: (type, data) => focused?.message(type, data),
  status,
  current: () => focused?.current,
  shortcuts: () => shortcuts,
  recent: projects.recent,
  openRecent: projects.openRecent,
  clearRecent: projects.clearRecent,
  appAction: (id) => appAction(id),
  quit: () => {
    quitLog("⌘Q");
    quit();
  },
});
menus.setMenu();

/** As `reply`, with what `fn` returned. */
const replyWith = async <T,>(fn: () => Promise<T>): Promise<{ ok: boolean; error?: string; result?: T }> => {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
};
const reply = async (fn: () => Promise<unknown>) => {
  const r = await replyWith(fn);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
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
    const playing = [...windows].map((w) => (w.current && core.view(w.current.path)?.playing) ?? "-").join("/");
    appendFileSync(diag, `${new Date().toISOString()} lag ${lag} ms, cpu ${Math.round((cpu.user + cpu.system) / 1000)} ms total, ${JSON.stringify(Object.fromEntries(calls))}, jobs [${jobs.join(", ")}], windows ${windows.size}, playing ${playing}\n`);
    calls.clear();
  }, 5000);
}

/** The window the recorder serves: the Record dialog's or narration's; while a take or narration is under way, it stays theirs. */
let recording: Win | undefined;
function recordFor(w: Win) {
  if (!recorder.busy()) recording = w;
}
function openRecord(w: Win, mode?: import("@beacon/ui").RecordMode) {
  if (recorder.busy()) return w.status("Already recording or narrating: stop it first");
  recording = w;
  void recorder.recordDialog(mode).catch((e: unknown) => w.status(errorText(e)));
}

/** A new editor window, a little down and right of the focused one; it shows the start screen until a project opens in it. */
function openWindow(): Win {
  const at = focused?.win.getFrame();
  const w = {} as Win;
  const rpc = BrowserView.defineRPC<import("@beacon/ui").AppRPC>({
    maxRequestTime: 120_000,
    handlers: {
      requests: counted({
        ...coreRequests(core, () => w.current?.path, (text) => w.status(text)),
        resync: async () => (w.current ? openedPayload(w, w.current.path) : undefined),
        init: async () => {
          // The webview may load after the project opened: send its pictures again once it asks.
          setTimeout(() => {
            w.current?.bridge.sendWaveforms(true);
            w.media.resendThumbs();
          }, 50);
          return {
            ...(await initPayload(core)),
            opened: w.current ? await openedPayload(w, w.current.path) : undefined,
            recent: projects.recentProjects(),
            keyLog: !!keyLog,
            socket,
          };
        },
        openDialog: () => reply(projects.openDialog),
        openRecent: ({ path }) => projects.openRecent(path),
        chooseFolder: async ({ start }) => (await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: start }))[0] || null,
        chooseFile: async ({ extensions }) => (await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false, startingFolder: "~/", allowedFileTypes: extensions.join(",") }))[0] || null,
        startExport: (params) => reply(() => w.exports.startExport(params)),
        startRecording: (params) => (recordFor(w), reply(() => recorder.startRecording(params))),
        narrationDevices: async () => ({ ...(await core.recorderDevices()), sources: recorder.recordPrefs(), hear: recorder.narrationHear() }),
        openRecord: ({ mode }) => openRecord(w, mode),
        startNarration: (params) => (recordFor(w), reply(() => recorder.startNarration(params))),
        stopNarration: (params) => reply(() => recorder.stopNarration(params)),
        recordPreview: (devices) => {
          recorder.clearFrames();
          return reply(() =>
            core.recorderPreview(devices, (e) => {
              if (!("devicesChanged" in e)) return recorder.previewEvent(e, (p) => w.message("recordPreview", p));
              void core.recorderDevices().then((d) => w.message("recordDevices", d), () => {});
            }),
          );
        },
        recordFrames: ({ after }) => recorder.newerFrames(after),
        testBeep: (params) => recorder.testBeep(params),
        checkSync: (params) => replyWith(() => recorder.checkSync(params)),
        setAppSettings: (next) => setAppSettings(next, w),
        newProject: ({ name, settings, standalone }) => reply(() => projects.createProject(name, settings, standalone)),
        saveAs: (params) => reply(() => projects.saveAs(w, params)),
        fetchResource: ({ id }) => replyWith(async () => (await core.fetchResource(id)).id),
        declineResource: async ({ id }) => setAppSettings({ declinedResources: [...new Set([...((await core.settings()).declinedResources ?? []), id])] }, w),
        shortcutSet: ({ action, keys, replace }) => replyWith(() => core.shortcutSet(action, keys, replace)),
        shortcutReset: ({ action }) => replyWith(() => core.shortcutReset(action)),
        appAction: ({ action }) => appAction(action, w),
        previewOpen: ({ asset }) => w.views.previewOpen(asset),
        previewView: ({ id, x, y, width, height, scale }) => w.views.previewView(id, { x, y, width, height }, scale),
        previewControl: ({ op, time }) => w.views.previewControl(op, time),
        renameProject: ({ name }) => reply(() => projects.renameProject(w, name)),
        showFile: ({ path, open }) => {
          if (open) Bun.spawn(["/usr/bin/open", path]);
          else Utils.showItemInFolder(path);
        },
        canvasMenu: () => menus.canvasMenu(),
        clipMenu: (params) => menus.clipMenu(params),
        importMedia: () => void projects.importMedia(w).catch((e: unknown) => w.status(errorText(e))),
        binMenu: (params) => menus.binMenu(params),
        dropFiles: ({ files, time, track }) => reply(() => projects.dropFiles(w, files, { time, track })),
        trackMenu: (params) => menus.trackMenu(params),
        captureFrame: () =>
          reply(async () => {
            if (!w.current) return;
            // Core saves in Settings' folder, or the project's media folder when it's gone: say which.
            const chosen = (await core.settings()).snapshotFolder;
            if (chosen && !existsSync(chosen)) w.status(`${chosen} is missing: saved in the project's media folder`);
            const r = await core.captureFrame(w.current.path);
            w.message("snapshotSaved", { path: r.path });
            w.message("media", { highlight: r.asset });
            void w.media.sendThumbs();
          }),
        canvasView: async ({ id, x, y, width, height, scale, surround }) => ({ fitPercent: await w.views.canvasView(id, { x, y, width, height }, scale, { surround }) }),
      }),
      messages: counted({
        shown: (s) => void (w.shown = s),
        keyLog: ({ line }) => keyLog && appendFileSync(keyLog, `${new Date().toISOString()} ${line}\n`),
        canvasMarks: ({ marks }) => w.views.marks(marks),
      }),
    },
  });
  const win = new BrowserWindow({
    title: "Beacon",
    url: "views://mainview/index.html",
    rpc,
    frame: { x: (at?.x ?? 50) + 30, y: (at?.y ?? 30) + 30, width: at?.width ?? 1600, height: at?.height ?? 1000 },
    titleBarStyle: "hiddenInset",
    // Agents and tests can start the app without taking focus from the user.
    activate: process.env.BEACON_BACKGROUND !== "1",
  });
  const message: Send = (type, data) => (win.webview.rpc!.send[type] as (d: typeof data) => void)(data);
  const part = { core, message, status: (text: string) => message("status", { text }), current: () => w.current };
  Object.assign(w, { win, message, status: part.status, activate: () => win.activate(), views: createViews(part), media: createWindowMedia(part), exports: createExports(part) });
  windows.add(w);
  focused ??= w;
  // Coming back from another app, Electrobun gives the keys to the canvas's native view: shortcuts waited for a click.
  win.on("focus", () => {
    focusPage(win.ptr as Pointer);
    if (focused === w) return;
    focused = w;
    menus.setMenu();
  });
  win.on("close", () => {
    windows.delete(w);
    if (focused === w) focused = [...windows].at(-1);
    void projects.closeWindow(w).catch(report);
    menus.setMenu();
  });
  return w;
}

openWindow();

// App-wide changes reach every window and the menus whether or not a project is open.
appBridge(core, broadcast, {
  shortcuts: (list) => void shortcutsChanged(list),
  settings: (s) => {
    for (const w of windows) if (w !== changedBy) w.message("appSettings", s);
  },
  job: (job) => {
    if (job.kind === "resource") return resourceJob(job);
    if (job.kind !== "export") return;
    // To the window that started it; an agent's to the focused one.
    const w = [...windows].find((x) => x.exports.owns(job.id)) ?? focused;
    w?.exports.exportJob(job);
  },
});
const recorder = createRecording({
  core,
  message: (type, data) => (recording ?? focused)?.message(type, data),
  status: (text) => (recording ?? focused)?.status(text),
  project: () => (recording ?? focused)?.current?.path,
  // Every window leaves the screen while a take records, so none is in it.
  window: {
    hide: () => {
      for (const w of windows) w.win.hide();
    },
    show: () => {
      for (const w of windows) w.win.show();
    },
    activate: () => (recording ?? focused)?.win.activate(),
  },
  setSettings: (patch) => setAppSettings(patch, recording ?? focused),
});

const server = serveCore(core, { path: socket, canOpen: (p) => !!winFor(resolve(p)), projects: () => [...windows].flatMap((w) => (w.current ? [w.current.path] : [])) });
core.setUiOpener((h, dialog, tab) => {
  const w = winFor(h) ?? focused;
  if (!w) return;
  if (dialog === null) w.message("closeDialogs", {});
  else if (dialog === "settings") void openSettings(w, tab);
  else if (dialog === "projectSettings") w.message("projectSettings", {});
  else if (dialog === "export") void w.exports.exportDialog().catch(report);
  else if (dialog === "exportSelection") void w.exports.exportDialog(true).catch(report);
  else if (dialog === "newProject") projects.newProject(w);
  else if (dialog === "record") openRecord(w);
});
core.setSnapshotter(async (h) => {
  const w = winFor(h) ?? focused;
  if (!w) throw new Error("no window shows the project");
  const png = await captureWindow(windowNumber(w.win.ptr as Pointer));
  const v = w.current?.view;
  // The capture is in pixels; the webview lays out in points from the window's top-left.
  const scale = v?.scale ?? 2;
  const canvas = v && { x: v.rect.x * scale, y: v.rect.y * scale, width: v.rect.width * scale, height: v.rect.height * scale };
  const s = w.shown;
  const text =
    s &&
    `${s.project}: ${s.tracks} tracks, ${s.clips} clips, ${s.markers} markers; playhead ${s.playhead.toFixed(2)} s; ` +
      `selected ${s.selection.length ? s.selection.join(", ") : "nothing"}; timeline ${s.timeline.start.toFixed(2)}–${s.timeline.end.toFixed(2)} s; ` +
      `tool panel ${s.tool ?? "closed"}; properties ${s.properties ?? "closed"}`;
  return { png, canvas, scale, shown: text };
});

const initial = process.env.BEACON_PROJECT ?? process.argv.find((a) => a.endsWith(".beproj"));
if (initial) await projects.open(initial).catch((e) => status(String(e)));

let stopped = false;
/** Each quit's steps, timed, appended to ~/Library/Logs/beacon-quit.log: where a quit stalls. */
const quitLog = (step: string) => {
  try {
    appendFileSync(join(homedir(), "Library/Logs/beacon-quit.log"), `${new Date().toISOString()} ${step}\n`);
  } catch {}
};
// Stops decoders and playback, releases the project locks and the socket.
const quit = () => {
  if (stopped) return;
  stopped = true;
  quitLog("closing");
  server.stop();
  core.closeAll();
  quitLog("closed");
};
Electrobun.events.on("before-quit", quit);
checkForUpdatesSoon(status, () => stopped);
process.on("exit", quit);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
