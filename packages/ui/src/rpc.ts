import type { CanvasValues } from "./canvas-settings";
import type { Patch, Project, Session } from "@beacon/model";
import type { CanvasMark } from "./canvas";
import type { AssetPreviewInfo } from "./media-preview";

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

export interface Notice {
  title: string;
  message: string;
  lines?: string[];
}

/** App-wide settings (Settings > General), kept by the main process. */
export type SettingsTab = "general" | "project";
/** Settings as the window opens it: `tab` the one to open on. */
export type SettingsSheet = AppSettings & { tab?: SettingsTab };

export interface AppSettings {
  exportColorSpace: "bt709" | "srgb";
  /** Which media get proxies made on their own when a project is shown (Create Proxy Video makes any). */
  autoProxy: { recording: boolean; video: boolean };
  /** quiet: one proxy at a time at background priority, so the fans stay off; fast: two at once. */
  proxyMode: "quiet" | "fast";
  /** Where Snapshot saves its PNGs; unset, the project's own media folder. */
  snapshotFolder?: string;
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

/** The Record dialog's preview: a camera frame (base64 JPEG), or the microphone's level in dBFS. */
export type RecordPreview = { jpeg: string } | { db: number; peak: number };

/** What File > Record… opens the dialog with: what the recorder can use, and the sources last recorded. */
export interface RecordSheet {
  permissions: { screen: string; camera: string; microphone: string };
  displays: { id: number; width: number; height: number }[];
  cameras: { id: string; name: string }[];
  microphones: { id: string; name: string }[];
  sources: RecordSources;
}

/** An export running or finished, for the window's progress panel. */
export interface ExportJob {
  id: string;
  output: string;
  state: "running" | "done" | "failed";
  progress: number;
  error?: string;
}

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
      /** A folder picked in the Finder dialog, starting at `start`. */
      chooseFolder: { params: { start: string }; response: string | null };
      /** Export to `folder`/`name`.`format`; refused when it exists unless `overwrite`. */
      startExport: { params: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; overwrite?: boolean }; response: RunReply };
      cancelExport: { params: { id: string }; response: RunReply };
      /** Record: Beacon hides and records a take into the project; its menu-bar item stops it. */
      startRecording: { params: { sources: RecordSources }; response: RunReply };
      /** Shows the camera and microphone in the Record dialog (`recordPreview` messages); with neither, stops. */
      recordPreview: { params: Pick<RecordSources, "camera" | "microphone">; response: RunReply };
      /** Show in Finder, or open in the default player. */
      showFile: { params: { path: string; open?: boolean }; response: void };
      setAppSettings: { params: AppSettings; response: void };
      /** Bytes every proxy video uses, in every project. */
      proxySpace: { params: {}; response: number };
      /** Settings > General > Delete All Proxy Videos; replies with the bytes still used. */
      deleteAllProxies: { params: {}; response: number };
      newProject: { params: { name: string; settings: CanvasValues }; response: RunReply };
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
      /** Add Clip Speed: show the clip's Clip Speed section. */
      showClipSpeed: { clip: string };
      /** A shortcut the native menu took before the page could see it, replayed as a keydown. */
      key: { code: string; meta: boolean };
      /** File > Export… or Export Selection…: open the Export dialog. */
      exportSheet: ExportSheet;
      /** File > Record… (⌘R): open the Record dialog. */
      recordSheet: RecordSheet;
      recordPreview: RecordPreview;
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
