import type { Host } from "./app";
import { commandQueue } from "./latest";
import { applyReply } from "./messages";
import type { AppRPC } from "./rpc";
import { replica } from "./store";

type Requests = AppRPC["bun"]["requests"];
/** A request to the main process: the app's RPC, or the UI harness's socket. */
export type Request = <K extends keyof Requests>(name: K, params: Requests[K]["params"]) => Promise<Requests[K]["response"]>;

/**
 * The window's `Host`: what the editor asks the main process for, the same for the app and the UI harness, which
 * passes only its transport and stands-ins for what has no window here (`extras`: the native views, Finder).
 */
export function createHost(request: Request, extras: Partial<Host> = {}): Host {
  const report = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p.catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok && r.error) replica.status(r.error);
  };

  const commands = commandQueue(report);

  const shortcuts = applyReply(replica.shortcuts);
  const favorites = applyReply(replica.favorites);

  return {
    run: (command, args, label, coalesce) => commands.send(() => request("run", { command, args, label, coalesce }), coalesce),
    query: async (name, args) => {
      const r = await request("query", { name, args });
      if (!r.ok) throw new Error(r.error);
      return r.result;
    },
    undo: () => commands.send(() => request("undo", {})),
    redo: () => commands.send(() => request("redo", {})),
    openDialog: () => commands.send(() => request("openDialog", {})),
    openRecent: (path) => void commands.ordered(() => request("openRecent", { path })),
    canvasView: (id, rect, scale, surround) => void request("canvasView", { id, ...rect, scale, surround }),
    clipMenu: (clip, from) => void request("clipMenu", { clip, ...(from ? { canvas: true } : {}) }),
    canvasMenu: () => void request("canvasMenu", {}),
    trackMenu: (track) => void request("trackMenu", { track }),
    binMenu: (asset) => void request("binMenu", { asset }),
    tileMenu: (tile) => void request("tileMenu", tile),
    recentMenu: (path) => void request("recentMenu", { path }),
    importMedia: () => void request("importMedia", {}),
    dropFiles: (files, at) => commands.send(() => request("dropFiles", { files, ...at })),
    captureFrame: () => commands.send(() => request("captureFrame", {})),
    frameImage: () => request("frameImage", {}),
    binFrame: (asset, time) => request("binFrame", { asset, time }),
    analyze: (key, asset) => void request("analyze", { key, asset }),
    favoriteAdd: (item, index) => void favorites(request("favoriteAdd", { item, ...(index !== undefined ? { index } : {}) })),
    favoriteRemove: (item) => void favorites(request("favoriteRemove", { item })),
    favoriteMove: (item, index) => void favorites(request("favoriteMove", { item, index })),
    shortcutSet: (action, keys, replace) => void shortcuts(request("shortcutSet", { action, keys, ...(replace ? { replace } : {}) })),
    shortcutReset: (action) => void shortcuts(request("shortcutReset", action ? { action } : {})),
    app: (action) => void request("appAction", { action }),
    chooseFolder: (start) => request("chooseFolder", { start }),
    chooseFile: (extensions) => request("chooseFile", { extensions }),
    importFile: (path) => request("importFile", { path }),
    startExport: (params) => request("startExport", params),
    startRecording: (sources) => request("startRecording", { sources }),
    narrationDevices: () => request("narrationDevices", {}),
    openRecord: (mode) => void request("openRecord", mode ? { mode } : {}),
    startNarration: (microphone, hear) => request("startNarration", { microphone, hear }),
    stopNarration: (discard) => void report(request("stopNarration", discard ? { discard } : {})),
    recordPreview: (devices) => void request("recordPreview", devices),
    recordFrames: (after) => request("recordFrames", { after }),
    checkSync: (camera, microphone, display, output) => request("checkSync", { camera, microphone, ...(display !== undefined ? { display } : {}), ...(output ? { output } : {}) }),
    testBeep: (output) => request("testBeep", output ? { output } : {}),
    cancelExport: (id) => void report(request("cancelExport", { id })),
    showFile: (path, open) => void request("showFile", { path, open }),
    setAppSettings: (s) => void request("setAppSettings", s),
    proxySpace: () => request("proxySpace", {}),
    deleteAllProxies: () => request("deleteAllProxies", {}),
    newProject: (name, settings, standalone) => commands.ordered(() => request("newProject", { name, settings, standalone })),
    saveAs: (params) => commands.ordered(() => request("saveAs", params)),
    fetchResource: (id) => request("fetchResource", { id }),
    declineResource: (id) => void request("declineResource", { id }),
    setPreference: (id, value) => request("setPreference", { id, value }),
    setSecret: (id, value) => request("setSecret", { id, value }),
    cancelJob: (id) => void report(request("cancelJob", { id })),
    renameProject: (name) => request("renameProject", { name }),
    previewOpen: (asset) => request("previewOpen", { asset }),
    previewView: (id, rect, scale) => void request("previewView", { id, ...rect, scale }),
    previewPlay: (time) => void request("previewControl", { op: "play", time }),
    previewPause: (time) => void request("previewControl", { op: "pause", time }),
    previewSeek: (time) => void request("previewControl", { op: "seek", time }),
    previewClose: () => void request("previewControl", { op: "close" }),
    ...extras,
  };
}
