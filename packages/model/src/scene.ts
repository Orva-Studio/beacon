/**
 * What `evaluate()` produces and the renderer draws. Mirrors
 * `packages/engine/crates/beacon-render/src/scene.rs`; change both together.
 */

/** Straight-alpha RGBA, 0–1. */
export type RGBA = [number, number, number, number];

/** `X = a·x + c·y + e`, `Y = b·x + d·y + f`: layer pixels (after crop) → target pixels. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

export interface PassUse {
  pass: string;
  params: number[];
  /** A `.cube` file the pass reads as its `lut` texture. */
  lut?: string;
}

export type Content =
  | { type: "source"; source: string; time?: number }
  | { type: "solid"; color: RGBA }
  | { type: "group"; background: RGBA; layers: Layer[] };

export interface VisualLayer {
  kind: "visual";
  content: Content;
  /** Content size in pixels before crop. */
  size: [number, number];
  /** left, top, right, bottom in content pixels. */
  crop?: [number, number, number, number];
  transform: Affine;
  /** The perspective row `[g, h]` of a homography with `transform` (3D rotation): W = g·x + h·y + 1 divides X and Y. */
  perspective?: [number, number];
  /** Extra transforms averaged with `transform` (motion blur). */
  motion?: Affine[];
  /** Each `motion` transform's perspective row, when tilted. */
  motionPerspective?: [number, number][];
  /** top-left, top-right, bottom-right, bottom-left, in layer pixels. */
  radius?: [number, number, number, number];
  opacity?: number;
  passes?: PassUse[];
  /**
   * The layer's alpha from another source's brightness at the same content point (Remove Background's person matte):
   * `time` in its media, `range` the brightness drawn clear and the one drawn opaque (0 and 1 when absent).
   */
  matte?: { source: string; time?: number; range?: [number, number] };
}

export interface BackdropLayer {
  kind: "backdrop";
  size: [number, number];
  transform: Affine;
  radius?: [number, number, number, number];
  invert?: boolean;
  /** How much of the processed result shows; 1 when absent. */
  opacity?: number;
  passes: PassUse[];
}

export type Layer = VisualLayer | BackdropLayer;

export interface Scene {
  name?: string;
  /** Sources first drawn by this scene (the renderer accumulates them). */
  sources?: Record<string, SourceDef>;
  background: RGBA;
  layers: Layer[];
}

export type SourceDef =
  /** `proxy`: a short-GOP copy at `factor` of the stream's size, which the live preview may use for fast seeking. */
  | { kind: "video"; path: string; stream: number; proxy?: { path: string; factor: number } }
  | { kind: "image"; path: string }
  | { kind: "cursor"; path: string; index: number }
  | { kind: "rgba"; path: string; width: number; height: number }
  | ({ kind: "text" } & TextSpec)
  | { kind: "strokes"; lines: [number, number][][]; width: number; height: number; strokeWidth: number; color: RGBA; scale: number };

/** Text laid out by the renderer with Core Text (beacon-render's `text.rs`). */
export interface TextSpec {
  text: string;
  font: string;
  /** CSS weight, 100–900. */
  weight: number;
  italic: boolean;
  /** Points, in box units. */
  size: number;
  color: RGBA;
  tracking: number;
  lineSpacing: number;
  align: "left" | "center" | "right";
  valign: "top" | "center" | "bottom";
  /** Box size in box units. */
  width: number;
  height: number;
  /** Raster pixels per box unit. */
  scale: number;
}

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** A rectangle of one colour `size` big at `at`, its corners rounded by `radius`. */
export function solidLayer(color: RGBA, size: [number, number], radius: number, at: [number, number] = [0, 0]): VisualLayer {
  return { kind: "visual", content: { type: "solid", color }, size, transform: [1, 0, 0, 1, at[0], at[1]], radius: [radius, radius, radius, radius] };
}

/** `outer ∘ inner`: apply `inner` first. */
export function compose(outer: Affine, inner: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy = sx): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

/** Counter-clockwise on screen (y down) for positive angles. */
export function rotate(radians: number): Affine {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, -s, s, c, 0, 0];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
