import type { CommandResult, Patch, Session, Settings } from "@beacon/model";
import type { RecorderDevices, RecorderLevel, RecorderPreviewEvent, RecorderSources, SyncResult } from "@beacon/media";
import type { VideoEncoding } from "@beacon/render";

export type { CommandResult, Session };

/** An open project; the path of its `.beproj` folder. */
export type ProjectHandle = string;

export interface NewProjectOptions {
  /** The `.beproj` folder to create; must not exist yet. */
  path: string;
  settings?: Partial<Settings>;
  /** Start from a Camtasia project (read only; never written). */
  cmproj?: string;
  /** A standalone project: media is copied into its `media` folder as it is imported (a Camtasia project's too). */
  standalone?: boolean;
}

export interface FrameOptions {
  /** Output width in pixels; height follows the canvas aspect. Defaults to the canvas width. */
  width?: number;
}

/** What the Media Bin's preview shows: images have no transport. */
export interface AssetPreview {
  kind: "video" | "audio" | "image";
  /** Seconds; 0 for images. */
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface Image {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface SheetOptions {
  from: number;
  to: number;
  /** Frames on the sheet, evenly spaced over [from, to]; at most 100. */
  count: number;
  columns?: number;
  /** Width of each cell in pixels. */
  width?: number;
}

/** Export options: codec, data rates, keyframes, profile, frame rate, size, audio. */
export interface ExportOptions extends VideoEncoding {
  /** A `.mp4`, `.mov`, `.gif` or `.webm` path, or a directory ending in `/` for PNG frames. */
  output: string;
  /** Replace an existing file (or a non-empty frames folder). */
  overwrite?: boolean;
  /** Timeline seconds; defaults to the whole project. */
  from?: number;
  to?: number;
}

export interface ImportOptions {
  /** Timeline seconds to place the media at; defaults to the end of the timeline. */
  at?: number;
  /** A timeline track to put them on, as a drop does (the rest of a recording goes on the tracks above); refused over other media. */
  track?: string;
}

export interface RecordOptions {
  /** What to record; by default the main display, the default microphone and the system audio. */
  sources?: RecorderSources;
  /** The take's name (its `.brec` folder in the project's `recordings`); by default the date and time. */
  name?: string;
  /** Gets the take's camera frames and audio levels while it records, for the app's recording panel. */
  monitor?: (e: RecorderPreviewEvent) => void;
  /**
   * Voice narration: the timeline plays in the app from the playhead (or through the in/out range) while only the
   * microphone records; stopping, or the end of the range, places the take on a new track under what was playing.
   * With nothing after the playhead to play, it records there until stopped.
   * `hear`: play the timeline's sound too (off by default, so speakers don't bleed into the take).
   */
  narrate?: { hear?: boolean };
}

export interface RecordStopOptions extends ImportOptions {
  /** Throw the take away: nothing is imported and its folder is deleted. */
  discard?: boolean;
}

/** What stopping a take imported (nothing, when discarded); a narration's clip is on a track of its own. */
export type RecordResult = ImportResult & { take: string; duration: number; discarded?: boolean };

export interface RecordStatus {
  recording: boolean;
  /** The take's folder, the project it imports into, and seconds recorded. */
  take?: string;
  project?: ProjectHandle;
  elapsed?: number;
  /** Whether the take is a narration, and the timeline span it plays (seconds). */
  narration?: { from: number; until: number; hear: boolean };
  /** The last narration that ended by itself (its range or the timeline ran out, or playback was paused): what it imported. */
  last?: RecordResult;
}

export type { RecorderDevices, RecorderLevel, RecorderPreviewEvent, RecorderSources, SyncResult };

export interface ImportResult {
  assets: string[];
  clips: string[];
  /** Background analysis started for the new assets (e.g. transcripts). */
  jobs: string[];
  /** Resources an analysis waits for (`resources`), not downloaded yet: ask the user before `fetchResource`. */
  needs?: string[];
}

/** A file an analysis needs that isn't shipped with Beacon (the speech model for transcripts). */
export interface ResourceInfo {
  id: string;
  title: string;
  description: string;
  /** Download size. */
  bytes: number;
  present: boolean;
  /** Its download, while one runs. */
  job?: string;
}

/** An app-wide choice (the transcriber), as Settings and agents see it. */
export interface PreferenceInfo {
  id: string;
  title: string;
  description: string;
  value: string;
  options: {
    id: string;
    title: string;
    description: string;
    /** A secret it needs (an API key) and whether it is set: the user sets it in Settings, never an agent. */
    secret?: { id: string; title: string; set: boolean };
  }[];
}

export type JobState = "running" | "done" | "failed";

export interface JobInfo {
  id: string;
  kind: string;
  label: string;
  state: JobState;
  /** 0–1. */
  progress: number;
  result?: unknown;
  error?: string;
  /** Seconds since the job started. */
  elapsed: number;
  /** The asset an analysis job is for. */
  asset?: string;
}

export interface Job {
  id: string;
  done: Promise<unknown>;
}

export interface CommandInfo {
  id: string;
  description: string;
  /** JSON Schema of the args. */
  args: Record<string, unknown>;
  feature: string;
}

export interface QueryInfo extends CommandInfo {
  resource?: { uri: string; name: string; mimeType: string };
  summary?: boolean;
}

/** What clips can hold: for agents' reference and generated UI. */
export interface SchemaInfo {
  /** `nested`: the prop group holding the clip type's own tracks (groups, stitched media), if any. */
  clipTypes: { id: string; description: string; traits: string[]; props: string[]; effects: string[]; nested?: string }[];
  props: { id: string; description: string; animatable: string[]; schema: Record<string, unknown> }[];
  effects: { id: string; description: string; traits: string[]; schema: Record<string, unknown> }[];
}

export interface RunOptions {
  dryRun?: boolean;
  label?: string;
  /** Changes run with the same key in a row are one undo step: the steps of a drag. */
  coalesce?: string;
}

/** One command of a transaction. */
export interface TransactionStep {
  command: string;
  args?: unknown;
}

/** What the editor window shows: a screenshot (when the app is open) and its state. */
export interface Snapshot {
  image?: Image;
  session: Session;
  /** Plain-text description: playhead, selection, visible range, panels. */
  description: string;
}

export type CoreEvent =
  | { kind: "apply" | "undo" | "redo"; label: string; patches: Patch[] }
  | { kind: "job"; job: JobInfo }
  | { kind: "saved"; path: string }
  /** An analysis of new media waits for a resource that isn't downloaded: ask the user. */
  | { kind: "needs"; resource: ResourceInfo }
  /** The favourites changed (app-wide): the Favorites panel's items, in order. */
  | { kind: "favorites"; items: string[] }
  /** A preference changed (the transcriber); analyses it decides start again where they have no result for it. */
  | { kind: "preference"; id: string; value: string }
  /** Media being prepared for the editor (proxies, waveforms): each asset's progress 0-1; empty when nothing is left. */
  | { kind: "preparing"; assets: Record<string, number> }
  /** An asset's background analysis was stored or deleted. */
  | { kind: "derived"; asset: string; key: string; present: boolean }
  /** A narration ended (stopped, or it reached the end of its range) and was placed, or was discarded. */
  | { kind: "narrated"; result: RecordResult }
  /** Something went wrong outside any call, e.g. the save after a drag: show it, the caller has already returned. */
  | { kind: "error"; message: string }
  /** Only the keys that changed (a playback tick sends the playhead, not the clipboard); merge them into the last session. */
  | { kind: "session"; changes: Partial<Session>; changed: (keyof Session)[] };

/** Everything an agent or the app can do (PLAN §7.1). */
export interface BeaconCore {
  open(path: string): Promise<ProjectHandle>;
  create(opts: NewProjectOptions): Promise<ProjectHandle>;
  save(h: ProjectHandle): Promise<void>;
  /**
   * Save As: a copy of the project as it is now at `path` (a new `.beproj` folder), with the recordings and media
   * kept inside it; standalone (by default, as the project is), media from outside is copied into its `media`
   * folder too. The project stays open as it was; returns the copy's path, to `open`.
   */
  saveAs(h: ProjectHandle, path: string, opts?: { standalone?: boolean }): Promise<string>;
  /** Show in Finder: the project's folder, selected in a Finder window. */
  reveal(h: ProjectHandle): Promise<void>;
  close(h: ProjectHandle): Promise<void>;
  run(h: ProjectHandle, command: string, args: unknown, opts?: RunOptions): Promise<CommandResult>;
  transaction(h: ProjectHandle, label: string, steps: TransactionStep[], opts?: { dryRun?: boolean }): Promise<CommandResult>;
  undo(h: ProjectHandle): Promise<string | undefined>;
  redo(h: ProjectHandle): Promise<string | undefined>;
  history(h: ProjectHandle): Promise<{ undo: string[]; redo: string[] }>;
  query(h: ProjectHandle, name: string, args?: unknown): Promise<unknown>;
  /** The canvas at a timeline time in seconds. */
  frame(h: ProjectHandle, time: number, opts?: FrameOptions): Promise<Image>;
  /**
   * Snapshot: the canvas at a timeline time (default: the
   * playhead) saved as a PNG in the project's `media` folder (or an existing
   * `folder`, checked as other writes are) and added to the Media Bin, as one undo step.
   */
  captureFrame(h: ProjectHandle, time?: number, opts?: { folder?: string }): Promise<{ asset: string; path: string }>;
  /** A contact sheet of frames across a range; `times` are the frames shown, in timeline seconds. */
  sheet(h: ProjectHandle, opts: SheetOptions): Promise<Image & { times: number[] }>;
  export(h: ProjectHandle, opts: ExportOptions): Promise<Job>;
  import(h: ProjectHandle, files: string[], opts?: ImportOptions): Promise<ImportResult>;
  /** Runs a background analyzer (e.g. "transcript") for an asset, or returns its running job. */
  analyze(h: ProjectHandle, key: string, assetId: string): Promise<Job>;
  /** Deletes an asset's background analysis and the files it made (e.g. a proxy); false if there was none. Preview analyses run again when the project is next shown. */
  forget(h: ProjectHandle, key: string, assetId: string): Promise<boolean>;
  /** Media whose file is no longer where the project says (moved, renamed or deleted): their asset ids. */
  missing(h: ProjectHandle): Promise<string[]>;
  /** Points media at a moved file (Locate…), refused unless it is the same kind of media with the same streams and length; one undo step. */
  relink(h: ProjectHandle, assetId: string, path: string): Promise<void>;
  /** Replace Media…: an imported video, image or audio file swapped for another of the same kind; its clips keep their places, shortened where it ends sooner. Not recordings. One undo step; the new file's analyses start as an import's do. */
  replace(h: ProjectHandle, assetId: string, path: string): Promise<{ jobs: string[]; needs?: string[] }>;
  /** Bytes on disk of a background analyzer's results across every project (e.g. "proxy": every proxy video). */
  analysisSize(key: string): Promise<number>;
  /** Deletes a background analyzer's results for every project; returns the bytes freed. Preview analyses run again when a project is next shown. */
  forgetAll(key: string): Promise<number>;
  /** Resources analyses need (the speech model), and whether each is downloaded. */
  resources(): Promise<ResourceInfo[]>;
  /** App-wide choices (the transcriber), kept across projects and launches. */
  preferences(): Promise<PreferenceInfo[]>;
  /**
   * Changes one for every project. Transcripts are kept per transcriber: open projects' media without one by
   * the new choice gets one (or waits for a resource, as an import does). Refused for an option whose secret
   * (an API key) isn't set.
   */
  setPreference(id: string, value: string): Promise<void>;
  /**
   * The Favorites panel's items, in order, app-wide: `annotation:<preset>` (text, rectangle…), `effect:<id>`
   * (drop-shadow…) or `audio:fade-in` / `audio:fade-out`. New users start with a few.
   */
  favorites(): Promise<string[]>;
  /** Stars an item (at `index`, else at the end); one already there stays where it is. Returns the list. */
  favoriteAdd(item: string, index?: number): Promise<string[]>;
  /** Un-stars an item. Returns the list. */
  favoriteRemove(item: string): Promise<string[]>;
  /** Moves a favourite to `index` (0 first). Returns the list. */
  favoriteMove(item: string, index: number): Promise<string[]>;
  /**
   * Downloads a resource as a job (only once the user has agreed: it can be large); analyses waiting for it
   * start when it is done. Returns the running download if there is one.
   */
  fetchResource(id: string): Promise<Job>;
  job(id: string): Promise<JobInfo>;
  jobs(): Promise<JobInfo[]>;
  /** Stops a running job (an export, an analysis): it fails as "cancelled". */
  cancelJob(id: string): Promise<void>;
  commands(): CommandInfo[];
  queries(): QueryInfo[];
  schema(): SchemaInfo;
  /** Editor state: playhead, selection, range, timeline view, panels. */
  session(h: ProjectHandle): Promise<Session>;
  /** The app window and its state; without the app, the state and no image. */
  snapshot(h: ProjectHandle): Promise<Snapshot>;
  /** The registered summary query's text: what an agent sees on opening a project. */
  summary(h: ProjectHandle): Promise<string>;
  /**
   * Throws unless `path` is safe to write: not one of the project's media
   * files, not inside a `.cmproj` or `.beproj`, and not existing unless `overwrite`.
   */
  checkOutput(h: ProjectHandle, path: string, opts?: { overwrite?: boolean }): Promise<void>;
  /** Permissions, displays, cameras and microphones the recorder can use. */
  recorderDevices(): Promise<RecorderDevices>;
  /** Asks macOS for the camera or microphone permission; the status after. */
  recorderAccess(kind: "camera" | "microphone"): Promise<string>;
  /** The Record dialog's preview of the sources, sent to `fn` until called again; with none, it stops. Only in the app. */
  recorderPreview(sources: RecorderSources, fn?: (e: RecorderPreviewEvent) => void): Promise<void>;
  /** Makes `output` (from `recorderDevices`) the Mac's sound output; the one it replaced. */
  recorderSetOutput(output: string): Promise<string | undefined>;
  /** Starts recording a take into the project's `recordings` folder; one take at a time. Resolves once every source is delivering. */
  recordStart(h: ProjectHandle, opts?: RecordOptions): Promise<{ take: string }>;
  recordStatus(): Promise<RecordStatus>;
  /**
   * A sync check (docs/formats/brec.md): records the screen, system audio, camera and microphone into the cache
   * while `show` flashes the screen white and beeps, then measures how late the camera is behind the microphone.
   * Only in the app, which does the flashing.
   */
  recordSyncCheck(sources: RecorderSources, show: () => Promise<void>): Promise<SyncResult>;
  /**
   * Stops the take and imports it into the project it was started for (at the end, or as `opts` says); a narration
   * goes on a new track where it began, lined up with what was heard. One undo step.
   */
  recordStop(opts?: RecordStopOptions): Promise<RecordResult>;
  watch(h: ProjectHandle, fn: (e: CoreEvent) => void): () => void;
}
