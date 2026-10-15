import type { z } from "zod";
import type { Draft } from "immer";
import type { Asset, Clip, Easing, Project, Track } from "./schema";
import type { FeatureRegistry } from "./registry";
import type { Layer, SourceDef } from "./scene";
import type { Ticks } from "./ticks";
import type { Session, SessionCommandDef } from "./session";
import type { EditScope } from "./edit";

export interface ClipTypeDef {
  /** e.g. "screen", "callout"; stored in `Clip.type`. */
  id: string;
  description: string;
  /** Prop groups and effects apply to clip types by trait ("visual", "screen", ...). */
  traits: string[];
}

/**
 * A named group of clip properties (`Clip.props[id]`), contributed by a
 * feature to every clip type with one of `traits`.
 */
export interface PropGroupDef {
  id: string;
  description: string;
  traits: string[];
  schema: z.ZodType<Record<string, unknown>>;
  defaults: () => Record<string, unknown>;
  /** Fields animation blocks may target; a target is written `"<group>.<field>"`. */
  animatable?: string[];
  /** Tracks nested in this group's value (groups), validated like top-level tracks. */
  nested?: (value: any) => Track[];
  /** What the clip is rather than how it looks (which stream it plays): Copy Properties leaves it out. */
  identity?: boolean;
}

export interface EffectDef {
  /** Stored in `EffectInstance.type`. */
  id: string;
  description: string;
  traits: string[];
  /** Validates `EffectInstance.params`. */
  params: z.ZodType<Record<string, unknown>>;
  defaults: () => Record<string, unknown>;
}

/** WGSL fragment entry points run in order by the renderer (see beacon-render's prelude.wgsl). */
export interface RenderPassDef {
  id: string;
  wgsl: string;
  steps: string[];
}

/** One clip being evaluated at one moment. Hooks add or change `layers`. */
export interface ClipEval {
  clip: Clip;
  track: Track;
  /** Timeline time being evaluated. */
  time: Ticks;
  /** Position in the clip's media (source) time. */
  mediaTime: Ticks;
  /** Every applicable prop group: defaults, then the clip's values, then animations. */
  props: Record<string, Record<string, any>>;
  /** Everything this clip draws, in content space until the transform feature maps it to the canvas. */
  layers: Layer[];
  /** The clip's own content layer, set by its clip type's hook. */
  main?: Layer;
  /** True while evaluated as a motion-blur sample: hooks must not sample again. */
  sample: boolean;
}

export interface EvalContext {
  project: Project;
  registry: FeatureRegistry;
  /** Derived per-asset data loaded by the caller (e.g. `cursor`). */
  data<T>(assetId: string, key: string): T | undefined;
  /** Registers a source the scene draws and returns its id. */
  source(def: SourceDef): string;
  /** Re-evaluates a clip at another timeline time (motion blur, smoothing). */
  evalClip(clip: Clip, track: Track, time: Ticks, opts?: { sample?: boolean }): ClipEval;
  /** Evaluates nested tracks (groups) at an inner time, on their own canvas; `sample` as in `evalClip`. */
  evalTracks(tracks: Track[], time: Ticks, canvas?: { width: number; height: number }, opts?: { sample?: boolean }): Layer[];
  /** Size of the canvas being drawn: the project's, or a group's. */
  canvas: { width: number; height: number };
  /** Seconds per output frame. */
  frameSeconds: number;
}

/** A stretch of an asset's audio stream in the mix. Times are seconds. */
export interface AudioSegment {
  path: string;
  /** Index among the asset's audio streams. */
  stream: number;
  /** Timeline time it starts playing. */
  start: number;
  /** Timeline time it plays for. */
  duration: number;
  /** Media time at `start`. */
  mediaStart: number;
  /** Media time per timeline time. */
  speed: number;
  /** Linear gain over media time: `base`, then each ramp moves it to `to` between `start` and `end`. */
  gain: { base: number; ramps: { start: number; end: number; to: number; easing: Easing }[] };
}

export interface AudioContext {
  project: Project;
  registry: FeatureRegistry;
  /** The audible segments of nested tracks (groups), on their inner timeline. */
  tracks(tracks: Track[]): AudioSegment[];
}

