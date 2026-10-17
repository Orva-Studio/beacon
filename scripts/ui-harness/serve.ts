import { join } from "node:path";
import { importDropped, LocalCore } from "@beacon/core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportOptions } from "../../packages/ui/src/export-options";
import { DEFAULT_EXPORT } from "../../packages/ui/src/export-defaults";
import type { RecentProject } from "../../packages/ui/src/rpc";

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
  const unwatch = new Map<unknown, () => void>();
  const sockets = new Set<{ send(data: string): unknown }>();
  let rev = 0;
  /** Set by a test: the next patches message is lost, as a dropped message would be; `runDelay` ms before each command runs, as the app's round trip takes. */
  const faults = { dropNext: false, runDelay: 0 };
  /** Proxies being made, as the app tracks them. */
  const transcribing: Record<string, number> = {};
  const making: { queued: Record<string, number>; jobs: Record<string, number> } = { queued: {}, jobs: {} };
  /** Every asset's waveform peaks, as the app sends them. */
  const waveforms = () => {
    const out: Record<string, Record<number, number[]>> = {};
    for (const id of Object.keys(core.doc(h).assets)) {
      const w = core.derived<{ streams: Record<number, number[]> }>(h, id, "waveform");
      if (w) out[id] = w.streams;
    }
    return out;
  };
  /** The newest preview frames, pulled by the page as the app's are (`recordFrames`). */
  const frames: { seq: number; camera?: string; screen?: string; at: Record<string, number> } = { seq: 0, at: {} };
  let frameWaiters: (() => void)[] = [];
  const previewFrame = (source: "camera" | "screen", jpeg: string) => {
    frames[source] = jpeg;
    frames.at[source] = ++frames.seq;
    for (const wake of frameWaiters.splice(0)) wake();
  };
  let narrationDevices: unknown = { permissions: { screen: "granted", camera: "granted", microphone: "granted" }, displays: [], cameras: [], microphones: [{ id: "mic-1", name: "Blue Yeti" }], outputs: [], sources: { microphone: { id: "mic-1" } }, hear: false };
  const opened = async () => ({ path: h, name: "project", project: core.doc(h), session: await core.session(h), rev });
  const sendAll = (type: string, data: unknown) => {
    for (const ws of sockets) ws.send(JSON.stringify({ type, data }));
  };
  // The window agents open dialogs in (`ui_open`), as the app's does: what its menus would send.
  core.setUiOpener(async (_, dialog, tab) => {
    const doc = core.doc(h);
    if (dialog === null) return sendAll("closeDialogs", {});
    if (dialog === "settings") return sendAll("settingsSheet", { ...(await core.settings()), ...(tab ? { tab } : {}), resources: await core.resources(), preferences: await core.preferences() });
    if (dialog === "export" || dialog === "exportSelection") {
      const range = (await core.session(h)).range;
      if (dialog === "exportSelection" && !range) return;
      const fps = doc.settings.fps.num / doc.settings.fps.den;
      return sendAll("exportSheet", { name: "project", folder: tmpdir(), settings: DEFAULT_EXPORT, canvas: { width: doc.settings.width, height: doc.settings.height, fps }, ...(dialog === "exportSelection" && range ? { range } : {}) });
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
        const stop = core.watch(h, (e) => {
          if (e.kind === "apply" || e.kind === "undo" || e.kind === "redo") {
            rev++;
            if (faults.dropNext) faults.dropNext = false;
            else ws.send(JSON.stringify({ type: "patches", data: { patches: e.patches, rev } }));
            void core.missing(h).then((missing) => ws.send(JSON.stringify({ type: "media", data: { missing } })));
          }
          else if (e.kind === "session") ws.send(JSON.stringify({ type: "session", data: { changes: e.changes } }));
          else if (e.kind === "favorites") ws.send(JSON.stringify({ type: "favorites", data: { items: e.items } }));
          else if (e.kind === "shortcuts") ws.send(JSON.stringify({ type: "shortcuts", data: { shortcuts: e.shortcuts } }));
          else if (e.kind === "settings") ws.send(JSON.stringify({ type: "appSettings", data: e.settings }));
          else if (e.kind === "preference") void core.preferences().then((p) => ws.send(JSON.stringify({ type: "preferences", data: p })));
          else if (e.kind === "preparing") {
            making.queued = e.assets;
            ws.send(JSON.stringify({ type: "media", data: { preparing: { ...making.queued, ...making.jobs } } }));
          } else if (e.kind === "job" && e.job.kind === "proxy" && e.job.asset) {
            if (e.job.state === "running") making.jobs[e.job.asset] = e.job.progress;
            else delete making.jobs[e.job.asset];
            ws.send(JSON.stringify({ type: "media", data: { preparing: { ...making.queued, ...making.jobs } } }));
          } else if (e.kind === "job" && e.job.kind === "transcript" && e.job.asset) {
            if (e.job.state === "running") transcribing[e.job.asset] = e.job.progress;
            else delete transcribing[e.job.asset];
            ws.send(JSON.stringify({ type: "media", data: { transcribing: { ...transcribing } } }));
          } else if (e.kind === "derived" && e.key === "proxy") ws.send(JSON.stringify({ type: "media", data: { proxies: { [e.asset]: e.present } } }));
          else if (e.kind === "job" && e.job.kind === "waveform" && e.job.state === "done") ws.send(JSON.stringify({ type: "media", data: { waveforms: waveforms() } }));
        });
        unwatch.set(ws, stop);
        sockets.add(ws);
      },
      close(ws) {
        unwatch.get(ws)?.();
        sockets.delete(ws);
        unwatch.delete(ws);
      },
      async message(ws, raw) {
        const msg = JSON.parse(String(raw));
        const reply = async (fn: () => Promise<unknown>) => {
          try {
            return { ok: true, result: await fn() };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        };
        let result: unknown;
        if (msg.type === "init") {
          const schema = core.schema();
          result = {
            opened: shown ? await opened() : undefined,
            recent: opts.recent ?? [],
            shortcuts: await core.shortcuts(),
            propGroups: schema.props.map((p) => ({ id: p.id, description: p.description })),
            effects: schema.effects.map((e) => ({ id: e.id, description: e.description, traits: e.traits, schema: e.schema })),
            clipTypes: Object.fromEntries(schema.clipTypes.map((c) => [c.id, c.traits])),
            nested: Object.fromEntries(schema.clipTypes.flatMap((c) => (c.nested ? [[c.id, c.nested]] : []))),
            socket: "",
            favorites: await core.favorites(),
            preferences: await core.preferences(),
          };
        } else if (msg.type === "run") {
          if (faults.runDelay) await Bun.sleep(faults.runDelay);
          result = await reply(() => core.run(h, msg.command, msg.args ?? {}, { ...(msg.label ? { label: msg.label } : {}), ...(msg.coalesce ? { coalesce: msg.coalesce } : {}) }));
        }
        else if (msg.type === "resync") result = await opened();
        else if (msg.type === "query") result = await reply(() => core.query(h, msg.name, msg.args ?? {}));
        else if (msg.type === "undo") result = await reply(() => core.undo(h));
        else if (msg.type === "redo") result = await reply(() => core.redo(h));
        else if (msg.type === "openRecent" || msg.type === "openDialog") {
          menus.push(msg.type === "openRecent" ? `openRecent:${msg.path}` : "openDialog");
          shown = true;
          ws.send(JSON.stringify({ type: "opened", data: await opened() }));
          result = { ok: true };
        }
        else if (msg.type === "clipMenu") menus.push(msg.clip);
        else if (msg.type === "canvasMenu") menus.push("canvas");
        else if (msg.type === "trackMenu") menus.push(`track:${msg.track}`);
        else if (msg.type === "binMenu") menus.push(`asset:${msg.asset}`);
        else if (msg.type === "importMedia") menus.push("import");
        else if (msg.type === "dropFiles") result = await reply(() => importDropped(core, h, msg.files, msg));
        else if (msg.type === "captureFrame")
          result = await reply(async () => {
            const r = await core.captureFrame(h);
            ws.send(JSON.stringify({ type: "snapshotSaved", data: { path: r.path } }));
            return r;
          });
        else if (msg.type === "frameImage") result = `data:image/png;base64,${Buffer.from((await core.frame(h, (await core.session(h)).playhead)).png).toString("base64")}`;
        else if (msg.type === "startExport")
          result = await reply(async () => {
            const output = join(msg.folder, `${msg.name}.${msg.settings.format}`);
            if (!msg.overwrite && existsSync(output)) throw new Error(`${msg.name}.${msg.settings.format} already exists`);
            const job = await core.export(h, { output, overwrite: true, ...exportOptions(msg.settings), ...(msg.range ? { from: msg.range.in, to: msg.range.out } : {}) });
            const stop = core.watch(h, (e) => {
              if (e.kind !== "job" || e.job.id !== job.id) return;
              ws.send(JSON.stringify({ type: "exportJob", data: { id: job.id, output, state: e.job.state, progress: e.job.progress, ...(e.job.error ? { error: e.job.error } : {}) } }));
              if (e.job.state !== "running") stop();
            });
            ws.send(JSON.stringify({ type: "exportJob", data: { id: job.id, output, state: "running", progress: 0 } }));
          });
        else if (msg.type === "analyze") await core.analyze(h, msg.key, msg.asset);
        else if (msg.type === "binFrame") {
          const png = await core.assetThumbnail(h, msg.asset, 128, msg.time).catch(() => undefined);
          result = png?.length ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null;
        }
        else if (msg.type === "previewOpen") result = core.assetPreviewInfo(h, msg.asset);
        // No native view here: the preview's controls are recorded, and play/seek move its clock as the app's would.
        else if (msg.type === "previewControl") {
          menus.push(`preview:${msg.op}${msg.time !== undefined ? `:${msg.time}` : ""}`);
          if (msg.op !== "close") ws.send(JSON.stringify({ type: "previewClock", data: { time: msg.time ?? 0, playing: msg.op === "play" } }));
        }
        // The harness keeps its one project: these are recorded, as menus are.
        else if (msg.type === "setAppSettings") {
          menus.push(`setAppSettings:${JSON.stringify(msg.settings)}`);
          await core.setSettings(msg.settings).catch(() => {});
        }
        // Never records: the sources it was asked for are what a test checks.
        else if (msg.type === "startRecording") (menus.push(`startRecording:${JSON.stringify(msg.sources)}`), (result = { ok: true }));
        else if (msg.type === "startNarration") (menus.push(`startNarration:${JSON.stringify({ microphone: msg.microphone, hear: msg.hear })}`), (result = { ok: true }));
        else if (msg.type === "stopNarration") (menus.push(`stopNarration${msg.discard ? ":discard" : ""}`), (result = { ok: true }));
        // Stand-in devices: a test sets them with `narrationDevices`.
        else if (msg.type === "narrationDevices") result = narrationDevices;
        else if (msg.type === "openRecord") menus.push(msg.mode ? `openRecord:${msg.mode}` : "openRecord");
        // No devices here: still frames and levels stand in for them.
        else if (msg.type === "recordPreview") {
          const { id: _, type: __, ...sources } = msg;
          menus.push(`recordPreview:${JSON.stringify(sources)}`);
          for (const source of ["screen", "camera"] as const) if (msg[source]) previewFrame(source, PREVIEW_JPEG);
          if (msg.microphone || msg.systemAudio)
            ws.send(JSON.stringify({ type: "recordPreview", data: { ...(msg.microphone ? { microphone: { db: -20, peak: -6 } } : {}), ...(msg.systemAudio ? { systemAudio: { db: -30, peak: -12 } } : {}) } }));
          result = { ok: true };
        }
        else if (msg.type === "stopRecording" || msg.type === "hidePanel") menus.push(msg.type);
        // The beep the stand-in microphone hears.
        else if (msg.type === "testBeep") {
          menus.push(`testBeep>${msg.output}`);
          ws.send(JSON.stringify({ type: "recordPreview", data: { microphone: { db: -24, peak: -12 } } }));
        }
        // No screen to flash here: a fixed measurement stands in.
        else if (msg.type === "checkSync") {
          menus.push(`checkSync:${msg.camera}|${msg.microphone}@${msg.display}>${msg.output}`);
          result = { ok: true, result: { cameraLateMs: 112, flashes: 6, spreadMs: 4 } };
        }
        else if (msg.type === "recordFrames") {
          const after = msg.after as number;
          if (frames.seq <= after) await new Promise<void>((wake) => (frameWaiters.push(wake), setTimeout(wake, 1000)));
          result = { seq: frames.seq, ...(["camera", "screen"] as const).reduce((o, k) => (frames.at[k]! > after && frames[k] ? { ...o, [k]: frames[k] } : o), {}) };
        }
        else if (msg.type === "proxySpace") result = await core.analysisSize("proxy");
        else if (msg.type === "deleteAllProxies") result = await core.forgetAll("proxy").then(() => core.analysisSize("proxy"));
        else if (msg.type === "newProject" || msg.type === "renameProject") {
          menus.push(`${msg.type}:${msg.name}`);
          if (msg.settings) menus.push(`newProjectSettings:${JSON.stringify(msg.settings)}`);
          if (msg.standalone) menus.push("newProjectStandalone");
          result = { ok: true };
        }
        else if (msg.type === "saveAs") {
          menus.push(`saveAs:${msg.folder}/${msg.name}${msg.standalone ? " (standalone)" : ""}`);
          result = msg.name === "Taken" ? { ok: false, error: "Taken.beproj already exists" } : { ok: true };
        }
        else if (msg.type === "chooseFolder") result = "/Users/someone/Shared";
        else if (msg.type === "cancelExport") result = await reply(() => core.cancelJob(msg.id));
        // A stand-in download: the test sends its progress as the app forwards a real one's.
        else if (msg.type === "fetchResource") {
          menus.push(`fetchResource:${msg.id}`);
          result = { ok: true, result: "job-download" };
        }
        else if (msg.type === "setPreference" || msg.type === "setSecret") {
          menus.push(msg.type === "setPreference" ? `setPreference:${msg.pref}=${msg.value}` : `setSecret:${msg.secret}=${msg.value === null ? "removed" : "set"}`);
          result = await reply(async () => (msg.type === "setPreference" ? await core.setPreference(msg.pref, msg.value) : await core.setSecret(msg.secret, msg.value), core.preferences()));
        }
        else if (msg.type === "shortcutSet") result = await reply(() => core.shortcutSet(msg.action, msg.keys, msg.replace));
        else if (msg.type === "shortcutReset") result = await reply(() => core.shortcutReset(msg.action));
        // The app's own actions open dialogs the main process owns: recorded, as menus are.
        else if (msg.type === "appAction") menus.push(`app:${msg.action}`);
        else if (msg.type === "favoriteAdd") result = await reply(() => core.favoriteAdd(msg.item, msg.index));
        else if (msg.type === "favoriteRemove") result = await reply(() => core.favoriteRemove(msg.item));
        else if (msg.type === "favoriteMove") result = await reply(() => core.favoriteMove(msg.item, msg.index));
        else if (msg.type === "declineResource" || msg.type === "cancelJob") {
          menus.push(`${msg.type}:${msg.id}`);
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
