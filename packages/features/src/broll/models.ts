/**
 * The text-to-video models B-roll offers through Replicate (the user, 2026-10-21 and 2026-10-23). Shapes and lengths
 * are what the models' pages said on 2026-10-23; `limits` reads the live schema before a generation, which wins.
 * Prices are third-party comparisons (PLAN), shown as estimates: Replicate's API doesn't give them, and FLUX 3's and
 * Seedance 2.5's weren't found for Replicate, so theirs are the high end of what was reported.
 */
export interface VideoModel {
  id: string;
  title: string;
  /** `owner/name` on Replicate. */
  slug: string;
  aspects: string[];
  /** Seconds it can make, in order. */
  durations: number[];
  /** The input for each resolution it makes; 1080p falls back to 720p where it has none. */
  resolutions: Partial<Record<Resolution, Record<string, unknown>>>;
  /** Dollars per second of footage, by resolution. */
  perSecond: Partial<Record<Resolution, number>>;
}

export type Resolution = "720p" | "1080p";

const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: "veo-3.1-fast",
    title: "Veo 3.1 Fast",
    slug: "google/veo-3.1-fast",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    resolutions: { "720p": { resolution: "720p" }, "1080p": { resolution: "1080p" } },
    perSecond: { "720p": 0.15, "1080p": 0.15 },
  },
  {
    id: "seedance-2.0",
    title: "Seedance 2.0",
    slug: "bytedance/seedance-2.0",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durations: span(4, 12),
    resolutions: { "720p": { resolution: "720p" } },
    perSecond: { "720p": 0.18 },
  },
  {
    id: "flux-3",
    title: "FLUX 3",
    slug: "black-forest-labs/flux-3",
    aspects: ["21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durations: span(5, 20),
    resolutions: { "720p": { resolution: "720p", draft: false }, "1080p": { resolution: "1080p", draft: false } },
    perSecond: { "720p": 0.1, "1080p": 0.15 },
  },
  {
    id: "seedance-2.5",
    title: "Seedance 2.5",
    slug: "bytedance/seedance-2.5",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durations: span(4, 30),
    resolutions: { "720p": { resolution: "720p" }, "1080p": { resolution: "1080p" } },
    perSecond: { "720p": 0.15, "1080p": 0.22 },
  },
  {
    id: "kling-v3",
    title: "Kling 3.0 Pro",
    slug: "kwaivgi/kling-v3-video",
    aspects: ["16:9", "9:16", "1:1"],
    durations: span(3, 15),
    resolutions: { "720p": { mode: "standard" }, "1080p": { mode: "pro" } },
    perSecond: { "720p": 0.15, "1080p": 0.22 },
  },
];

export const DEFAULT_MODEL = "veo-3.1-fast";

export const videoModel = (id: string) => VIDEO_MODELS.find((m) => m.id === id) ?? VIDEO_MODELS[0]!;

/** The resolution asked for, or the best it has below it. */
export const resolutionOf = (m: VideoModel, asked: string): Resolution => (asked === "1080p" && m.resolutions["1080p"] ? "1080p" : "720p");

export const ratio = (aspect: string) => {
  const [w, h] = aspect.split(":").map(Number) as [number, number];
  return w / h;
};

/**
 * The model's shape nearest the region's, by how far apart their ratios are on a log scale (2:1 is as far from 1:1
 * as 1:2); undefined for a model that picks its own (Seedance 2.5's "adaptive"), whose footage is cropped to fit.
 */
export const nearestAspect = (m: Pick<VideoModel, "aspects">, width: number, height: number) =>
  m.aspects.length ? m.aspects.reduce((best, a) => (Math.abs(Math.log(ratio(a) / (width / height))) < Math.abs(Math.log(ratio(best) / (width / height))) ? a : best)) : undefined;

/** The shortest length it makes that covers `seconds`, else its longest. */
export const lengthFor = (m: Pick<VideoModel, "durations">, seconds: number) => m.durations.find((d) => d >= seconds - 1e-3) ?? m.durations.at(-1)!;

export const shotCost = (m: VideoModel, resolution: Resolution, seconds: number) => (m.perSecond[resolution] ?? m.perSecond["720p"]!) * lengthFor(m, seconds);