export interface EvaluateHook {
  /** Runs for every active clip, in feature registration order. */
  clip?: (e: ClipEval, ctx: EvalContext) => void;
  /** What a clip on an unmuted track contributes to the audio mix. */
  audio?: (clip: Clip, ctx: AudioContext) => AudioSegment[];
}

/** Derives data from an asset, read during evaluation as `EvalContext.data(assetId, key)`. */
export interface AnalyzerDef {
  /** The data key. */
  id: string;
  description: string;
  /** Returns undefined for assets it does not apply to. */
  analyze: (asset: Asset) => unknown;
}

/**
 * Slow derived data (transcripts) produced as a background job and cached on
 * disk by asset fingerprint; read like `AnalyzerDef` data once it exists.
 */
/**
 * A file an analyzer needs that doesn't ship with Beacon (a speech model): downloaded only when the user
 * agrees (`fetchResource`), checked against its hash, into `cacheDir/<folder>/<file>`.
 */
export interface ResourceDef {
  id: string;
  /** What it is, for the dialog that asks: "Whisper large-v3-turbo speech model". */
  title: string;
  /** What it is for and what not having it means, in a sentence or two. */
  description: string;
  url: string;
  sha256: string;
  bytes: number;
  folder: string;
  file: string;
}

/**
 * An app-wide choice a feature offers (which transcriber): one of `options`, kept by core across projects
 * and launches, shown in Settings and set by agents (`setPreference`); analyzers read it.
 */
export interface PreferenceDef {
  id: string;
  /** "Transcriber". */
  title: string;
  description: string;
  options: {
    id: string;
    title: string;
    /** What choosing it means, for Settings and agents: "No download; weaker on technical words". */
    description: string;
    /** A secret it can't work without (an API key): until it is set, the option can't be chosen. */
    secret?: string;
  }[];
  default: string;
}

/** A credential an analyzer needs (an API key): kept in the macOS Keychain, never in a file; set by the user. */
export interface SecretDef {
  id: string;
  /** "OpenAI API key". */
  title: string;
}

/** The current value of each preference, by id. */
export type Preferences = (id: string) => string;

export interface JobAnalyzerDef {
  id: string;
  description: string;
  /** Bump to rebuild cached results. */
  version: number;
  /**
   * A resource it can't run without: until it is downloaded, the analyzer waits instead of starting. A
   * function when that depends on preferences (only local Whisper needs the speech model).
   */
  needs?: string | ((pref: Preferences) => string | undefined);
  /**
   * What else a result depends on (the transcriber): results are cached per variant, so changing it reads,
   * or makes, another; undefined is the plain cache entry.
   */
  variant?: (pref: Preferences) => string | undefined;
  /** Assets it applies to; the job is started for these on import, or when shown (`when`). */
  applies: (asset: Asset) => boolean;
  /** "import" (default): on import, for agents too; "preview": when the app shows the project (e.g. proxies). */
  when?: "import" | "preview";
  /**
   * `cacheDir`: where derived files (e.g. proxies) may be written; `quiet`: run tools at background
   * priority, slower but quiet (the app's Quiet setting); `resource`: where a downloaded resource is;
   * `pref`: preferences; `secret`: a secret's value, undefined when it isn't set.
   */
  analyze: (
    asset: Asset,
    progress: (fraction: number) => void,
    env: { cacheDir: string; quiet?: boolean; resource: (id: string) => string; pref: Preferences; secret: (id: string) => Promise<string | undefined> },
  ) => Promise<unknown>;
  /** Removes files a result points at (e.g. proxies) when the result is deleted. */
  discard?: (result: unknown) => void;
  /**
   * Checks a cached result before it is used: returns it, a corrected copy (its files found in
   * `cacheDir` after the cache folder moved), or undefined when its files are gone, so the job runs again.
   */
  revive?: (result: unknown, env: { cacheDir: string }) => unknown;
  /**
   * A folder under `cacheDir` holding only this analyzer's files (e.g. "proxies"): counted in the
   * space its results use, and emptied when every result is deleted (files of older versions too).
   */
  folder?: string;
}

