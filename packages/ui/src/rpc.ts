import type { CanvasValues } from "./canvas-values";
import type { DroppedFile, RecorderDevices, RecorderLevel, RecorderPreviewEvent, RecorderSources, SyncResult } from "@beacon/media";
import type { AppSettings, CameraSync, Keys, Patch, Project, Session, SettingsPatch, SettingsTab, ShortcutInfo, ExportFormat, VideoEncoding } from "@beacon/model";
import type { CoreEvent, SchemaInfo, SecretInfo } from "@beacon/core";

export type { AppSettings, CameraSync, SettingsPatch } from "@beacon/model";
export type { RecorderLive } from "@beacon/media";
export { syncKey, withPatch } from "@beacon/model";

import type { CanvasMark } from "./canvas-marks";
import type { AssetPreviewInfo } from "./media-preview";
import type { SaveAsSheet } from "./project-name";
import type { ResourceInfo, ResourceJob } from "./resource";
import type { PreferenceInfo } from "./transcripts-settings";

export type { CanvasValues };
export { canvasChange } from "./canvas-values";
export type { CanvasMark };

/** One shortcut from `keymaps/default.json`. */
export interface TaskJob {
  id: string;
  label: string;
  stage?: string;
  progress: number;
  state: "running" | "done" | "failed";
  error?: string;
}

/** An effect's params shown on the canvas without an edit. */
export interface EffectPreview {
  clip: string;
  effect: string;
  params: Record<string, unknown>;
}

export interface Binding {
  keys: Keys;
  command: string;
  args?: Record<string, unknown>;
  /** The action it belongs to (`ShortcutInfo.id`). */
  action?: string;
}

export interface PropGroupInfo {
  id: string;
  description: string;
  /** What a clip without its own values has. */
  defaults: Record<string, unknown>;
}

export interface Opened {
  path: string;
  name: string;
  project: Project;
  session: Session;
  /** The document's revision: each `patches` message is the next one. */
  rev: number;
}

/** A project from Open Recent; `opened`: ms since 1970. */
export interface RecentProject {
  path: string;
  name: string;
  opened: number;
  /** A PNG data URL of the project as it was last left. */
  thumb?: string;
}

export interface Init {
  opened?: Opened;
  recent: RecentProject[];
  /** Where New Project puts a project: the folder last chosen for one, else ~/Movies/Beacon. */
  projectsFolder: string;
  /** Every action of the menus, keys and command palette with its keys, the user's changes merged over the defaults. */
  shortcuts: ShortcutInfo[];
  propGroups: PropGroupInfo[];
  /** `schema`: JSON Schema of the params, for the properties panel's controls; `traits`: clips with any of them take it. */
  effects: SchemaInfo["effects"];
  panelItems: SchemaInfo["panelItems"];
  /** Clip type → traits ("video", "hold", ...). */
  clipTypes: Record<string, string[]>;
  /** Clip type → the prop group holding its own tracks (groups, stitched media). */
  nested: Record<string, string>;
  /** Each clip type's properties panel tabs, in order. */
  tabs: Record<string, { id: string; title: string; icon: string }[]>;
  /** Clip types that can change speed with no media of their own. */
  retimes: string[];
  socket: string;
  /** App-wide choices (the transcriber), as Settings shows them; `preferences` messages follow changes. */
  preferences: PreferenceInfo[];
  /** The Favorites panel's items in order (app-wide): `annotation:<preset>`, `effect:<id>`, `audio:fade-in` / `audio:fade-out`. */
  favorites: string[];
  /** BEACON_KEYLOG=1: the window reports every key event it sees (`keyLog`), to debug shortcuts in the app. */
  keyLog?: boolean;
}

/** What the window has drawn, reported back so agents and tests can check the UI caught up. */
export interface Shown {
  project?: string;
  tracks: number;
  clips: number;
  markers: number;
  playhead: number;
  selection: string[];
  timeline: { start: number; end: number };
  tool: string | null;
  properties: string | null;
}

