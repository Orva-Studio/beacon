import { measureLoudness, probeMedia } from "@beacon/media";
import { randomId, type Asset, type Decision, type DecisionInput, type FeatureRegistry, type Memory, type Project, type ProjectStore, type SessionStore } from "@beacon/model";
import type { DerivedData, FrameRenderer, LiveView } from "@beacon/render";
import type { CoreEvent, Image, Job, ProjectHandle } from "./api";

export interface OpenProject {
  path: string;
  store: ProjectStore;
  session: SessionStore;
  /** The user's review decisions, recorded as this project's. */
  memory: Memory;
  /** The decisions each undo step recorded (by its patches), taken back while it is undone. */
  decided: WeakMap<object, { step: string; undone?: Decision[] }>;
  data: DerivedData;
  frames: FrameRenderer;
  view?: LiveView;
  /** An effect shown with other params on the canvas only (a look under the pointer), and the document laid over last. */
  preview?: Preview;
  previewDoc?: { doc: Project; shown: Project };
  /** Set while playback itself moves the playhead, so it isn't taken as a seek. */
  ticking: boolean;
  listeners: Set<(e: CoreEvent) => void>;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** The features' editor state last written to the project's `editor.json`, as JSON. */
  editorSaved?: string;
  /**
   * Set while a batch (a script, a transaction of actions) is being made as one undo step: what must wait until it is
   * kept (background jobs, review decisions for Memory), each returning a line for its result; dropped if it isn't.
   */
  batch?: { later: (() => string | void)[]; decisions: DecisionInput[] };
}

/** What core's parts (analyses, recording) are given of it: its open projects, telling their watchers, saving and jobs. */
export interface CoreParts {
  readonly registry: FeatureRegistry;
  readonly cacheDir: string;
  get(h: ProjectHandle): OpenProject;
  /** The project if it is still open. */
  find(h: ProjectHandle): OpenProject | undefined;
  projects(): Iterable<OpenProject>;
  emit(p: OpenProject, e: CoreEvent): void;
  /** Autosave after a change; a failed save is the caller's error. */
  /** `analyse` false: the caller starts the new media's analyses itself (an import's, for its result). */
  saved<T extends { patches: unknown[]; dryRun?: boolean } | undefined>(p: OpenProject, change: T, analyse?: boolean): T;
  startJob(p: OpenProject | undefined, kind: string, label: string, fn: (progress: (f: number, stage?: string) => void) => Promise<unknown>, subject?: string, asset?: string): Job;
}

/** Short enough for agents to read back; unique enough within one project. */
export const shortId = (prefix: string) => randomId(prefix, 8);

/** What an asset knows of its file once probed: its streams, and its audio's loudness. */
export async function probeAsset(file: string): Promise<Asset["derived"]> {
  const media = await probeMedia(file);
  const loudness = await measureLoudness(file, media);
  return { media, ...(Object.keys(loudness).length ? { loudness } : {}) };
}

/**
 * What the canvas previews over the document (a look under the pointer): an effect with other params, or what a
 * command would do (a caption track's look), run on a copy.
 */
export type Preview = { clip: string; effect: string; params: Record<string, unknown> } | { command: string; args: unknown };

/** Width and height from the PNG header. */
export function pngImage(png: Uint8Array): Image {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { png, width: v.getUint32(16), height: v.getUint32(20) };
}
