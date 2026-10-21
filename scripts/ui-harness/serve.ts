import { join } from "node:path";
import { importDropped, LocalCore } from "@beacon/core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appBridge, coreRequests, tileChoice, tileMenuItems, type TileMenu, DEFAULT_EXPORT, exportCanvas, exportOptions, initPayload, projectBridge, settingsSheet, type ProjectBridge, type RecentProject, type Send } from "@beacon/ui";

/** A 16×9 grey JPEG, the camera preview's stand-in. */
const PREVIEW_JPEG = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAQQQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAJABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCZgBO//9k=";

/**
 * Serves the editor's UI to a browser, backed by a LocalCore with the
 * project open, in place of the app's window: for testing the UI offscreen
 * (with `browser.ts`) when an app window would be in the way.
 */
/**
 * `closed`: the page starts as the app does with no project open (the start screen, listing `recent`);
 * Open Recent or Open… then opens the harness's project.
 */
export async function serveUi(project: string, opts: { cacheDir?: string; closed?: boolean; recent?: RecentProject[] } = {}) {
  // Never the user's preferences or Keychain: a folder of its own, and secrets kept in memory.
  const secrets = new Map<string, string>();
  const configDir = mkdtempSync(join(tmpdir(), "beacon-ui-config-"));
  const core = new LocalCore({
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    configDir,
    secrets: { get: async (id) => secrets.get(id), set: async (id, value) => void (value === null ? secrets.delete(id) : secrets.set(id, value)) },
  });
  // Every medium gets its proxy on its own here (the app's default is none), for the flows that watch one being made.
  await core.setSettings({ autoProxy: { recording: true, video: true } });
  let shown = !opts.closed;
  const h = await core.open(project);
  const root = join(import.meta.dir, "../..");
  const css = Bun.spawnSync(["bun", "run", "--cwd", join(root, "packages/ui"), "css"], { stdout: "ignore", stderr: "pipe" });
  if (css.exitCode) throw new Error(css.stderr.toString());
  const built = await Bun.build({ entrypoints: [join(root, "packages/ui/harness/view.tsx")], target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  if (!built.success) throw new AggregateError(built.logs, "ui build failed");
  const js = await built.outputs[0]!.text();
  const html = (await Bun.file(join(root, "packages/ui/src/index.html")).text()).replace("index.js", "view.js");
  const menus: string[] = [];
  const bridges = new Map<unknown, ProjectBridge>();
  const appWatches = new Map<unknown, () => void>();
  const sockets = new Set<{ send(data: string): unknown }>();
  /** Set by a test: the next patches message is lost, as a dropped message would be; `runDelay` ms before each command runs, as the app's round trip takes. */
  const faults = { dropNext: false, runDelay: 0 };
  /** The newest preview frames, pulled by the page as the app's are (`recordFrames`). */
  const frames: { seq: number; camera?: string; screen?: string; at: Record<string, number> } = { seq: 0, at: {} };
  let frameWaiters: (() => void)[] = [];
  const previewFrame = (source: "camera" | "screen", jpeg: string) => {
    frames[source] = jpeg;
    frames.at[source] = ++frames.seq;
    for (const wake of frameWaiters.splice(0)) wake();
  };
  let chosenFile: string | null = null;
  let tile: TileMenu | undefined;
  let narrationDevices: unknown = { permissions: { screen: "granted", camera: "granted", microphone: "granted" }, displays: [], cameras: [], microphones: [{ id: "mic-1", name: "Blue Yeti" }], outputs: [], sources: { microphone: { id: "mic-1" } }, hear: false };
  /** The app's own handlers for what is core's alone. */
  // Not cancelJob: the harness's downloads are stand-ins, so it only records it.
  const { cancelJob: _, ...shared }: Record<string, (params: never) => Promise<unknown>> = coreRequests(core, () => h);
  const opened = async (ws: unknown) => ({ path: h, name: "project", project: core.doc(h), session: await core.session(h), rev: bridges.get(ws)?.rev() ?? 0 });
  const sendAll = (type: string, data: unknown) => {
    for (const ws of sockets) ws.send(JSON.stringify({ type, data }));
  };
  // The window agents open dialogs in (`ui_open`), as the app's does: what its menus would send.
  core.setUiOpener(async (_, dialog, tab) => {
    const doc = core.doc(h);
    if (dialog === null) return sendAll("closeDialogs", {});
    if (dialog === "settings") return sendAll("settingsSheet", await settingsSheet(core, tab ? { tab } : {}));
    if (dialog === "projectSettings") return sendAll("projectSettings", {});
    if (dialog === "export" || dialog === "exportSelection") {
      const range = (await core.session(h)).range;
      if (dialog === "exportSelection" && !range) return;
      return sendAll("exportSheet", { name: "project", folder: tmpdir(), settings: DEFAULT_EXPORT, canvas: exportCanvas(doc.settings), ...(dialog === "exportSelection" && range ? { range } : {}) });
    }
    if (dialog === "newProject") return sendAll("newProjectSheet", { name: "Untitled Project" });
    if (dialog === "record") return sendAll("recordSheet", { ...(narrationDevices as object), mode: "take", sources: { screen: { fps: 60 }, microphone: { id: "mic-1" } } });
  });

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (path === "/view.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (path === "/styles.css") return new Response(Bun.file(join(root, "packages/ui/dist/styles.css")));
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
    websocket: {
      open(ws) {
        // The app's own translation of core's events, as its window gets them.
        const send: Send = (type, data) => {
          if (type === "patches" && faults.dropNext) faults.dropNext = false;
          else ws.send(JSON.stringify({ type, data }));
        };
        const bridge = projectBridge(core, h, send, {
          changed: () => void core.missing(h).then((missing) => send("media", { missing })),
        });
        appWatches.set(ws, appBridge(core, send));
        bridges.set(ws, bridge);
        sockets.add(ws);
      },
      close(ws) {
        bridges.get(ws)?.unwatch();
        appWatches.get(ws)?.();
        sockets.delete(ws);
        bridges.delete(ws);
        appWatches.delete(ws);
      },
      async message(ws, raw) {
        const msg = JSON.parse(String(raw));
        // The request's fields, named as the app's handlers get them.
        const p = msg.params ?? {};
        const reply = async (fn: () => Promise<unknown>) => {
          try {
            return { ok: true, result: await fn() };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        };
        let result: unknown;
        if (msg.type === "run" && faults.runDelay) await Bun.sleep(faults.runDelay);
        if (msg.type === "setPreference" || msg.type === "setSecret") menus.push(msg.type === "setPreference" ? `setPreference:${p.id}=${p.value}` : `setSecret:${p.id}=${p.value === null ? "removed" : "set"}`);
        if (shared[msg.type]) result = await shared[msg.type]!(p as never);
        else if (msg.type === "init") {
          result = { ...(await initPayload(core)), opened: shown ? await opened(ws) : undefined, recent: opts.recent ?? [], socket: "" };
        }
        else if (msg.type === "resync") result = await opened(ws);
        else if (msg.type === "openRecent" || msg.type === "openDialog") {
          menus.push(msg.type === "openRecent" ? `openRecent:${p.path}` : "openDialog");
          shown = true;
          ws.send(JSON.stringify({ type: "opened", data: await opened(ws) }));
          result = { ok: true };
        }
        else if (msg.type === "clipMenu") menus.push(p.clip);
        else if (msg.type === "canvasMenu") menus.push("canvas");
        else if (msg.type === "trackMenu") menus.push(`track:${p.track}`);
        else if (msg.type === "binMenu") menus.push(`asset:${p.asset}`);
        else if (msg.type === "recentMenu") menus.push(`recent:${p.path}`);
        else if (msg.type === "tileMenu") {
          tile = p;
          menus.push(`tile:${tileMenuItems(p).map(([label]) => label).join("|")}`);
        }
        else if (msg.type === "importMedia") menus.push("import");
        else if (msg.type === "dropFiles") result = await reply(() => importDropped(core, h, p.files, p, join(project, "media")));
        else if (msg.type === "captureFrame")
          result = await reply(async () => {
            const r = await core.captureFrame(h);
            ws.send(JSON.stringify({ type: "snapshotSaved", data: { path: r.path } }));
            return r;
          });
        else if (msg.type === "startExport")
          result = await reply(async () => {
            const output = join(p.folder, `${p.name}.${p.settings.format}`);
            if (!p.overwrite && existsSync(output)) throw new Error(`${p.name}.${p.settings.format} already exists`);
            const job = await core.export(h, { output, overwrite: true, ...exportOptions(p.settings), ...(p.range ? { from: p.range.in, to: p.range.out } : {}) });
            const stop = core.watch(h, (e) => {
              if (e.kind !== "job" || e.job.id !== job.id) return;
              ws.send(JSON.stringify({ type: "exportJob", data: { id: job.id, output, state: e.job.state, progress: e.job.progress, ...(e.job.error ? { error: e.job.error } : {}) } }));
              if (e.job.state !== "running") stop();
            });
            ws.send(JSON.stringify({ type: "exportJob", data: { id: job.id, output, state: "running", progress: 0 } }));
          });
        else if (msg.type === "previewOpen") result = core.assetPreviewInfo(h, p.asset);
        // No native view here: the preview's controls are recorded, and play/seek move its clock as the app's would.
        else if (msg.type === "previewControl") {
          menus.push(`preview:${p.op}${p.time !== undefined ? `:${p.time}` : ""}`);
          if (p.op !== "close") ws.send(JSON.stringify({ type: "previewClock", data: { time: p.time ?? 0, playing: p.op === "play" } }));
        }
        // The harness keeps its one project: these are recorded, as menus are.
        else if (msg.type === "setAppSettings") {
          menus.push(`setAppSettings:${JSON.stringify(p)}`);
          await core.setSettings(p).catch(() => {});
        }
        // Never records: the sources it was asked for are what a test checks.
        else if (msg.type === "startRecording") (menus.push(`startRecording:${JSON.stringify(p.sources)}`), (result = { ok: true }));
        else if (msg.type === "startNarration") (menus.push(`startNarration:${JSON.stringify({ microphone: p.microphone, hear: p.hear })}`), (result = { ok: true }));
        else if (msg.type === "stopNarration") (menus.push(`stopNarration${p.discard ? ":discard" : ""}`), (result = { ok: true }));
        // Stand-in devices: a test sets them with `narrationDevices`.
        else if (msg.type === "narrationDevices") result = narrationDevices;
        else if (msg.type === "openRecord") menus.push(p.mode ? `openRecord:${p.mode}` : "openRecord");
        // No devices here: still frames and levels stand in for them.
        else if (msg.type === "recordPreview") {
          menus.push(`recordPreview:${JSON.stringify(p)}`);
          for (const source of ["screen", "camera"] as const) if (p[source]) previewFrame(source, PREVIEW_JPEG);
          if (p.microphone || p.systemAudio)
            ws.send(JSON.stringify({ type: "recordPreview", data: { ...(p.microphone ? { microphone: { db: -20, peak: -6 } } : {}), ...(p.systemAudio ? { systemAudio: { db: -30, peak: -12 } } : {}) } }));
          result = { ok: true };
        }
        else if (msg.type === "stopRecording" || msg.type === "hidePanel") menus.push(msg.type);
        // The beep the stand-in microphone hears.
        else if (msg.type === "testBeep") {
          menus.push(`testBeep>${p.output}`);
          ws.send(JSON.stringify({ type: "recordPreview", data: { microphone: { db: -24, peak: -12 } } }));
        }
        // No screen to flash here: a fixed measurement stands in.
        else if (msg.type === "checkSync") {
          menus.push(`checkSync:${p.camera}|${p.microphone}@${p.display}>${p.output}`);
          result = { ok: true, result: { cameraLateMs: 112, flashes: 6, spreadMs: 4 } };
        }
        else if (msg.type === "recordFrames") {
          const after = p.after as number;
          if (frames.seq <= after) await new Promise<void>((wake) => (frameWaiters.push(wake), setTimeout(wake, 1000)));
          result = { seq: frames.seq, ...(["camera", "screen"] as const).reduce((o, k) => (frames.at[k]! > after && frames[k] ? { ...o, [k]: frames[k] } : o), {}) };
        }
        else if (msg.type === "newProject" || msg.type === "renameProject") {
          menus.push(`${msg.type}:${p.name}`);
          if (p.settings) menus.push(`newProjectSettings:${JSON.stringify(p.settings)}`);
          if (p.standalone) menus.push("newProjectStandalone");
          result = { ok: true };
        }
        else if (msg.type === "saveAs") {
          menus.push(`saveAs:${p.folder}/${p.name}${p.standalone ? " (standalone)" : ""}`);
          result = p.name === "Taken" ? { ok: false, error: "Taken.beproj already exists" } : { ok: true };
        }
        else if (msg.type === "importFile") result = await reply(async () => (await core.import(h, [p.path])).assets[0]);
        else if (msg.type === "chooseFolder") result = "/Users/someone/Shared";
        else if (msg.type === "chooseFile") {
          menus.push(`chooseFile:${p.extensions.join(",")}`);
          result = chosenFile;
        }
        // A stand-in download: the test sends its progress as the app forwards a real one's.
        else if (msg.type === "fetchResource") {
          menus.push(`fetchResource:${p.id}`);
          result = { ok: true, result: "job-download" };
        }
        else if (msg.type === "shortcutSet") result = await reply(() => core.shortcutSet(p.action, p.keys, p.replace));
        else if (msg.type === "shortcutReset") result = await reply(() => core.shortcutReset(p.action));
        // The app's own actions open dialogs the main process owns: recorded, as menus are.
        else if (msg.type === "appAction") menus.push(`app:${p.action}`);
        else if (msg.type === "declineResource" || msg.type === "cancelJob") {
          menus.push(`${msg.type}:${p.id}`);
          result = { ok: true };
        }
        ws.send(JSON.stringify({ id: msg.id, result }));
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    core,
    handle: h,
    /** Clips whose right-click menu the UI asked for, and new or renamed projects. */
    menus,
    faults,
    /** Picks a choice ("add", "favorite", "unfavorite") from the tile menu shown last, as the app's native menu does. */
    chooseTile(choice: string) {
      return tileChoice(core, h, tile!, choice);
    },
    /** The file Finder's open dialog picks next (Import .hlook…); null cancels. */
    chooseFile(path: string | null) {
      chosenFile = path;
    },
    /** What the Narration panel is told the microphones and last choices are. */
    setNarrationDevices(d: unknown) {
      narrationDevices = d;
    },
    /** A camera or screen frame (base64 JPEG) for the Record dialog or recording panel to pull. */
    previewFrame,
    /** A message from the main process, as the app's menus send them (`showClipSpeed`, `rename`...). */
    send(type: string, data: unknown) {
      for (const ws of sockets) ws.send(JSON.stringify({ type, data }));
    },
    /** Checks for moved or deleted media now, as the app does every few seconds. */
    async checkMissing() {
      const missing = await core.missing(h);
      for (const ws of sockets) ws.send(JSON.stringify({ type: "media", data: { missing } }));
    },
    async close() {
      server.stop(true);
      await core.close(h);
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}
