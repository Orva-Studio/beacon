import { createRoot } from "react-dom/client";
import { App, type Host } from "../src/app";
import { recordPreviewEvent } from "../src/record-preview";
import { RecordPanel } from "../src/record-panel";
import type { Init, RecordFrames, SyncCheck } from "../src/rpc";
import { replica } from "../src/store";

// Electrobun's preload styles the tag (api/preload/wgpuTag.ts); the app's layout has to win over it here too.
document.head.insertAdjacentHTML("afterbegin", "<style>electrobun-wgpu { display: block; width: 800px; height: 300px; background: #000; overflow: hidden; }</style>");

// The app's native canvas view; here it never gets a GPU view, as an occluded window wouldn't.
customElements.define(
  "electrobun-wgpu",
  class extends HTMLElement {
    wgpuViewId = null;
    /** The masks Electrobun would last have sent the native view (its getMasks), relative to the element. */
    sent: { x: number; y: number; width: number; height: number }[] = [];
    on() {}
    syncDimensions(force = false) {
      if (!force) return;
      const r = this.getBoundingClientRect();
      this.sent = (this.getAttribute("masks") ?? "").split(",").flatMap((sel) =>
        [...document.querySelectorAll(sel.trim())].map((el) => {
          const m = el.getBoundingClientRect();
          return { x: m.x - r.x, y: m.y - r.y, width: m.width, height: m.height };
        }),
      );
    }
  },
);

const ws = new WebSocket(`ws://${location.host}/ws`);
const waiting = new Map<number, (r: unknown) => void>();
let seq = 0;
const request = <R,>(type: string, payload: object = {}) =>
  new Promise<R>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve as (r: unknown) => void);
    ws.send(JSON.stringify({ id, type, ...payload }));
  });

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  if (msg.type === "opened") replica.opened(msg.data);
  else if (msg.type === "patches" && !replica.patches(msg.data.patches, msg.data.rev)) void request<Parameters<typeof replica.resynced>[0]>("resync").then((o) => o && replica.resynced(o));
  else if (msg.type === "session") replica.session(msg.data.changes);
  else if (msg.type === "status") replica.status(msg.data.text);
  else if (msg.type === "media") replica.media(msg.data);
  else if (msg.type === "exportSheet") replica.exportSheet(msg.data);
  else if (msg.type === "recordSheet") replica.recordSheet(msg.data);
  else if (msg.type === "recordDevices") replica.recordDevices(msg.data);
  else if (msg.type === "recordPreview") recordPreviewEvent(msg.data);
  else if (msg.type === "recordedSheet") replica.recordedSheet(msg.data);
  else if (msg.type === "exportJob") replica.exportJob(msg.data);
  else if (msg.type === "snapshotSaved") replica.snapshot(msg.data.path);
  else if (msg.type === "settingsSheet") replica.settings(msg.data);
  else if (msg.type === "notice") replica.notice(msg.data);
  else if (msg.type === "previewClock") replica.previewClock(msg.data);
  else if (msg.type === "newProjectSheet") replica.newProject(msg.data);
  else if (msg.type === "showClipSpeed") replica.showClipSpeed(msg.data.clip, true);
};

const report = async (p: Promise<{ ok: boolean; error?: string }>) => {
  const r = await p;
  if (!r.ok && r.error) replica.status(r.error);
};

const host: Host = {
  run: (command, args, label, coalesce) => void report(request("run", { command, args, label, coalesce })),
  query: async (name, args) => {
    const r = (await request("query", { name, args })) as { ok: boolean; result?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error);
    return r.result;
  },
  undo: () => void report(request("undo")),
  redo: () => void report(request("redo")),
  openDialog: () => {},
  canvasView: () => {},
  clipMenu: (clip) => void request("clipMenu", { clip }),
  canvasMenu: () => void request("canvasMenu"),
  trackMenu: (track) => void request("trackMenu", { track }),
  binMenu: (asset) => void request("binMenu", { asset }),
  importMedia: () => void request("importMedia"),
  dropFiles: (files, at) => void report(request("dropFiles", { files, ...at })),
  captureFrame: () => void report(request("captureFrame")),
  frameImage: () => request("frameImage") as Promise<string | null>,
  binFrame: (asset, time) => request("binFrame", { asset, time }) as Promise<string | null>,
  analyze: (key, asset) => void request("analyze", { key, asset }),
  chooseFolder: async () => null,
  startExport: (params) => request("startExport", params),
  startRecording: (sources) => request("startRecording", { sources }) as Promise<{ ok: boolean; error?: string }>,
  recordPreview: (devices) => void request("recordPreview", devices),
  recordFrames: (after) => request("recordFrames", { after }) as Promise<RecordFrames>,
  checkSync: (camera, microphone, display, output) => request("checkSync", { camera, microphone, display, output }) as Promise<{ ok: boolean; result?: SyncCheck; error?: string }>,
  testBeep: (output) => request("testBeep", { output }) as Promise<void>,
  cancelExport: (id) => void request("cancelExport", { id }),
  showFile: () => {},
  setAppSettings: (settings) => void request("setAppSettings", { settings }),
  proxySpace: () => request("proxySpace") as Promise<number>,
  deleteAllProxies: () => request("deleteAllProxies") as Promise<number>,
  newProject: (name, settings) => request("newProject", { name, settings }) as Promise<{ ok: boolean; error?: string }>,
  renameProject: (name) => request("renameProject", { name }) as Promise<{ ok: boolean; error?: string }>,
  previewOpen: (asset) => request("previewOpen", { asset }) as Promise<never>,
  previewView: () => {},
  previewPlay: (time) => void request("previewControl", { op: "play", time }),
  previewPause: (time) => void request("previewControl", { op: "pause", time }),
  previewSeek: (time) => void request("previewControl", { op: "seek", time }),
  previewClose: () => void request("previewControl", { op: "close" }),
};

(window as unknown as { harness: unknown }).harness = { replica };
await new Promise((r) => (ws.onopen = r));
// `?panel=<sources>` shows the recording panel instead, as its own window does, its levels sent as recordPreview messages.
const panel = new URLSearchParams(location.search).get("panel");
if (panel !== null) {
  const has = (k: string) => panel.split(",").includes(k);
  const state = { started: Date.now(), screen: has("screen"), camera: has("camera"), microphone: has("microphone"), systemAudio: has("systemAudio") };
  createRoot(document.getElementById("root")!).render(<RecordPanel state={state} onStop={() => void request("stopRecording")} onHide={() => void request("hidePanel")} />);
} else {
  replica.init(await request<Init>("init"));
  createRoot(document.getElementById("root")!).render(<App host={host} />);
}
