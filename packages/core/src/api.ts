import type { CommandResult, Patch, Session, Settings } from "@beacon/model";
import type { RecorderDevices, RecorderPreviewEvent, RecorderSources } from "@beacon/media";
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
}

export interface RecordStatus {
  recording: boolean;
  /** The take's folder, the project it imports into, and seconds recorded. */
  take?: string;
  project?: ProjectHandle;
  elapsed?: number;
}

export type { RecorderDevices, RecorderPreviewEvent, RecorderSources };

export interface ImportResult {
  assets: string[];
  clips: string[];
  /** Background analysis started for the new assets (e.g. transcripts). */
  jobs: string[];
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
  /** Media being prepared for the editor (proxies, waveforms): each asset's progress 0-1; empty when nothing is left. */
  | { kind: "preparing"; assets: Record<string, number> }
  /** An asset's background analysis was stored or deleted. */
  | { kind: "derived"; asset: string; key: string; present: boolean }
  /** Something went wrong outside any call, e.g. the save after a drag: show it, the caller has already returned. */
  | { kind: "error"; message: string }
  /** Only the keys that changed (a playback tick sends the playhead, not the clipboard); merge them into the last session. */
  | { kind: "session"; changes: Partial<Session>; changed: (keyof Session)[] };

/** Everything an agent or the app can do (PLAN §7.1). */
export interface BeaconCore {
  open(path: string): Promise<ProjectHandle>;
  create(opts: NewProjectOptions): Promise<ProjectHandle>;
  save(h: ProjectHandle): Promise<void>;
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
  /** Bytes on disk of a background analyzer's results across every project (e.g. "proxy": every proxy video). */
  analysisSize(key: string): Promise<number>;
  /** Deletes a background analyzer's results for every project; returns the bytes freed. Preview analyses run again when a project is next shown. */
  forgetAll(key: string): Promise<number>;
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
  /** The Record dialog's preview of a camera and microphone, sent to `fn` until called again; with neither, it stops. Only in the app. */
  recorderPreview(devices: Pick<RecorderSources, "camera" | "microphone">, fn?: (e: RecorderPreviewEvent) => void): Promise<void>;
  /** Starts recording a take into the project's `recordings` folder; one take at a time. Resolves once every source is delivering. */
  recordStart(h: ProjectHandle, opts?: RecordOptions): Promise<{ take: string }>;
  recordStatus(): Promise<RecordStatus>;
  /** Stops the take and imports it into the project it was started for (at the end, or as `opts` says). */
  recordStop(opts?: ImportOptions): Promise<ImportResult & { take: string; duration: number }>;
  watch(h: ProjectHandle, fn: (e: CoreEvent) => void): () => void;
}