/** A Camtasia `.tscproj` object (media, effect); its shape is Camtasia's. */
export type CamtasiaObject = Record<string, any>;

export interface CamtasiaContext {
  /** A parameter's base value (plain value or `defaultValue`), or undefined if absent. */
  value(media: CamtasiaObject, name: string): any;
  /**
   * Sets `group.field` from a Camtasia parameter: the base value goes into
   * the clip's props, keyframes become animation blocks.
   */
  param(media: CamtasiaObject, name: string, target: string, map?: (v: any) => any): void;
  /** The asset for a Camtasia source id. */
  asset(src: number): Asset;
  /** The source bin entry for a Camtasia source id (`sourceTracks`, ...). */
  source(src: number): CamtasiaObject;
  /**
   * Sets `group.field` from Camtasia points (instantaneous keyframes joined by
   * straight lines, e.g. volume): the first point is the base value, each
   * later one a linear block from the point before it.
   */
  points(media: CamtasiaObject, name: string, target: string): void;
  /** Imports nested Camtasia tracks (groups) with every feature's mappers. */
  tracks(csmlTracks: CamtasiaObject[]): Track[];
  report(message: string): void;
}

/** How a feature reads Camtasia projects (PLAN §11). */
export interface CamtasiaMapper {
  /** `_type` → this feature's clip type and any initial props, or null to skip the media. */
  clipTypes?: Record<string, (media: CamtasiaObject, ctx: CamtasiaContext) => { type: string; props?: Clip["props"] } | null>;
  /** Reads parameters into this feature's prop groups (runs for every media). */
  params?: (media: CamtasiaObject, clip: Clip, ctx: CamtasiaContext) => void;
  /** `effectName` → effect instance params, or null to drop it. */
  effects?: Record<string, (effect: CamtasiaObject, ctx: CamtasiaContext) => { type: string; params: Record<string, unknown> } | null>;
}

export interface CommandContext {
  registry: FeatureRegistry;
  newId: (prefix: string) => string;
  /** Derived per-asset data (e.g. a transcript), as in `EvalContext.data`. */
  data<T>(assetId: string, key: string): T | undefined;
}

export interface CommandDef<A = any, R = unknown> {
  /** Dotted, noun first: "clip.move". */
  id: string;
  /** Used for agent docs, MCP tool docs and the command palette. */
  description: string;
  args: z.ZodType<A>;
  /**
   * Mutates the Immer draft; patches and their inverses are derived from it.
   * Throw to reject; nothing is applied.
   */
  apply: (doc: Draft<Project>, args: A, ctx: CommandContext) => R;
}

/** A clip to create for a newly imported asset. */
export interface ImportClipSpec {
  /** What the clip is (Screen, Camera, Audio…); clips go on adjacent tracks, bottom to top in the order listed. */
  track: string;
  type: string;
  duration: Ticks;
  /** Where in its media the clip starts: lines up streams that begin at different moments (a `.brec`'s files). */
  mediaStart?: Ticks;
  props: Clip["props"];
  /** Clips with the same key are linked (cut, moved and selected together); with no keys at all, every clip is. */
  link?: string;
}

/** File types a feature can bring into a project (PLAN §6). */
export interface MediaImporterDef {
  id: string;
  /** Lower-case, with the dot. */
  extensions: string[];
  kind: Asset["kind"];
  /** The clips for one asset; core adds them linked, starting together. */
  clips: (asset: Asset, project: Project) => ImportClipSpec[];
}

export interface QueryContext {
  project: Project;
  registry: FeatureRegistry;
  /** Derived per-asset data, as in `EvalContext.data`; undefined while a job analyzer has not finished. */
  data<T>(assetId: string, key: string): T | undefined;
}

/** A read of the document or derived data (PLAN §7), exposed to agents like commands. */
export interface QueryDef<A = any> {
  /** Dotted, noun first: "transcript.get". */
  id: string;
  description: string;
  args: z.ZodType<A>;
  run: (args: A, ctx: QueryContext) => unknown;
  /** Also readable as an agent resource, run with default args. */
  resource?: { uri: string; name: string; mimeType: "text/plain" | "application/json" };
  /** The plain-text overview shown when a project is opened. */
  summary?: boolean;
}

