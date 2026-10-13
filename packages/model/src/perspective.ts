import type { Affine } from "./scene";

/** Row-major 3×3 homography on (x, y, 1). */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

/**
 * The eye's distance from the canvas, in canvas pixels: the camera sits on the canvas's axis at
 * z = 3000 looking at its centre, with the field of view that shows the canvas's height there,
 * so z = 0 is drawn at 1:1. Measured from a Camtasia export (2026-10-13): an 810×402 rectangle tilted
 * 20° about Y, then about X, foreshortens as an eye at 2999 and 3002 px would, and lands within 1 px of
 * where this camera draws it; +Y brings the left edge nearer, +X the top.
 */
export const CAMERA_DISTANCE = 3000;

export function fromAffine([a, b, c, d, e, f]: Affine): Matrix3 {
  return [a, c, e, b, d, f, 0, 0, 1];
}

/** `outer ∘ inner`: apply `inner` first. */
export function multiply(o: Matrix3, i: Matrix3): Matrix3 {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Matrix3;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) r[row * 3 + col] = o[row * 3]! * i[col]! + o[row * 3 + 1]! * i[3 + col]! + o[row * 3 + 2]! * i[6 + col]!;
  return r;
}

/** The scene's form: an affine `transform` and, when not flat, the perspective row `[g, h]` (W = g·x + h·y + 1). */
export function split(m: Matrix3): { transform: Affine; perspective?: [number, number] } {
  const k = m[8];
  const transform: Affine = [m[0] / k, m[3] / k, m[1] / k, m[4] / k, m[2] / k, m[5] / k];
  const [g, h] = [m[6] / k, m[7] / k];
  return Math.abs(g) > 1e-12 || Math.abs(h) > 1e-12 ? { transform, perspective: [g, h] } : { transform };
}

export function project(m: Matrix3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export interface TransformValues {
  /** Canvas pixels from the centre, y up. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Radians: about the view axis (counter-clockwise), then the 3D tilts about the clip's horizontal (X) and vertical (Y) axes. */
  rotation: number;
  rotationX?: number;
  rotationY?: number;
}

/**
 * Content pixels (top-left origin) → canvas pixels: scaled about its centre,
 * turned about X, then Y, then Z (right-handed, y up, z towards the viewer), moved, then seen in perspective.
 * Flat (no X/Y turn) it is the affine `translate · rotate · scale` the 2D transform always was.
 */
export function placement(canvas: { width: number; height: number }, size: [number, number], t: TransformValues): Matrix3 {
  const [cx, sx] = [Math.cos(t.rotationX ?? 0), Math.sin(t.rotationX ?? 0)];
  const [cy, sy] = [Math.cos(t.rotationY ?? 0), Math.sin(t.rotationY ?? 0)];
  const [cz, sz] = [Math.cos(t.rotation), Math.sin(t.rotation)];
  // R = Rz · Ry · Rx, columns 0 and 1 (the plane's x and y axes; its z is 0).
  const r0 = [cz * cy, sz * cy, -sy];
  const r1 = [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx];
  // P = R · (scaleX·(u − w/2), −scaleY·(v − h/2), 0) + (x, y, 0): an affine map of (u, v).
  const [hw, hh] = [size[0] / 2, size[1] / 2];
  const P = [0, 1, 2].map((k) => [r0[k]! * t.scaleX, -r1[k]! * t.scaleY, -r0[k]! * t.scaleX * hw + r1[k]! * t.scaleY * hh + (k === 0 ? t.x : k === 1 ? t.y : 0)]);
  // Seen from the camera: W = 1 − z/D; canvas x·W = (width/2)·W + X, y·W = (height/2)·W − Y.
  const w = P[2]!.map((v, i) => (i === 2 ? 1 : 0) - v / CAMERA_DISTANCE);
  const row = (k: number, sign: number, half: number) => w.map((wv, i) => half * wv + sign * P[k]![i]!);
  return [...row(0, 1, canvas.width / 2), ...row(1, -1, canvas.height / 2), ...w] as Matrix3;
}
