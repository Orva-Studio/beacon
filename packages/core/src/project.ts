import { measureLoudness, probeMedia } from "@beacon/media";
import { randomId, type Asset, type FeatureRegistry, type Memory, type Project, type ProjectStore, type SessionStore } from "@beacon/model";
import type { DerivedData, FrameRenderer, LiveView } from "@beacon/render";
import type { CoreEvent, Job, ProjectHandle } from "./api";

export interface OpenProject {
  path: string;
  store: ProjectStore;
  session: SessionStore;
  /** The user's review decisions, recorded as this project's. */
  memory: Memory;
  data: DerivedData;
  frames: FrameRenderer;
  view?: LiveView;
  /** An effect shown with other params on the canvas only (a look under the pointer), and the document laid over last. */
  preview?: { clip: string; effect: string; params: Record<string, unknown> };
  previewDoc?: { doc: Project; shown: Project };
  /** Set while playback itself moves the playhead, so it isn't taken as a seek. */
  ticking: boolean;
  listeners: Set<(e: CoreEvent) => void>;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** The features' editor state last written to the project's `editor.json`, as JSON. */
  editorSaved?: string;
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
