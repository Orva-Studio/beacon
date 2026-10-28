import { applyPatches, enablePatches } from "immer";
import { useSyncExternalStore } from "react";
import type { Patch, Project, Session } from "@beacon/model";
import type { PanelItem } from "./drop";
import type { ExportJob, ExportSheet, ImportingFiles, Init, Narrating, Opened, RecordedSheet, RecordSheet, SettingsSheet, TaskJob } from "./rpc";

enablePatches();

export interface ViewState {
  /** The document revision the replica is at. */
  rev?: number;
  /**
   * Something picked in the command palette (at revision `rev`): once what it added arrives, the properties panel puts
   * the caret in its first input. With `tab` (the properties tab stepped from by : [ and : ]), once the tab has changed.
   */
  focusInputs?: { rev: number; effect: boolean; at: number; tab?: string };
  init?: Init;
  opened?: Omit<Opened, "project" | "session" | "rev">;
  /** A replica of the main process's document, updated only by its patches. */
  project?: Project;
  session?: Session;
  status: string;
  waveforms: Record<string, Record<number, number[]>>;
  thumbs: Record<string, string>;
  /** The Media Bin's selected items ("Select in Media Bin" and Snapshot select one). */
  binSelected: string[];
  /** The track whose name is being edited. */
  renaming?: string;
  /** The Media Bin item whose name is being edited. */
  renamingMedia?: string;
  /** The section picked on the timeline's Sections band (⌫ removes it). */
  section?: string;
  /** A section being named: a new one from `start` to `end` (seconds), or `id` renamed. */
  namingSection?: { id?: string; start: number; end: number };
  /** False after a save failed, until one succeeds. */
  saved?: boolean;
  /** Assets whose proxy is being made, and its progress 0-1. */
  preparing: Record<string, number>;
  /** Assets whose transcript is being made, and its progress 0-1. */
  transcribing: Record<string, number>;
  /** Assets whose takes OpenAI is judging (Remove Retakes), and its progress 0-1; and why it failed, for those it couldn't. */
  judging: Record<string, number>;
  judgeFailed: Record<string, string>;
  /** Analyses of media running (`<analyzer>:<asset>`, their progress 0–1), and why those that failed did. */
  analyzing: Record<string, number>;
  analysisFailed: Record<string, string>;
  /** Media whose transcript or proxy failed, and why: the import panel says so rather than Ready. */
  jobFailed: Record<string, string>;
  /** Captions asked for before the transcript was there: made when it is. */
  captionsPending?: boolean;
  /** Proxies finished since the current run of them began (the top bar's "N of M"). */
  prepared: number;
  /** Whether each asset has a proxy (a quick-to-seek copy). */
  proxies: Record<string, boolean>;
  /** Media whose file was moved or deleted. */
  missing: string[];
  /** The Favorites panel's items, in order (`Init.favorites`). */
  favorites: string[];
  /** App-wide choices (the transcriber), `Init.preferences`. */
  preferences: import("./transcripts-settings").PreferenceInfo[];
  /** When ⌘S last asked for a save (`app.save`): the title bar says the project is saved already. */
  confirmSaved?: number;
  /** Every action with its keys (`Init.shortcuts`). */
  shortcuts: import("@beacon/model").ShortcutInfo[];
  /** The command palette, while open. */
  palette?: boolean;
  /** Project Settings, while open. */
  projectSettings?: boolean;
  /** A panel item being dragged onto media, and where the pointer is (client points). */
  dragging?: { item: PanelItem; x: number; y: number };
  /** The Export dialog, while open. */
  exportSheet?: ExportSheet;
  recordSheet?: RecordSheet;
  recordedSheet?: RecordedSheet;
  /** The narration being recorded, while it is. */
  narrating?: Narrating;
  /** The latest export, running or finished, until dismissed. */
  exportJob?: ExportJob;
  /** Features' background jobs, running or finished, until dismissed. */
  tasks: TaskJob[];
  /** The keys of a sequence pressed so far (the leader key, :), its next keys shown until one is pressed. */
  leader?: string;
  /** Imports under way or just finished, by id, until their panel is dismissed. */
  imports: Record<string, ImportingFiles>;
  /** Imports whose panel was dismissed while their files were still read: their tiles stay, the panel doesn't come back. */
  importsHidden: string[];
  /** The Settings window, while open, with the app settings it opened with. */
  settings?: SettingsSheet;
  /** The last Snapshot's file, while its toast shows. */
  snapshot?: string;
  /** A notice being shown (what an import left out). */
  notice?: import("./rpc").Notice;
  /** The Media Bin preview, while open. */
  preview?: { asset: string; name: string; info: import("./media-preview").AssetPreviewInfo };
  /** Where the preview is playing. */
  previewClock: { time: number; playing: boolean };
  /** The New Project dialog, while open, with the name it offers. */
  newProject?: { name: string };
  saveAs?: import("./project-name").SaveAsSheet;
  /** The dialog asking to download a resource (the speech model), and its download. */
  resource?: import("./resource").ResourceInfo;
  resourceJob?: import("./resource").ResourceJob;
  /** A callout double-clicked on the canvas: its text box takes focus. */
  editingText?: string;
  /** The colour picker's eyedropper is waiting for a click on the canvas: called with its colour (0-1 RGB), or nothing if it failed. */
  picking?: (rgb?: [number, number, number]) => void;
  /** The Media Bin's Sort by, and whether it is descending. */
  binSort: { by: BinSort; desc: boolean };
  /** The Media Bin's search, kind filter and layout. */
  bin: { query: string; kind: BinKind; view: "grid" | "list" };
}