export interface RunReply {
  ok: boolean;
  error?: string;
}

/** A file dropped from Finder, as the webview sees it: no path, unless WebKit gives its URL. */
export type { DroppedFile };

/** A tile's right-click menu: what its Add item runs (the tile's own double-click) and whether it is a favourite. */
export interface TileMenu {
  item: string;
  /** "Add to Selected Media", or "Add at Playhead" for an annotation. */
  add: string;
  command: string;
  args: Record<string, unknown>;
  favorite: boolean;
}

export { exportOptions } from "./export-options";
export { appWideMessage, exportCanvas, exportSheetFor, initPayload, settingsSheet } from "./payloads";
export { appBridge, coreRequests, projectBridge, tileChoice, tileMenuItems, type AppBridgeHooks, type BridgeHooks, type ProjectBridge, type Send } from "./bridge";
export { DEFAULT_EXPORT } from "./export-defaults";
export { panelHeight, recordingTitle } from "./record-panel-size";
export { clock } from "./time";
export { copiedIds } from "./clip-ids";
// The timeline's geometry, for the UI harness's clicks.
export { BAND, clipBox, cornerButtons, headerIcons, headerWidth, RULER, TRACKS_TOP } from "./timeline-layout";

export interface Notice {
  title: string;
  message: string;
  lines?: string[];
}

/** App-wide settings (Settings > General), kept by the main process. */
export type { SettingsTab } from "@beacon/model";
/** Settings as the window opens it: `tab` the one to open on. */
/** Settings, with the devices Settings › Recording picks from (the ones last recorded chosen). */
export type SettingsSheet = AppSettings & { tab?: SettingsTab; devices?: RecordDevices; resources?: ResourceInfo[]; preferences?: PreferenceInfo[]; secrets?: SecretInfo[] };

/** Where the Mac's sound can play; `speakers` when the room (and a microphone) hears it. */
export type SoundOutput = RecorderDevices["outputs"][number];

export interface RecordDevices {
  displays: { id: number; width: number; height: number }[];
  outputs: SoundOutput[];
  /** The display last recorded. */
  display?: number;
  cameras: { id: string; name: string }[];
  microphones: { id: string; name: string }[];
  camera?: string;
  microphone?: string;
}

/** A sync check's result. */
export type SyncCheck = SyncResult;

/** The Export dialog's choices: core's `VideoEncoding`, every one set, null where it is left automatic. */
export interface ExportSettings {
  format: ExportFormat;
  codec: NonNullable<VideoEncoding["codec"]>;
  /** kbit/s; null: automatic. */
  bitrate: number | null;
  keyframe: number;
  profile: NonNullable<VideoEncoding["profile"]>;
  /** null: the project's. */
  fps: number | null;
  /** Fit within; null: the canvas. */
  size: { width: number; height: number } | null;
  audio: boolean;
  /** kbit/s; null: automatic. */
  audioBitrate: number | null;
}

/** What File > Export opens the dialog with. */
export interface ExportSheet {
  name: string;
  folder: string;
  settings: ExportSettings;
  /** Export Selection: the in/out range. */
  range?: { in: number; out: number };
  /** Export Selection with clips selected (it wins over the range): only those, over their span. */
  clips?: { ids: string[]; in: number; out: number; silent?: boolean; usual?: Pick<ExportSettings, "format" | "audio"> };
  canvas: { width: number; height: number; fps: number };
}

/** What a take records; a missing source isn't recorded, a device without an id is the default one. */
export type RecordSources = Pick<RecorderSources, "systemAudio" | "camera" | "microphone"> & { screen?: Omit<NonNullable<RecorderSources["screen"]>, "exclude"> };

/** An audio level in dBFS: the average and the recent peak. */
export type AudioLevel = RecorderLevel;

