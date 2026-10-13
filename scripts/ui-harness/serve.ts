import { join } from "node:path";
import { importDropped, LocalCore } from "@beacon/core";
import { existsSync } from "node:fs";
import { exportOptions } from "../../packages/ui/src/export-options";
import keymap from "../../keymaps/default.json";

/** A 16×9 grey JPEG, the camera preview's stand-in. */
const PREVIEW_JPEG = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAQQQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAJABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCZgBO//9k=";

/**
 * Serves the editor's UI to a browser, backed by a LocalCore with the
 * project open, in place of the app's window: for testing the UI offscreen
 * (with `browser.ts`) when an app window would be in the way.
 */
export async function serveUi(project: string, opts: { cacheDir?: string } = {}) {
  const core = new LocalCore(opts);
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
  /** Set by a test: the next patches message is lost, as a dropped message would be. */
  const faults = { dropNext: false };
  /** Proxies being made, as the app tracks them. */
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
  const opened = async () => ({ path: h, name: "project", project: core.doc(h), session: await core.session(h), rev });

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
          else if (e.kind === "preparing") {
            making.queued = e.assets;
            ws.send(JSON.stringify({ type: "media", data: { preparing: { ...making.queued, ...making.jobs } } }));
          } else if (e.kind === "job" && e.job.kind === "proxy" && e.job.asset) {
            if (e.job.state === "running") making.jobs[e.job.asset] = e.job.progress;
            else delete making.jobs[e.job.asset];
            ws.send(JSON.stringify({ type: "media", data: { preparing: { ...making.queued, ...making.jobs } } }));
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
            opened: await opened(),
            keymap: keymap.bindings,
            propGroups: schema.props.map((p) => ({ id: p.id, description: p.description })),
            effects: schema.effects.map((e) => ({ id: e.id, description: e.description, traits: e.traits, schema: e.schema })),
            clipTypes: Object.fromEntries(schema.clipTypes.map((c) => [c.id, c.traits])),
            nested: Object.fromEntries(schema.clipTypes.flatMap((c) => (c.nested ? [[c.id, c.nested]] : []))),
            socket: "",
          };
        } else if (msg.type === "run") result = await reply(() => core.run(h, msg.command, msg.args ?? {}, { ...(msg.label ? { label: msg.label } : {}), ...(msg.coalesce ? { coalesce: msg.coalesce } : {}) }));
        else if (msg.type === "resync") result = await opened();
        else if (msg.type === "query") result = await reply(() => core.query(h, msg.name, msg.args ?? {}));
        else if (msg.type === "undo") result = await reply(() => core.undo(h));
        else if (msg.type === "redo") result = await reply(() => core.redo(h));
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
        else if (msg.type === "previewOpen") result = core.assetPreviewInfo(h, msg.asset);
        // No native view here: the preview's controls are recorded, and play/seek move its clock as the app's would.
        else if (msg.type === "previewControl") {
          menus.push(`preview:${msg.op}${msg.time !== undefined ? `:${msg.time}` : ""}`);
          if (msg.op !== "close") ws.send(JSON.stringify({ type: "previewClock", data: { time: msg.time ?? 0, playing: msg.op === "play" } }));
        }
        // The harness keeps its one project: these are recorded, as menus are.
        else if (msg.type === "setAppSettings") menus.push(`setAppSettings:${JSON.stringify(msg.settings)}`);
        // Never records: the sources it was asked for are what a test checks.
        else if (msg.type === "startRecording") (menus.push(`startRecording:${JSON.stringify(msg.sources)}`), (result = { ok: true }));
        // No devices here: a still frame and a level stand in for them.
        else if (msg.type === "recordPreview") {
          const devices = { camera: msg.camera, microphone: msg.microphone };
          menus.push(`recordPreview:${JSON.stringify(devices)}`);
          if (msg.camera) ws.send(JSON.stringify({ type: "recordPreview", data: { jpeg: PREVIEW_JPEG } }));
          if (msg.microphone) ws.send(JSON.stringify({ type: "recordPreview", data: { db: -20, peak: -6 } }));
          result = { ok: true };
        }
        else if (msg.type === "proxySpace") result = await core.analysisSize("proxy");
        else if (msg.type === "deleteAllProxies") result = await core.forgetAll("proxy").then(() => core.analysisSize("proxy"));
        else if (msg.type === "newProject" || msg.type === "renameProject") {
          menus.push(`${msg.type}:${msg.name}`);
          if (msg.settings) menus.push(`newProjectSettings:${JSON.stringify(msg.settings)}`);
          result = { ok: true };
        }
        else if (msg.type === "cancelExport") result = await reply(() => core.cancelJob(msg.id));
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
    },
  };
}
