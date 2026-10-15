import type { CanvasValues } from "./canvas-settings";
import type { Patch, Project, Session } from "@beacon/model";
import type { CanvasMark } from "./canvas";
import type { AssetPreviewInfo } from "./media-preview";
import type { SaveAsSheet } from "./project-name";
import type { ResourceInfo, ResourceJob } from "./resource";

export type { CanvasValues };
export type { CanvasMark };

/** One shortcut from `keymaps/default.json`. */
export interface Binding {
  keys: { key: string; modifiers: string[] };
  command: string;
  args?: Record<string, unknown>;
}

export interface PropGroupInfo {
  id: string;
  description: string;
}

export interface Opened {
  path: string;
  name: string;
  project: Project;
  session: Session;
  /** The document's revision: each `patches` message is the next one. */
  rev: number;
}

export interface Init {
  opened?: Opened;
  keymap: Binding[];
  propGroups: PropGroupInfo[];
  /** `schema`: JSON Schema of the params, for the properties panel's controls; `traits`: clips with any of them take it. */
  effects: { id: string; description: string; traits: string[]; schema: Record<string, unknown> }[];
  /** Clip type → traits ("video", "hold", ...). */
  clipTypes: Record<string, string[]>;
  /** Clip type → the prop group holding its own tracks (groups, stitched media). */
  nested: Record<string, string>;
  socket: string;
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
export interface DroppedFile {
  name: string;
  size: number;
  lastModified: number;
  uri?: string;
}

export { exportOptions } from "./export-options";
export { DEFAULT_EXPORT } from "./export-defaults";
export { panelHeight } from "./record-panel-size";

export interface Notice {
  title: string;
  message: string;
  lines?: string[];
}

/** App-wide settings (Settings > General), kept by the main process. */
export type SettingsTab = "general" | "recording" | "project";
/** Settings as the window opens it: `tab` the one to open on. */
/** Settings, with the devices Settings › Recording picks from (the ones last recorded chosen). */
export type SettingsSheet = AppSettings & { tab?: SettingsTab; devices?: RecordDevices; resources?: ResourceInfo[] };

/** Where the Mac's sound can play; `speakers` when the room (and a microphone) hears it. */
export interface SoundOutput {
  id: string;
  name: string;
  kind: string;
  speakers: boolean;
  default: boolean;
}

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

/** How late a camera's picture is behind a microphone's sound, typed or measured by Check Sync. */
export interface CameraSync {
  cameraLateMs: number;
  /** When it was measured (Unix ms), from how many flashes, and how far they spread (ms). */
  checked?: { at: number; flashes: number; spreadMs: number };
}

/** A sync check's result. */
export interface SyncCheck {
  cameraLateMs: number;
  flashes: number;
  spreadMs: number;
}

/** `AppSettings.cameraSync`'s key: a camera and microphone pair. */
export const syncKey = (camera: string | undefined, microphone: string | undefined) => `${camera ?? ""}|${microphone ?? ""}`;

export interface AppSettings {
  exportColorSpace: "bt709" | "srgb";
  /** Which media get proxies made on their own when a project is shown (Create Proxy Video makes any). */
  autoProxy: { recording: boolean; video: boolean };
  /** quiet: one proxy at a time at background priority, so the fans stay off; fast: two at once. */
  proxyMode: "quiet" | "fast";
  /** Where Snapshot saves its PNGs; unset, the project's own media folder. */
  snapshotFolder?: string;
  /** By camera and microphone (`syncKey`): how late the camera is; each take's camera clip moves earlier by it. */
  cameraSync?: Record<string, CameraSync>;
  /** Resources the user said Not Now to: not offered again on their own. */
  declinedResources?: string[];
}

/** The Export dialog's settings. */
export interface ExportSettings {
  format: "mp4" | "mov" | "gif" | "webm";
  codec: "h264" | "hevc" | "prores";
  /** kbit/s; null: automatic. */
  bitrate: number | null;
  keyframe: number;
  profile: "baseline" | "main" | "high";
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
  canvas: { width: number; height: number; fps: number };
}

/** What a take records; a missing source isn't recorded, a device without an id is the default one. */
export interface RecordSources {
  screen?: { display?: number; fps?: number };
  systemAudio?: boolean;
  camera?: { id?: string };
  microphone?: { id?: string };
}

/** An audio level in dBFS: the average and the recent peak. */
export interface AudioLevel {
  db: number;
  peak: number;
}

/** What the Record dialog or the recording panel shows: a camera or screen frame (base64 JPEG), or the audio levels. */
/** `live`: each source a take records, and whether it still sends; `picture.camera`: a camera still sending, but black or frozen. */
export type RecordPreview =
  | { source: "camera" | "screen"; jpeg: string }
  | { microphone?: AudioLevel; systemAudio?: AudioLevel; live?: Partial<Record<"screen" | "camera" | "microphone" | "systemAudio", boolean>>; picture?: { camera?: "black" | "frozen" | null } };

/** A take just recorded and imported: its media item, to name. */
export interface RecordedSheet {
  asset: string;
  name: string;
  duration: number;
}

/** What File > Record… opens the dialog with: what the recorder can use, and the sources last recorded. */
export interface RecordSheet {
  permissions: { screen: string; camera: string; microphone: string };
  displays: { id: number; width: number; height: number; pixelWidth?: number; pixelHeight?: number; x?: number; y?: number }[];
  cameras: { id: string; name: string; width?: number; height?: number; fps?: number }[];
  microphones: { id: string; name: string }[];
  outputs: SoundOutput[];
  sources: RecordSources;
  cameraSync?: Record<string, CameraSync>;
}

/** An export running or finished, for the window's progress panel. */
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
      /** Shows the right-click menu for a clip (a native menu). */
      /** `canvas`: opened from the canvas, which adds Project Settings… and Zoom to Fit. */
      clipMenu: { params: { clip: string; canvas?: boolean }; response: void };
      canvasMenu: { params: {}; response: void };
      /** The right-click menu for a Media Bin item. */
      binMenu: { params: { asset: string }; response: void };
      /** Import Media…'s file picker (the Media Bin's Import tile). */
      importMedia: { params: {}; response: void };
      /** Files dragged in from Finder: imported at `time` on `track` (a drop on the timeline), else after the last clip. */
      dropFiles: { params: { files: DroppedFile[]; time?: number; track?: string }; response: RunReply };
      /** A track's menu, or the track options (null). */
      trackMenu: { params: { track: string | null }; response: void };
      captureFrame: { params: {}; response: RunReply };
      frameImage: { params: {}; response: string | null };
      /** A Media Bin item's picture `time` seconds in, as a data URL, for scrubbing it under the pointer. */
      binFrame: { params: { asset: string; time: number }; response: string | null };
      /** Starts a media item's background analysis unless it is running (Remove Silences' missing transcripts). */
      analyze: { params: { key: string; asset: string }; response: void };
      /** A folder picked in the Finder dialog, starting at `start`. */
      chooseFolder: { params: { start: string }; response: string | null };
      /** Export to `folder`/`name`.`format`; refused when it exists unless `overwrite`. */
      startExport: { params: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; overwrite?: boolean }; response: RunReply };
      cancelExport: { params: { id: string }; response: RunReply };
      /** Record: Beacon hides and records a take into the project; its menu-bar item stops it. */
      startRecording: { params: { sources: RecordSources }; response: RunReply };
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
      setAppSettings: { params: AppSettings; response: void };
      /** Bytes every proxy video uses, in every project. */
      proxySpace: { params: {}; response: number };
      /** Settings > General > Delete All Proxy Videos; replies with the bytes still used. */
      deleteAllProxies: { params: {}; response: number };
      newProject: { params: { name: string; settings: CanvasValues; standalone: boolean }; response: RunReply };
      /** File > Save As…: `name`.beproj in `folder`, opened in place of the open project. */
      saveAs: { params: { name: string; folder: string; standalone: boolean }; response: RunReply };
      /** Download a resource (the speech model): replies with its job id. */
      fetchResource: { params: { id: string }; response: RunReply & { result?: string } };
      declineResource: { params: { id: string }; response: void };
      cancelJob: { params: { id: string }; response: RunReply };
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
      newProjectSheet: { name: string };
      /** File > Save As…: ask for the copy's name, folder and whether it is standalone. */
      saveAsSheet: SaveAsSheet;
      /** An analysis needs a resource that isn't downloaded: ask. */
      resourceSheet: ResourceInfo;
      resourceJob: ResourceJob;
      /** Add Clip Speed: show the clip's Clip Speed section. */
      showClipSpeed: { clip: string };
      /** A shortcut the native menu took before the page could see it, replayed as a keydown. */
      key: { code: string; meta: boolean };
      /** File > Export… or Export Selection…: open the Export dialog. */
      exportSheet: ExportSheet;
      /** File > Record… (⌘R): open the Record dialog. */
      recordSheet: RecordSheet;
      /** A display, camera or microphone was connected or removed: the open Record dialog's lists again. */
      recordDevices: Pick<RecordSheet, "permissions" | "displays" | "cameras" | "microphones" | "outputs">;
      recordPreview: RecordPreview;
      /** A take was recorded and imported: offer to name it. */
      recordedSheet: RecordedSheet;
      exportJob: ExportJob;
      /** Snapshot saved a frame: shown with Show in Finder. */
      snapshotSaved: { path: string };
      /** Beacon > Settings… (⌘,). */
      /** `tab`: the one to open on (Project Settings… opens "project"). */
      settingsSheet: SettingsSheet;
      /** Timeline pictures: waveforms by asset and audio stream, first-frame thumbnails (data URLs) by clip. */
      /** `preparing`: every asset whose proxy is being made, its progress 0-1 (replaces the last); `proxies`: whether assets have one (merged). */
      /** `missing`: media whose file is gone (replaces the last). */
      media: { waveforms?: Record<string, Record<number, number[]>>; thumbs?: Record<string, string>; highlight?: string; preparing?: Record<string, number>; proxies?: Record<string, boolean>; missing?: string[] };
    };
  };
};