/** What the Record dialog or the recording panel shows: a camera or screen frame (base64 JPEG), or the audio levels. */
/** `live`: each source a take records, and whether it still sends; `picture.camera`: a camera still sending, but black or frozen. */
export type RecordPreview = Exclude<RecorderPreviewEvent, { devicesChanged: true }>;

/** A take just recorded and imported: its media item, to name. */
export interface RecordedSheet {
  asset: string;
  name: string;
  duration: number;
  /** What the recorder couldn't save, by source ("microphone: …"). */
  problems?: string[];
}

/** What File > Record… opens the dialog with: what the recorder can use, and the sources last recorded. */
/** What the Record dialog records: a take of the screen, camera and audio, or voice narration over the timeline. */
export type RecordMode = "take" | "narration";

export interface RecordSheet {
  /** Which choice it opens on (Tools › Voice Narration opens on narration); a take by default. */
  mode?: RecordMode;
  /** Narration's last choice: whether the timeline's own sound is heard while recording. */
  hear?: boolean;
  permissions: { screen: string; camera: string; microphone: string };
  displays: { id: number; width: number; height: number; pixelWidth?: number; pixelHeight?: number; x?: number; y?: number }[];
  cameras: { id: string; name: string; width?: number; height?: number; fps?: number }[];
  microphones: { id: string; name: string }[];
  outputs: SoundOutput[];
  sources: RecordSources;
  cameraSync?: Record<string, CameraSync>;
}

/** A narration being recorded: when it began (ms, wall clock), and the timeline span it plays (seconds). */
export interface Narrating {
  started: number;
  from: number;
  until: number;
}

/** An export running or finished, for the window's progress panel. */
/** Files being imported (core's `importing`): read, then their media made. */
export type ImportingFiles = Omit<Extract<CoreEvent, { kind: "importing" }>, "kind">;

export interface ExportJob {
  id: string;
  output: string;
  state: "running" | "done" | "failed";
  progress: number;
  error?: string;
}

/** The newest preview frames (base64 JPEG) after `seq`: what a Record dialog or recording panel draws next. */
export interface RecordFrames {
  seq: number;
  camera?: string;
  screen?: string;
}

/** What the recording panel shows besides frames and levels: when the take began, and which sources it has. */
export interface PanelState {
  /** Unix milliseconds. */
  started: number;
  screen: boolean;
  camera: boolean;
  microphone: boolean;
  systemAudio: boolean;
}

/** Electrobun RPC between the main process and the recording panel, the small window over the screen while a take records. */
export type PanelRPC = {
  bun: {
    requests: {
      /** The panel's state once its page has loaded. */
      panelInit: { params: {}; response: PanelState | null };
    };
    messages: {
      stopRecording: {};
      /** Hides the panel; the menu-bar item shows it again. */
      hidePanel: {};
    };
  };
  webview: {
    requests: {};
    messages: {
      recordPreview: RecordPreview;
      /** The take has begun (its sources are delivering): the time counts from here. */
      recordStarted: { started: number };
    };
  };
};

