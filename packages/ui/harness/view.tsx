import { createRoot } from "react-dom/client";
import { App } from "../src/app";
import { createHost } from "../src/host";
import { RecordPanel } from "../src/record-panel";
import type { Init } from "../src/rpc";
import { replica } from "../src/store";
import { messageHandlers } from "../src/messages";

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
const request = <R,>(type: string, params: object = {}) =>
  new Promise<R>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve as (r: unknown) => void);
    ws.send(JSON.stringify({ id, type, params }));
  });

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  if (msg.type === "patches") {
    if (!replica.patches(msg.data.patches, msg.data.rev)) void request<Parameters<typeof replica.resynced>[0]>("resync").then((o) => o && replica.resynced(o));
  } else (messageHandlers as Record<string, (data: unknown) => void>)[msg.type]?.(msg.data);
};

// The app's host, over the socket; no native views or Finder here.
const host = createHost((name, params) => request(name, params), { canvasView: () => {}, showFile: () => {}, previewView: () => {} });

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
