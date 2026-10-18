import { recordPreviewEvent } from "./record-preview";
import type { AppRPC } from "./rpc";
import { replica } from "./store";

type Messages = AppRPC["webview"]["messages"];

/**
 * What each message from the main process does to the window's state, for the app's window and the UI harness
 * alike. `patches` (which resyncs on a gap) and `key` (a replayed shortcut) are each host's own.
 */
export const messageHandlers: { [K in Exclude<keyof Messages, "patches" | "key">]: (data: Messages[K]) => void } = {
  opened: (o) => replica.opened(o),
  session: ({ changes }) => replica.session(changes),
  status: ({ text }) => replica.status(text),
  rename: ({ track }) => replica.rename(track),
  renameMedia: ({ asset }) => replica.renameMedia(asset),
  showClipSpeed: ({ clip }) => replica.showClipSpeed(clip, true),
  newProjectSheet: ({ name }) => replica.newProject({ name }),
  recent: (r) => replica.recent(r),
  saveAsSheet: (s) => replica.saveAs(s),
  resourceSheet: (r) => replica.resource(r),
  resourceJob: (j) => replica.resourceJob(j),
  previewClock: (c) => replica.previewClock(c),
  notice: (n) => replica.notice(n),
  saved: ({ ok }) => replica.saved(ok),
  media: (m) => replica.media(m),
  exportSheet: (s) => replica.exportSheet(s),
  recordSheet: (s) => replica.recordSheet(s),
  recordDevices: (d) => replica.recordDevices(d),
  recordPreview: (e) => recordPreviewEvent(e),
  recordedSheet: (s) => replica.recordedSheet(s),
  narrating: (n) => replica.narrating(n),
  exportJob: (j) => replica.exportJob(j),
  snapshotSaved: ({ path }) => replica.snapshot(path),
  settingsSheet: (s) => replica.settings(s),
  favorites: ({ items }) => replica.favorites(items),
  shortcuts: ({ shortcuts }) => replica.shortcuts(shortcuts),
  palette: () => replica.palette(true),
  appSettings: (a) => replica.appSettings(a),
  preferences: (p) => replica.preferences(p),
  closeDialogs: () => replica.closeDialogs(),
};

/** Applies a request's reply (the favourites or shortcuts as they now are), or shows why it failed. */
export const applyReply =
  <T,>(set: (value: T) => void) =>
  async (p: Promise<unknown>) => {
    const r = (await p.catch((e: unknown) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string; result?: T };
    if (r.result !== undefined) set(r.result);
    else if (r.error) replica.status(r.error);
  };
