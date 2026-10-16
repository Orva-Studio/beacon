import { z } from "zod";

/** Core document shape. Bump with a migration in `migrations.ts`. */
export const SCHEMA_VERSION = 2;

export const TicksSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SignedTicksSchema = z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const RationalSchema = z.strictObject({
  num: z.int().positive(),
  den: z.int().positive(),
});

export const IdSchema = z.string().min(1);

/** Straight-alpha RGBA, 0–1; `color` tells the properties panel to show a swatch. */
export const RgbaSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]).meta({ color: true });

export const EasingSchema = z.enum(["linear", "easeInOut"]);

export const AnimationSchema = z.strictObject({
  id: IdSchema,
  /** Media time (source position), so split pieces share blocks. */
  end: SignedTicksSchema,
  duration: TicksSchema,
  easing: EasingSchema,
  /** Property path → value at the end of the block. */
  to: z.record(z.string(), z.unknown()),
});

export const EffectInstanceSchema = z.strictObject({
  id: IdSchema,
  type: z.string().min(1),
  enabled: z.boolean(),
  params: z.record(z.string(), z.unknown()),
  /** Where on the clip it applies, in media time like animations (split pieces share it); absent: the whole clip. */
  span: z.strictObject({ start: SignedTicksSchema, end: SignedTicksSchema }).optional(),
});

export const ClipSchema = z.strictObject({
  id: IdSchema,
  /** Registered by a feature, e.g. "video". */
  type: z.string().min(1),
  /** Negative only inside groups, whose window can start after a clip begins. */
  start: SignedTicksSchema,
  duration: TicksSchema.positive(),
  mediaStart: SignedTicksSchema.optional(),
  speed: RationalSchema.optional(),
  assetId: IdSchema.optional(),
  /** Clips sharing a link id (e.g. a recording's camera and audio) select, move and cut together. */
  linkId: IdSchema.optional(),
  props: z.record(z.string(), z.unknown()),
  effects: z.array(EffectInstanceSchema),
  animations: z.array(AnimationSchema),
});

export const TrackSchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  clips: z.array(ClipSchema),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  muted: z.boolean().optional(),
  /** A magnetic track: no gaps; its clips are packed from the start. */
  magnetic: z.boolean().optional(),
  /** Settings its clips share, by prop group (the captions' style on a Captions track). */
  props: z.record(z.string(), z.unknown()).optional(),
});

export const AssetSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(["recording", "video", "image", "audio"]),
  /**
   * Absolute: paths reach ffmpeg, so relative paths and URLs are refused. On disk, files inside the
   * project folder are stored relative to it (schema 2), and resolved again when it is read.
   */
  path: z.string().startsWith("/", "must be an absolute file path"),
  /** Content fingerprint for relinking moved files. */
  fingerprint: z.string(),
  /** Shown in the Media Bin and on its clips instead of the file's name (Rename). */
  name: z.string().min(1).optional(),
  /** Derived data by analyzer key (proxy, waveform, thumbnails, cursor, transcript). */
  derived: z.record(z.string(), z.unknown()),
});

/** A track's name; unnamed tracks are "Track 1", "Track 2"… by position from the bottom. */
export const trackName = (track: { name: string }, index: number) => track.name || `Track ${index + 1}`;

/** What the Media Bin and clips call an asset: its name, else the file's name without its extension. */
export const assetName = (a: { name?: string; path: string }) => a.name ?? a.path.split("/").pop()!.replace(/\.[^.]+$/, "");

export const MarkerSchema = z.strictObject({
  id: IdSchema,
  time: TicksSchema,
  name: z.string(),
});

export const SettingsSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  fps: RationalSchema,
  sampleRate: z.int().positive(),
  background: z.string(),
  /** Integrated loudness (LUFS) that clips with `audio.normalize` are levelled to. */
  loudnessTarget: z.number().optional(),
  /** Standalone: imports are copied into the project's `media` folder, so the project carries all its media. */
  standalone: z.boolean().optional(),
});

export const ProjectSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Feature id → data version, drives feature migrations. */
  features: z.record(z.string(), z.int().nonnegative()),
  settings: SettingsSchema,
  assets: z.record(IdSchema, AssetSchema),
  /** Ordered bottom → top. */
  tracks: z.array(TrackSchema),
  markers: z.array(MarkerSchema),
});

export type Easing = z.infer<typeof EasingSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type EffectInstance = z.infer<typeof EffectInstanceSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Project = z.infer<typeof ProjectSchema>;

/** Zod issues as one readable line, e.g. "at: expected number; path: must be absolute". */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
}

/** JSON Schema of what callers may pass (defaults optional), for agent tools and docs. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}
