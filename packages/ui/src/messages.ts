import { recordPreviewEvent } from "./record-preview";
import type { AppRPC } from "./rpc";
import { ticksToSeconds } from "@beacon/model";
import { aboutSection } from "./ask-agent";
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
  sectionAction: ({ section, op }) => {
    const s = replica.get().project?.sections.find((x) => x.id === section);
    if (!s) return;
    if (op === "rename") replica.nameSection({ id: s.id, start: ticksToSeconds(s.start), end: ticksToSeconds(s.end) });
    else replica.askAgent(aboutSection(s));
  },
  markerAction: ({ marker }) => replica.nameMarker(marker),
  renameMedia: ({ asset }) => replica.renameMedia(asset),
  newProjectSheet: ({ name, folder, standalone }) => replica.newProject({ name, folder, standalone: !!standalone }),
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
  taskJob: (j) => replica.taskJob(j),
  importing: (i) => replica.importing(i),
  snapshotSaved: ({ path }) => replica.snapshot(path),
  settingsSheet: (s) => replica.settings(s),
  usage: ({ items }) => replica.usedItems(items),
  agentReply: ({ request, status, text }) => replica.agentState(request, status, text),
  shortcuts: ({ shortcuts }) => replica.shortcuts(shortcuts),
  memory: ({ memory }) => replica.memory(memory),
  palette: () => replica.palette(true),
  projectSettings: () => replica.projectSettings(true),
  appSettings: (a) => replica.appSettings(a),
  preferences: (p) => replica.preferences(p),
  closeDialogs: () => replica.closeDialogs(),
};

/** Applies a request's reply (the items by use, or shortcuts, as they now are), or shows why it failed. */
export const applyReply =
  <T,>(set: (value: T) => void) =>
  async (p: Promise<unknown>) => {
    const r = (await p.catch((e: unknown) => ({ ok: false, error: String(e) }))) as { ok: boolean; error?: string; result?: T };
    if (r.result !== undefined) set(r.result);
    else if (r.error) replica.status(r.error);
  };
