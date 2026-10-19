import { appendFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Pointer } from "bun:ffi";
import Electrobun, { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import type { Current } from "./app";
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

const { captureWindow, DEFAULT_SOCKET, LocalCore, serveCore, windowNumber } = await import("@beacon/core");
const { initPayload, appBridge, coreRequests, projectBridge, settingsSheet } = await import("@beacon/ui");
const { createRecording } = await import("./recording");
const { createMenus } = await import("./menus");
const { createProjects } = await import("./projects");
const { createViews } = await import("./views");
const { createWindowMedia } = await import("./window-media");
const { createExports } = await import("./exports");
const { errorText } = await import("./app");
type ShortcutInfo = import("@beacon/core").ShortcutInfo;

const socket = process.env.BEACON_SOCKET ?? DEFAULT_SOCKET;
const keyLog = process.env.BEACON_KEYLOG ? join(homedir(), "Library/Logs/beacon-keys.log") : undefined;
const core = new LocalCore({ socket, reveal: (path) => Utils.showItemInFolder(path) });
/** Every action with its keys, the user's over the defaults: the menus show them. */
let shortcuts = await core.shortcuts();

let current: Current | undefined;
let shown: import("@beacon/ui").Shown | undefined;

const send = () => win.webview.rpc!.send;
/** `send()` by message name, for the bridge shared with the UI harness. */
const message: import("@beacon/ui").Send = (type, data) => (send()[type] as (d: typeof data) => void)(data);
const status = (text: string) => send().status({ text });
const report = (err: unknown) => status(errorText(err));

const base = { core, message, status, current: () => current };

async function openedPayload(h: string): Promise<import("@beacon/ui").Opened> {
  return { path: h, name: basename(h, ".beproj"), project: core.doc(h), session: await core.session(h), rev: current?.path === h ? current.bridge.rev() : 0 };
}

/** Set while core saves the window's own change: its "settings" event isn't sent back, over a newer change. */
let ownChange = false;
/** A change from the Settings window (which shows it already) or Check Sync; core keeps them and applies them. */
function setAppSettings(patch: import("@beacon/ui").SettingsPatch) {
  ownChange = true;
  // Core tells the change before its promise settles, while this is still set.
  core.setSettings(patch).catch((e: unknown) => status(`could not save settings: ${errorText(e)}`));
  ownChange = false;
}

/** Keys rebound (here, by an agent, or in another process's keymap.json): the menus and the window show them. */
function shortcutsChanged(next: ShortcutInfo[]): ShortcutInfo[] {
  shortcuts = next;
  menus.setMenu();
  send().shortcuts({ shortcuts: next });
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
    "favorites.json": () => void core.favorites().then((items) => send().favorites({ items })),
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
/** An import's analysis waits for a resource (the speech model): ask, unless the user said Not Now before. */
async function offerResource(r: import("@beacon/core").ResourceInfo) {
  if (r.present || r.job || offered.has(r.id)) return;
  offered.add(r.id);
  if ((await core.settings()).declinedResources?.includes(r.id)) return status(`No transcript: the ${r.title} isn't downloaded (Settings › General)`);
  send().resourceSheet(r);
}
/** A download's progress, for the resource dialog and the status line. */
function resourceJob(job: import("@beacon/core").JobInfo) {
  send().resourceJob({ id: job.id, state: job.state, progress: job.progress, ...(job.error ? { error: job.error } : {}) });
  if (job.state === "done") status(`${job.label.replace(/^Download /, "")} downloaded: transcripts are being made`);
  else if (job.state === "failed" && job.error !== "cancelled") status(`${job.label}: ${job.error}`);
}

/** Beacon > Settings…, with the cameras and microphones Settings › Recording picks from. */
async function openSettings(tab?: import("@beacon/ui").SettingsTab) {
  const d = await core.recorderDevices().catch(() => undefined);
  const prefs = recorder.recordPrefs();
  const devices = d && { displays: d.displays, display: prefs.screen?.display, outputs: d.outputs, cameras: d.cameras, microphones: d.microphones, camera: prefs.camera?.id, microphone: prefs.microphone?.id };
  send().settingsSheet(await settingsSheet(core, { ...(tab ? { tab } : {}), ...(devices ? { devices } : {}) }));
}

const views = createViews(base);
const media = createWindowMedia(base);
const exports = createExports(base);

const projects = createProjects({
  ...base,
  setCurrent: (c) => void (current = c),
  watch: (h) =>
    projectBridge(core, h, message, {
      every: (e) => tally(`event ${e.kind}`),
      changed: () => {
        void media.sendThumbs();
        void media.sendMissing();
      },
      session: (changes) => {
        if (changes.canvas) views.place(changes.canvas);
      },
      other: (e) => {
        if (e.kind === "saved") {
          send().saved({ ok: true });
          projects.saveProjectThumbSoon(h);
        } else if (e.kind === "needs") void offerResource(e.resource);
        else if (e.kind === "narrated") recorder.narrationEnded(e.result);
        else if (e.kind === "error") {
          if (e.message.startsWith("could not save")) send().saved({ ok: false });
          if (e.message.startsWith("narration:")) recorder.narrationEnded();
          status(e.message);
        } else if (e.kind === "job" && e.job.kind !== "export") {
          if (e.job.state === "failed" && e.job.error !== "cancelled") status(`${e.job.label}: ${e.job.error}`);
          if (e.job.state === "done" && e.job.kind === "proxy") void media.sendThumbs();
        }
      },
    }),
  leaving: () => recorder.narrationEnded(),
  shown: async (h, canvas) => {
    win.setTitle(`${basename(h)} — Beacon`);
    send().opened(await openedPayload(h));
    if (canvas) await views.canvasView(canvas.id, canvas.rect, canvas.scale);
    current?.bridge.sendWaveforms(true);
    media.resend();
  },
  recentChanged: () => {
    menus.setMenu();
    send().recent(projects.recentProjects());
  },
});

/** The app's own actions, from their menu items, the command palette or keys the window matched. */
function appAction(id: string): void {
  if (id === "app.open") return void projects.openDialog().catch(report);
  if (id === "app.new") return void projects.newProject();
  if (id === "app.import") return void projects.importMedia().catch(report);
  if (id === "app.record") return void recorder.recordDialog().catch(report);
  if (id === "app.narration") return void recorder.recordDialog("narration").catch(report);
  if (id === "app.export") return void exports.exportDialog().catch(report);
  if (id === "app.exportSelection") return void exports.exportDialog(true).catch(report);
  if (id === "app.saveAs") return void projects.saveAsDialog();
  if (id === "app.reveal") return void (current && core.reveal(current.path).catch(report));
  if (id === "app.settings") return void openSettings();
  if (id === "app.shortcuts") return void openSettings("shortcuts");
  if (id === "app.projectSettings") return void openSettings("project");
  if (id === "app.checkUpdates") return void checkForUpdates({ status, stopped: () => stopped });
  if (id === "app.palette") return void send().palette({});
}

const menus = createMenus({
  ...base,
  shortcuts: () => shortcuts,
  recent: projects.recent,
  openRecent: projects.openRecent,
  clearRecent: projects.clearRecent,
  appAction,
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
    appendFileSync(diag, `${new Date().toISOString()} lag ${lag} ms, cpu ${Math.round((cpu.user + cpu.system) / 1000)} ms total, ${JSON.stringify(Object.fromEntries(calls))}, jobs [${jobs.join(", ")}], playing ${(current && core.view(current.path)?.playing) ?? "-"}\n`);
    calls.clear();
  }, 5000);
}

const rpc = BrowserView.defineRPC<import("@beacon/ui").AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: counted({
      ...coreRequests(core, () => current?.path, status),
      resync: async () => (current ? openedPayload(current.path) : undefined),
      init: async () => {
        // The webview may load after the project opened: send its pictures again once it asks.
        setTimeout(() => {
          current?.bridge.sendWaveforms(true);
          media.resendThumbs();
        }, 50);
        return {
          ...(await initPayload(core)),
          opened: current ? await openedPayload(current.path) : undefined,
          recent: projects.recentProjects(),
          keyLog: !!keyLog,
          socket,
        };
      },
      openDialog: () => reply(projects.openDialog),
      openRecent: ({ path }) => projects.openRecent(path),
      chooseFolder: async ({ start }) => (await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: start }))[0] || null,
      startExport: (params) => reply(() => exports.startExport(params)),
      startRecording: (params) => reply(() => recorder.startRecording(params)),
      narrationDevices: async () => ({ ...(await core.recorderDevices()), sources: recorder.recordPrefs(), hear: recorder.narrationHear() }),
      openRecord: ({ mode }) => void recorder.recordDialog(mode).catch(report),
      startNarration: (params) => reply(() => recorder.startNarration(params)),
      stopNarration: (params) => reply(() => recorder.stopNarration(params)),
      recordPreview: (devices) => {
        recorder.clearFrames();
        return reply(() =>
          core.recorderPreview(devices, (e) => {
            if (!("devicesChanged" in e)) return recorder.previewEvent(e, send().recordPreview);
            void core.recorderDevices().then((d) => send().recordDevices(d), () => {});
          }),
        );
      },
      recordFrames: ({ after }) => recorder.newerFrames(after),
      testBeep: (params) => recorder.testBeep(params),
      checkSync: (params) => replyWith(() => recorder.checkSync(params)),
      setAppSettings: (next) => setAppSettings(next),
      newProject: ({ name, settings, standalone }) => reply(() => projects.createProject(name, settings, standalone)),
      saveAs: (params) => reply(() => projects.saveAs(params)),
      fetchResource: ({ id }) => replyWith(async () => (await core.fetchResource(id)).id),
      declineResource: async ({ id }) => setAppSettings({ declinedResources: [...new Set([...((await core.settings()).declinedResources ?? []), id])] }),
      shortcutSet: ({ action, keys, replace }) => replyWith(() => core.shortcutSet(action, keys, replace)),
      shortcutReset: ({ action }) => replyWith(() => core.shortcutReset(action)),
      appAction: ({ action }) => appAction(action),
      previewOpen: ({ asset }) => views.previewOpen(asset),
      previewView: ({ id, x, y, width, height, scale }) => views.previewView(id, { x, y, width, height }, scale),
      previewControl: ({ op, time }) => views.previewControl(op, time),
      renameProject: ({ name }) => reply(() => projects.renameProject(name)),
      showFile: ({ path, open }) => {
        if (open) Bun.spawn(["/usr/bin/open", path]);
        else Utils.showItemInFolder(path);
      },
      canvasMenu: () => menus.canvasMenu(),
      clipMenu: (params) => menus.clipMenu(params),
      importMedia: () => void projects.importMedia().catch(report),
      binMenu: (params) => menus.binMenu(params),
      dropFiles: ({ files, time, track }) => reply(() => projects.dropFiles(files, { time, track })),
      trackMenu: (params) => menus.trackMenu(params),
      captureFrame: () =>
        reply(async () => {
          if (!current) return;
          // Core saves in Settings' folder, or the project's media folder when it's gone: say which.
          const chosen = (await core.settings()).snapshotFolder;
          if (chosen && !existsSync(chosen)) status(`${chosen} is missing: saved in the project's media folder`);
          const r = await core.captureFrame(current.path);
          send().snapshotSaved({ path: r.path });
          send().media({ highlight: r.asset });
          void media.sendThumbs();
        }),
      canvasView: async ({ id, x, y, width, height, scale, surround }) => ({ fitPercent: await views.canvasView(id, { x, y, width, height }, scale, { surround }) }),
    }),
    messages: counted({
      shown: (s) => void (shown = s),
      keyLog: ({ line }) => keyLog && appendFileSync(keyLog, `${new Date().toISOString()} ${line}\n`),
      canvasMarks: ({ marks }) => views.marks(marks),
    }),
  },
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
// App-wide changes reach the window and the menus whether or not a project is open.
appBridge(core, message, {
  shortcuts: (list) => void shortcutsChanged(list),
  settings: (s) => ownChange || send().appSettings(s),
  job: (job) => (job.kind === "export" ? exports.exportJob(job) : job.kind === "resource" ? resourceJob(job) : undefined),
});
const recorder = createRecording({
  core,
  message,
  status,
  project: () => current?.path,
  window: win,
  setSettings: setAppSettings,
});

const server = serveCore(core, { path: socket, canOpen: (p) => current?.path === resolve(p), projects: () => (current ? [current.path] : []) });
core.setUiOpener((_, dialog, tab) => {
  if (dialog === null) send().closeDialogs({});
  else if (dialog === "settings") void openSettings(tab);
  else if (dialog === "export") void exports.exportDialog().catch(report);
  else if (dialog === "exportSelection") void exports.exportDialog(true).catch(report);
  else if (dialog === "newProject") projects.newProject();
  else if (dialog === "record") void recorder.recordDialog().catch(report);
});
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
if (initial) await projects.open(initial).catch((e) => status(String(e)));

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
checkForUpdatesSoon(status, () => stopped);
process.on("exit", quit);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
