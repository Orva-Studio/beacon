import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import { App, type Host } from "./app";
import { recordPreviewEvent } from "./record-preview";
import type { AppRPC } from "./rpc";
import { replica } from "./store";

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {},
    messages: {
      opened: (o) => replica.opened(o),
      patches: ({ patches, rev }) => {
        if (!replica.patches(patches, rev)) void resync();
      },
      session: ({ changes }) => replica.session(changes),
      status: ({ text }) => replica.status(text),
      rename: ({ track }) => replica.rename(track),
      renameMedia: ({ asset }) => replica.renameMedia(asset),
      showClipSpeed: ({ clip }) => replica.showClipSpeed(clip, true),
      newProjectSheet: ({ name }) => replica.newProject({ name }),
      saveAsSheet: (s) => replica.saveAs(s),
      previewClock: (c) => replica.previewClock(c),
      notice: (n) => replica.notice(n),
      saved: ({ ok }) => replica.saved(ok),
      media: (m) => replica.media(m),
      exportSheet: (s) => replica.exportSheet(s),
      recordSheet: (s) => replica.recordSheet(s),
      recordDevices: (d) => replica.recordDevices(d),
      recordPreview: (e) => recordPreviewEvent(e),
      recordedSheet: (s) => replica.recordedSheet(s),
      exportJob: (j) => replica.exportJob(j),
      snapshotSaved: ({ path }) => replica.snapshot(path),
      settingsSheet: (s) => replica.settings(s),
      key: ({ code, meta }) => {
        const el = document.activeElement;
        // In a text field ⌘⌫ keeps its meaning: delete back to the start of the line.
        if (code === "Backspace" && meta && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          const end = el.selectionEnd ?? 0;
          const start = el.selectionStart === end ? 0 : (el.selectionStart ?? 0);
          el.setRangeText("", start, end, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        (el ?? window).dispatchEvent(new KeyboardEvent("keydown", { code, key: code, metaKey: meta, bubbles: true, cancelable: true }));
      },
    },
  },
});
const view = new Electrobun.Electroview({ rpc });
const request = view.rpc!.request;

/** The window's document missed or couldn't apply a change: take the main process's copy. */
let resyncing = false;
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const o = await request.resync({});
    if (o) replica.resynced(o);
  } finally {
    resyncing = false;
  }
}

const report = async (p: Promise<{ ok: boolean; error?: string }>) => {
  const r = await p.catch((e: unknown) => ({ ok: false, error: String(e) }));
  if (!r.ok && r.error) replica.status(r.error);
};

const host: Host = {
  run: (command, args, label, coalesce) => void report(request.run({ command, args, label, coalesce })),
  query: async (name, args) => {
    const r = await request.query({ name, args });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  },
  undo: () => void report(request.undo({})),
  redo: () => void report(request.redo({})),
  openDialog: () => void report(request.openDialog({})),
  canvasView: (id, rect, scale, surround) => void request.canvasView({ id, ...rect, scale, surround }),
  canvasMarks: (marks) => view.rpc!.send.canvasMarks({ marks }),
  clipMenu: (clip, from) => void request.clipMenu({ clip, ...(from ? { canvas: true } : {}) }),
  canvasMenu: () => void request.canvasMenu({}),
  trackMenu: (track) => void request.trackMenu({ track }),
  binMenu: (asset) => void request.binMenu({ asset }),
  importMedia: () => void request.importMedia({}),
  dropFiles: (files, at) => void report(request.dropFiles({ files, ...at })),
  captureFrame: () => void report(request.captureFrame({})),
  frameImage: () => request.frameImage({}),
  binFrame: (asset, time) => request.binFrame({ asset, time }),
  analyze: (key, asset) => void request.analyze({ key, asset }),
  chooseFolder: (start) => request.chooseFolder({ start }),
  startExport: (params) => request.startExport(params),
  startRecording: (sources) => request.startRecording({ sources }),
  recordPreview: (devices) => void request.recordPreview(devices),
  recordFrames: (after) => request.recordFrames({ after }),
  checkSync: (camera, microphone, display, output) => request.checkSync({ camera, microphone, ...(display !== undefined ? { display } : {}), ...(output ? { output } : {}) }),
  testBeep: (output) => request.testBeep(output ? { output } : {}),
  cancelExport: (id) => void report(request.cancelExport({ id })),
  showFile: (path, open) => void request.showFile({ path, open }),
  setAppSettings: (s) => void request.setAppSettings(s),
  proxySpace: () => request.proxySpace({}),
  deleteAllProxies: () => request.deleteAllProxies({}),
  newProject: (name, settings, standalone) => request.newProject({ name, settings, standalone }),
  saveAs: (params) => request.saveAs(params),
  renameProject: (name) => request.renameProject({ name }),
  previewOpen: (asset) => request.previewOpen({ asset }),
  previewView: (id, rect, scale) => void request.previewView({ id, ...rect, scale }),
  previewPlay: (time) => void request.previewControl({ op: "play", time }),
  previewPause: (time) => void request.previewControl({ op: "pause", time }),
  previewSeek: (time) => void request.previewControl({ op: "seek", time }),
  previewClose: () => void request.previewControl({ op: "close" }),
};

// After React has drawn a change, tell the main process what is on screen.
let timer: ReturnType<typeof setTimeout> | undefined;
replica.subscribe(() => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const { project, session, opened } = replica.get();
    if (!project || !session) return;
    view.rpc!.send.shown({
      project: opened?.name,
      tracks: project.tracks.length,
      clips: project.tracks.reduce((n, t) => n + t.clips.length, 0),
      markers: project.markers.length,
      playhead: session.playhead,
      selection: session.selection,
      timeline: session.timeline,
      tool: session.panels.tool,
      properties: session.panels.properties ? session.inspector : null,
    });
  }, 30);
});

const init = await request.init({});
if (init.keyLog) {
  const describe = (t: EventTarget | null) => (t instanceof Element ? `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ""}${t.getAttribute("class") ? `.${t.getAttribute("class")!.split(" ")[0]}` : ""}` : String(t));
  const log = (stage: string, e: KeyboardEvent) =>
    view.rpc!.send.keyLog({
      line: `${stage} ${e.type} code=${e.code} key=${JSON.stringify(e.key)} mods=${[e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"].filter(Boolean).join("+")} target=${describe(e.target)} active=${describe(document.activeElement)} prevented=${e.defaultPrevented} trusted=${e.isTrusted}`,
    });
  for (const type of ["keydown", "keyup"] as const) {
    window.addEventListener(type, (e) => log("capture", e), true);
    // Next task: the page's handlers have run, so `prevented` says whether one took it.
    window.addEventListener(type, (e) => setTimeout(() => log("after", e)), false);
  }
}
replica.init(init);
createRoot(document.getElementById("root")!).render(<App host={host} />);