/** Electrobun RPC between the main process (document owner) and the webview (a view of it). */
export type AppRPC = {
  bun: {
    requests: {
      init: { params: {}; response: Init };
      /** The document as the main process has it, when the window's copy can't be trusted. */
      resync: { params: {}; response: Opened | undefined };
      /** A document or session command, as agents run them. */
      run: { params: { command: string; args?: unknown; label?: string; coalesce?: string }; response: RunReply };
      query: { params: { name: string; args?: unknown }; response: { ok: boolean; result?: unknown; error?: string } };
      undo: { params: {}; response: RunReply };
      redo: { params: {}; response: RunReply };
      openDialog: { params: {}; response: RunReply };
      openRecent: { params: { path: string }; response: void };
      /** Shows the right-click menu for a clip (a native menu). */
      /** `canvas`: opened from the canvas, which adds Project Settings… and Zoom to Fit. */
      clipMenu: { params: { clip: string; canvas?: boolean }; response: void };
      canvasMenu: { params: {}; response: void };
      /** The right-click menu for a Media Bin item. */
      binMenu: { params: { asset?: string }; response: void };
      /** The right-click menu for a tool panel's tile (an effect, annotation or audio effect). */
      tileMenu: { params: TileMenu; response: void };
      /** A recent project's right-click on the start screen: Open, Show in Finder, Remove from Recent Projects, Move to Trash…. */
      recentMenu: { params: { path: string }; response: void };
      /** Import Media…'s file picker (the Media Bin's Import tile). */
      importMedia: { params: {}; response: void };
      /** Files dragged in from Finder: imported at `time` on `track` (a drop on the timeline), else after the last clip. */
      dropFiles: { params: { files: DroppedFile[]; time?: number; track?: string; timing?: { over?: number; drop?: number; read?: number } }; response: RunReply };
      /** A track's menu, or the track options (null). */
      trackMenu: { params: { track: string | null }; response: void };
      captureFrame: { params: {}; response: RunReply };
      frameImage: { params: {}; response: string | null };
      /** An effect shown with other params on the canvas only, or null to show it as it is (a look under the pointer). */
      previewEffect: { params: { preview: EffectPreview | null }; response: RunReply };
      /** A Media Bin item's picture `time` seconds in, as a data URL, for scrubbing it under the pointer. */
      binFrame: { params: { asset: string; time: number }; response: string | null };
      /** Show a file in the project's folder in Finder. */
      reveal: { params: { path: string }; response: { ok: boolean; error?: string } };
      /** Starts a media item's background analysis unless it is running (Remove Silences' missing transcripts). */
      analyze: { params: { key: string; asset: string }; response: void };
      /** A folder picked in the Finder dialog, starting at `start`. */
      chooseFolder: { params: { start: string }; response: string | null };
      chooseFile: { params: { extensions: string[] }; response: string | null };
      /** A file picked for an effect (a LUT) imported into the project, placing no clips: its asset id. */
      importFile: { params: { path: string }; response: RunReply & { result?: string } };
      /** Export to `folder`/`name`.`format`; refused when it exists unless `overwrite`. */
      startExport: { params: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; clips?: string[]; overwrite?: boolean }; response: RunReply };
      cancelExport: { params: { id: string }; response: RunReply };
      /** Record: Beacon hides and records a take into the project; its menu-bar item stops it. */
      startRecording: { params: { sources: RecordSources }; response: RunReply };
      /** The Record dialog (the Record button), as File › Record… opens it; `narration`, with only the microphone, as Tools › Voice Narration… does. */
      openRecord: { params: { mode?: RecordMode }; response: void };
      /** What the Narration panel picks from: the microphones and permissions, and the last choices (`sources.microphone`, `hear`). */
      narrationDevices: { params: {}; response: RecordSheet };
      /** Voice narration: records the microphone while the timeline plays from the playhead (or through the range). */
      startNarration: { params: { microphone: { id?: string }; hear: boolean }; response: RunReply };
      /** Ends the narration and places it, or throws it away (`discard`). */
      stopNarration: { params: { discard?: boolean }; response: RunReply };
      /** Asks macOS for the camera and microphone among the sources it hasn't been asked about: the permissions then. */
      recordAccess: { params: RecordSources; response: Pick<RecordSheet, "permissions"> & { error?: string } };
      /** Shows the sources in the Record dialog (levels as `recordPreview` messages, frames from `recordFrames`); with none, stops. */
      recordPreview: { params: RecordSources; response: RunReply };
      /** Check Sync: flashes the screen and beeps while recording the camera and microphone, measures and saves their delay. */
      /** `output`: the speakers to beep through (the Mac's output is switched for the check, then back). */
      checkSync: { params: { camera: string; microphone: string; display?: number; output?: string }; response: { ok: boolean; result?: SyncCheck; error?: string } };
      /** One sync-check beep at the check's volume and through its speakers, to see the microphone hear it. */
      testBeep: { params: { output?: string }; response: void };
      /** The newest frames after `after`, as soon as there are any (or after a second without): pulled, so a slow page never falls behind. */
      recordFrames: { params: { after: number }; response: RecordFrames };
      /** Show in Finder, or open in the default player. */
      showFile: { params: { path: string; open?: boolean }; response: void };
      /** Puts text on the Mac's clipboard (a clip's id, for an agent). */
      copyText: { params: { text: string }; response: void };
      /** What changed (the rest keep theirs); `snapshotFolder: null` goes back to the project's media folder. */
      setAppSettings: { params: SettingsPatch; response: void };
      /** Bytes every proxy video uses, in every project. */
      proxySpace: { params: {}; response: number };
      /** Settings > General > Delete All Proxy Videos; replies with the bytes still used. */
      deleteAllProxies: { params: {}; response: number };
      newProject: { params: { name: string; settings: CanvasValues; standalone: boolean; folder: string }; response: RunReply };
      /** File > Save As…: `name`.beproj in `folder`, opened in place of the open project. */
      saveAs: { params: { name: string; folder: string; standalone: boolean }; response: RunReply };
      /** Download a resource (the speech model): replies with its job id. */
      fetchResource: { params: { id: string }; response: RunReply & { result?: string } };
      declineResource: { params: { id: string }; response: void };
      /** Settings › Transcripts: replies with the preferences as they now are. */
      setPreference: { params: { id: string; value: string }; response: RunReply & { result?: PreferenceInfo[] } };
      /** Saves an API key in the Keychain, or removes it (null). */
      setSecret: { params: { id: string; value: string | null }; response: RunReply & { result?: PreferenceInfo[] } };
      cancelJob: { params: { id: string }; response: RunReply };
      /** Stars an item (at `index`, else at the end), un-stars it, or moves a favourite: replies with the list as it now is. */
      favoriteAdd: { params: { item: string; index?: number }; response: RunReply & { result?: string[] } };
      favoriteRemove: { params: { item: string }; response: RunReply & { result?: string[] } };
      favoriteMove: { params: { item: string; index: number }; response: RunReply & { result?: string[] } };
      /** Gives an action these keys (a key another action has is refused unless `replace`), or puts it (or all) back to the defaults: replies with the list. */
      shortcutSet: { params: { action: string; keys: Keys[]; replace?: boolean }; response: RunReply & { result?: ShortcutInfo[] } };
      shortcutReset: { params: { action?: string }; response: RunReply & { result?: ShortcutInfo[] } };
      /** One of the app's own actions (`app.export`, `app.new`…), as its menu item runs it: the command palette and rebound keys. */
      appAction: { params: { action: string }; response: void };
      previewOpen: { params: { asset: string }; response: AssetPreviewInfo | null };
      previewView: { params: { id: number; x: number; y: number; width: number; height: number; scale: number }; response: void };
      /** play (from `time`), pause, seek (to `time`), close. */
      previewControl: { params: { op: "play" | "pause" | "seek" | "close"; time?: number }; response: void };
      renameProject: { params: { name: string }; response: RunReply };
      /** The canvas's native view and its size in CSS pixels. */
      /** `surround`: the colour around the canvas (the `stage` token), 0-1 RGB. */
      canvasView: { params: { id: number; x: number; y: number; width: number; height: number; scale: number; surround: [number, number, number] }; response: { fitPercent: number } };
    };
    messages: {
      shown: Shown;
      /** What the canvas view draws over the picture (selection, handles, guides): positions in canvas pixels, sizes in points. */
      canvasMarks: { marks: CanvasMark[] };
      keyLog: { line: string };
    };
  };
  webview: {
    requests: {};
    messages: {
      opened: Opened;
      /** `rev`: the revision these patches make; a gap means one was missed. */
      patches: { patches: Patch[]; label: string; kind: "apply" | "undo" | "redo"; rev: number };
      /** The session's keys that changed. */
      session: { changes: Partial<Session> };
      status: { text: string };
      /** Whether the last change reached the disk (Beacon saves every change). */
      saved: { ok: boolean };
      /** Start editing a track's name (Rename… in its menu). */
      rename: { track: string };
      /** Start editing a Media Bin item's name (Rename… in its menu). */
      renameMedia: { asset: string };
      /** Something to read and dismiss (what a `.cmproj` import left out). */
      notice: Notice;
      /** The Media Bin preview's clock. */
      previewClock: { time: number; playing: boolean };
      /** File > New Project: ask for its name. */
      newProjectSheet: { name: string; folder: string };
      recent: RecentProject[];
      /** File > Save As…: ask for the copy's name, folder and whether it is standalone. */
      saveAsSheet: SaveAsSheet;
      /** An analysis needs a resource that isn't downloaded: ask. */
      resourceSheet: ResourceInfo;
      resourceJob: ResourceJob;
      /** A shortcut the native menu took before the page could see it, replayed as a keydown. */
      key: { code: string; meta: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean };
      /** File > Export… or Export Selection…: open the Export dialog. */
      exportSheet: ExportSheet;
      /** A narration started, or ended (null). */
      narrating: Narrating | null;
      /** File > Record… (⌘R): open the Record dialog. */
      recordSheet: RecordSheet;
      /** A display, camera or microphone was connected or removed: the open Record dialog's lists again. */
      recordDevices: Pick<RecordSheet, "permissions" | "displays" | "cameras" | "microphones" | "outputs">;
      recordPreview: RecordPreview;
      /** A take was recorded and imported: offer to name it. */
      recordedSheet: RecordedSheet;
      exportJob: ExportJob;
      /** A feature's background job (Clean with Auphonic): its stage and progress, then how it ended. */
      taskJob: TaskJob;
      importing: ImportingFiles;
      /** The favourites changed (here or by an agent): the Favorites panel's items, in order. */
      favorites: { items: string[] };
      /** The app's settings changed (in Settings, by Check Sync or an agent): an open Settings window shows them. */
      appSettings: AppSettings;
      /** An agent closed the open dialog (`ui_open` with none). */
      closeDialogs: {};
      /** A preference changed (the transcriber), here or by an agent. */
      preferences: PreferenceInfo[];
      /** Tools › Command Palette…: open it. */
      palette: {};
      /** Edit › Project Settings… (or ui_open): the project's own settings, in a dialog of their own. */
      projectSettings: {};
      /** Keyboard shortcuts changed (in Settings or by an agent). */
      shortcuts: { shortcuts: ShortcutInfo[] };
      /** Snapshot saved a frame: shown with Show in Finder. */
      snapshotSaved: { path: string };
      /** Beacon > Settings… (⌘,). */
      /** `tab`: the one to open on (Project Settings… opens "project"). */
      settingsSheet: SettingsSheet;
      /** Timeline pictures: waveforms by asset and audio stream, first-frame thumbnails (data URLs) by clip. */
      /** `preparing`: every asset whose proxy is being made, its progress 0-1 (replaces the last); `proxies`: whether assets have one (merged). */
      /** `missing`: media whose file is gone (replaces the last). */
      media: { waveforms?: Record<string, Record<number, number[]>>; thumbs?: Record<string, string>; highlight?: string; preparing?: Record<string, number>; transcribing?: Record<string, number>; judging?: Record<string, number>; judgeFailed?: Record<string, string>; analyzing?: Record<string, number>; analysisFailed?: Record<string, string>; jobFailed?: Record<string, string>; proxies?: Record<string, boolean>; missing?: string[] };
    };
  };
};