export type BinSort = "name" | "added" | "created" | "dimensions" | "duration";
export type BinKind = "all" | "video" | "audio" | "image";

let state: ViewState = { status: "", favorites: [], shortcuts: [], preferences: [], waveforms: {}, thumbs: {}, preparing: {}, transcribing: {}, judging: {}, judgeFailed: {}, analyzing: {}, analysisFailed: {}, jobFailed: {}, prepared: 0, proxies: {}, missing: [], binSelected: [], binSort: { by: "added", desc: false }, bin: { query: "", kind: "all", view: "grid" }, tasks: [], previewClock: { time: 0, playing: false }, imports: {}, importsHidden: [] };
const listeners = new Set<() => void>();
let statusTimer: ReturnType<typeof setTimeout> | undefined;
/** Long enough to read: 5 s, more for a long message, at most 10. */
export const statusSeconds = (text: string) => Math.min(10, Math.max(5, text.length / 12));

function set(next: Partial<ViewState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const replica = {
  get: () => state,
  init(init: Init) {
    set({ init, favorites: init.favorites, shortcuts: init.shortcuts, preferences: init.preferences });
    if (init.opened) replica.opened(init.opened);
  },
  opened({ project, session, rev, ...rest }: Opened) {
    set({ opened: rest, project, session, rev, palette: false, projectSettings: false, waveforms: {}, thumbs: {}, preparing: {}, transcribing: {}, judging: {}, judgeFailed: {}, analyzing: {}, analysisFailed: {}, jobFailed: {}, captionsPending: false, prepared: 0, proxies: {}, missing: [], binSelected: [], imports: {}, importsHidden: [] });
  },
  /** Applies the next revision's patches; returns false when the replica can't (a gap, or patches that don't apply), so it must resync. */
  patches(patches: Patch[], rev?: number): boolean {
    if (!state.project) return false;
    // Already in a resynced copy.
    if (rev !== undefined && state.rev !== undefined && rev <= state.rev) return true;
    if (rev !== undefined && state.rev !== undefined && rev !== state.rev + 1) return false;
    try {
      set({ project: applyPatches(state.project, patches), rev: rev ?? state.rev });
      return true;
    } catch {
      return false;
    }
  },
  /** Replaces the document (and session) with the main process's, keeping the panels' pictures. */
  resynced({ project, session, rev }: Opened) {
    set({ project, session, rev });
  },
  /** Merges the session's changed keys; unchanged ones keep their identity, so views keyed on them don't redraw. */
  session(changes: Partial<Session>) {
    if (state.session) set({ session: { ...state.session, ...changes } });
  },
  media({ waveforms, thumbs, highlight, preparing, transcribing, judging, judgeFailed, analyzing, analysisFailed, jobFailed, proxies, missing }: { waveforms?: ViewState["waveforms"]; thumbs?: ViewState["thumbs"]; highlight?: string; preparing?: ViewState["preparing"]; transcribing?: ViewState["transcribing"]; judging?: ViewState["judging"]; judgeFailed?: ViewState["judgeFailed"]; analyzing?: ViewState["analyzing"]; analysisFailed?: ViewState["analysisFailed"]; jobFailed?: ViewState["jobFailed"]; proxies?: ViewState["proxies"]; missing?: string[] }) {
    set({
      // Only what came: a new object would redraw the timeline and the Media Bin for a progress message.
      ...(waveforms ? { waveforms: { ...state.waveforms, ...waveforms } } : {}),
      ...(thumbs ? { thumbs: { ...state.thumbs, ...thumbs } } : {}),
      ...(highlight ? { binSelected: [highlight] } : {}),
      ...(preparing ? { preparing, prepared: Object.keys(preparing).length ? state.prepared + Object.keys(state.preparing).filter((id) => !(id in preparing)).length : 0 } : {}),
      ...(transcribing ? { transcribing } : {}),
      ...(judging ? { judging } : {}),
      ...(judgeFailed ? { judgeFailed } : {}),
      ...(analyzing ? { analyzing } : {}),
      ...(analysisFailed ? { analysisFailed } : {}),
      ...(jobFailed ? { jobFailed: { ...state.jobFailed, ...jobFailed } } : {}),
      ...(proxies ? { proxies: { ...state.proxies, ...proxies } } : {}),
      ...(missing ? { missing } : {}),
    });
  },
  rename(track: string | undefined) {
    set({ renaming: track });
  },
  saved(ok: boolean) {
    if (state.saved !== ok) set({ saved: ok });
  },
  renameMedia(asset: string | undefined) {
    set({ renamingMedia: asset });
  },
  section(section: string | undefined) {
    if (section !== state.section) set({ section });
  },
  nameSection(naming: ViewState["namingSection"]) {
    set({ namingSection: naming });
  },
  favorites(favorites: string[]) {
    set({ favorites });
  },
  preferences(preferences: ViewState["preferences"]) {
    set({ preferences });
  },
  shortcuts(shortcuts: ViewState["shortcuts"]) {
    set({ shortcuts });
  },
  confirmSaved() {
    set({ confirmSaved: performance.now() });
  },
  focusInputs(effect: boolean | undefined, tab?: string) {
    set({ focusInputs: effect === undefined ? undefined : { rev: state.rev ?? 0, effect, at: performance.now(), tab } });
  },
  /** Opened only with a project: it lists what can be added to one. */
  palette(palette: boolean) {
    // A focus asked for before (an effect added, then undone at once) mustn't take the caret from the palette.
    set({ palette: palette && !!state.opened, ...(palette ? { focusInputs: undefined } : {}) });
  },
  projectSettings(open: boolean) {
    set({ projectSettings: open && !!state.opened });
  },
  /** Settings changed elsewhere: an open Settings window takes them. */
  appSettings(next: import("./rpc").AppSettings) {
    if (state.settings) set({ settings: { ...state.settings, ...next } });
  },
  /** The dialogs an agent can open (`ui_open`), closed. */
  closeDialogs() {
    set({ settings: undefined, projectSettings: false, exportSheet: undefined, newProject: undefined, recordSheet: undefined, palette: false });
  },
  drag(dragging: ViewState["dragging"]) {
    set({ dragging });
  },
  exportSheet(exportSheet: ExportSheet | undefined) {
    set({ exportSheet });
  },
  recordSheet(recordSheet: RecordSheet | undefined) {
    set({ recordSheet });
  },
  recordDevices(devices: Pick<RecordSheet, "permissions" | "displays" | "cameras" | "microphones" | "outputs">) {
    const s = state.recordSheet;
    if (s) set({ recordSheet: { ...s, ...devices } });
  },
  recordedSheet(recordedSheet: RecordedSheet | undefined) {
    set({ recordedSheet });
  },
  narrating(narrating: Narrating | null) {
    set({ narrating: narrating ?? undefined });
  },
  exportJob(exportJob: ExportJob | undefined) {
    set({ exportJob });
  },
  taskJob(job: TaskJob) {
    set({ tasks: [...state.tasks.filter((t) => t.id !== job.id), job] });
  },
  leader(leader: string | undefined) {
    if (leader !== state.leader) set({ leader });
  },
  dismissTask(id: string) {
    set({ tasks: state.tasks.filter((t) => t.id !== id) });
  },
  importing(i: ImportingFiles) {
    if (state.importsHidden.includes(i.id) && i.state !== "reading") {
      const { [i.id]: _, ...imports } = state.imports;
      return set({ imports, importsHidden: state.importsHidden.filter((id) => id !== i.id) });
    }
    set({ imports: { ...state.imports, [i.id]: i } });
  },
  importsDismissed() {
    const reading = Object.values(state.imports).filter((i) => i.state === "reading");
    set({ imports: Object.fromEntries(reading.map((i) => [i.id, i])), importsHidden: reading.map((i) => i.id) });
  },
  sortBin(binSort: ViewState["binSort"]) {
    set({ binSort });
  },
  selectBin(binSelected: string[]) {
    set({ binSelected });
  },
  viewBin(bin: Partial<ViewState["bin"]>) {
    set({ bin: { ...state.bin, ...bin } });
  },
  snapshot(snapshot: ViewState["snapshot"]) {
    set({ snapshot });
  },
  notice(notice: ViewState["notice"]) {
    set({ notice });
  },
  preview(preview: ViewState["preview"]) {
    set({ preview, previewClock: { time: 0, playing: false } });
  },
  previewClock(previewClock: ViewState["previewClock"]) {
    set({ previewClock });
  },
  recent(recent: import("./rpc").RecentProject[]) {
    if (state.init) set({ init: { ...state.init, recent } });
  },
  newProject(newProject: ViewState["newProject"]) {
    set({ newProject });
  },
  saveAs(saveAs: ViewState["saveAs"]) {
    set({ saveAs });
  },
  resource(resource: ViewState["resource"]) {
    // A finished or failed download isn't shown when the dialog opens again; a running one is.
    set({ resource, ...(state.resourceJob?.state === "running" ? {} : { resourceJob: undefined }) });
  },
  /** A download finished: the dialog has done its job. */
  resourceJob(resourceJob: ViewState["resourceJob"]) {
    set(resourceJob?.state === "done" ? { resourceJob: undefined, resource: undefined } : { resourceJob });
  },
  pick(picking: ViewState["picking"]) {
    set({ picking });
  },
  pendCaptions(captionsPending: boolean) {
    set({ captionsPending });
  },
  editText(editingText: string | undefined) {
    set({ editingText });
  },
  settings(settings: SettingsSheet | undefined) {
    set({ settings });
  },
  status(status: string) {
    clearTimeout(statusTimer);
    set({ status });
    if (status) statusTimer = setTimeout(() => set({ status: "" }), statusSeconds(status) * 1000);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useView<T>(pick: (s: ViewState) => T): T {
  return useSyncExternalStore(replica.subscribe, () => pick(state));
}