/** A file written beside an export (captions as `.srt`), from what the exported range shows. */
export interface ExportFileDef {
  id: string;
  /** With the dot: ".srt". */
  extension: string;
  description: string;
  /** The file's contents for timeline seconds [from, to), times counted from `from`; undefined writes none. */
  write: (range: { from: number; to: number }, ctx: QueryContext) => string | undefined;
}

export interface ActionStep {
  command: string;
  args?: unknown;
}

/** What an action does, as commands: editor commands before and after, document commands between as one undo step. */
export interface ActionPlan {
  /** Names the undo step ("Ripple Delete"). */
  label: string;
  before?: ActionStep[];
  steps?: ActionStep[];
  /** Given the document commands' return values (e.g. pasted clip ids). */
  after?: (results: unknown[]) => ActionStep[];
}

export interface ActionContext {
  project: Project;
  session: Session;
  registry: FeatureRegistry;
  /**
   * What the editor is editing: the timeline's tracks, or an opened group's,
   * with its clips at main-timeline times (like the playhead, the range and
   * every command's times), so actions never convert.
   */
  scope: { tracks: Track[]; group?: Clip };
}

/**
 * An editor action (Cut, Ripple Delete, Paste, Split...): reads
 * the selection, range and playhead and becomes commands, so keys, menus and
 * agents do the same thing. Run like a command; throw when there is nothing to act on.
 */
export interface ActionDef<A = any> {
  /** Dotted: "edit.rippleDelete". */
  id: string;
  description: string;
  args: z.ZodType<A>;
  resolve: (args: A, ctx: ActionContext) => ActionPlan;
}

export interface KeyBinding {
  /** e.g. "cmd+shift+z". */
  key: string;
  command: string;
  args?: unknown;
}

export interface MenuItemDef {
  /** e.g. ["Edit", "Undo"]. */
  path: string[];
  command: string;
  args?: unknown;
}

/** `(doc) → doc` for one feature's data, from `version - 1` to `version`. Pure. */
export interface Migration {
  version: number;
  migrate: (doc: unknown) => unknown;
}

/**
 * Everything user-visible is a feature (PLAN §6). Fields for importers,
 * inspector and panels join the contract in the phases that need them.
 */
export interface Feature {
  id: string;
  /** Data version; `Project.features[id]` is migrated up to this. */
  version: number;
  clipTypes?: ClipTypeDef[];
  props?: PropGroupDef[];
  effects?: EffectDef[];
  passes?: RenderPassDef[];
  analyzers?: AnalyzerDef[];
  jobAnalyzers?: JobAnalyzerDef[];
  resources?: ResourceDef[];
  preferences?: PreferenceDef[];
  secrets?: SecretDef[];
  importers?: MediaImporterDef[];
  evaluate?: EvaluateHook;
  camtasia?: CamtasiaMapper;
  commands?: CommandDef[];
  queries?: QueryDef[];
  actions?: ActionDef[];
  exportFiles?: ExportFileDef[];
  /** Editor commands keeping the feature's own state in `session.features[<feature id>]`. */
  sessionCommands?: SessionCommandDef[];
  keymap?: KeyBinding[];
  menus?: MenuItemDef[];
  migrations?: Migration[];
  /**
   * Runs at the end of every transaction that changed something, before
   * validation, to keep the feature's invariants (magnetic tracks have no
   * gaps); its changes are part of the same undo step.
   */
  normalize?: (doc: Draft<Project>, ctx: CommandContext) => void;
}

export function defineFeature(feature: Feature): Feature {
  return feature;
}

export function defineQuery<A>(def: QueryDef<A>): QueryDef<A> {
  return def;
}

export function defineAction<A>(def: ActionDef<A>): ActionDef<A> {
  return def;
}

export function defineCommand<A, R = unknown>(def: CommandDef<A, R>): CommandDef<A, R> {
  return def;
}
