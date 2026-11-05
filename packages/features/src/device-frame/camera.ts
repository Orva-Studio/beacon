import type { Matrix3 } from "@beacon/model";

/** A camera filming a monitor whose screen is the canvas (`width` × `height` pixels, y down), in canvas pixels. */
export interface Camera {
  /** Radians: + swings the camera to the screen's right, so its left edge comes nearer. */
  yaw: number;
  /** Radians: + raises the camera, looking down on the screen. */
  pitch: number;
  /** The screen's width in the frame, as a share of the frame's at the point aimed at (2: half the screen shows). */
  size: number;
  /** The point of the screen aimed at, in canvas pixels. */
  target: [number, number];
}

/** Vertical field of view of a 50 mm lens on full frame, about 27°: what the references look shot on. */
const FOV = (27 * Math.PI) / 180;

export const focalLength = (height: number) => height / 2 / Math.tan(FOV / 2);

/**
 * Screen point (canvas pixels) → the camera's coordinates `[x, y, z]`, z the depth ahead of it: rows of a 3×3 matrix
 * applied to `[x, y, 1]`. The camera orbits the target at the distance that shows the screen `size` wide.
 */
export function view(c: Camera, width: number, height: number): Matrix3 {
  const f = focalLength(height);
  const d = f / c.size;
  const [cy, sy] = [Math.cos(c.yaw), Math.sin(c.yaw)];
  const [cp, sp] = [Math.cos(c.pitch), Math.sin(c.pitch)];
  // R = Rx(pitch) · Ry(yaw); its first two columns are where the screen's x and y axes point.
  const r0 = [cy, sp * sy, -cp * sy];
  const r1 = [0, cp, sp];
  const [tx, ty] = c.target;
  return [r0[0]!, r1[0]!, -tx * r0[0]! - ty * r1[0]!, r0[1]!, r1[1]!, -tx * r0[1]! - ty * r1[1]!, r0[2]!, r1[2]!, -tx * r0[2]! - ty * r1[2]! + d];
}

/** Screen point → frame pixel: the view projected through a lens centred on the frame. */
export function homography(m: Matrix3, width: number, height: number): Matrix3 {
  const f = focalLength(height);
  const [hw, hh] = [width / 2, height / 2];
  return [f * m[0] + hw * m[6], f * m[1] + hw * m[7], f * m[2] + hw * m[8], f * m[3] + hh * m[6], f * m[4] + hh * m[7], f * m[5] + hh * m[8], m[6], m[7], m[8]];
}

export const depthAt = (m: Matrix3, x: number, y: number) => m[6] * x + m[7] * y + m[8];

export function invert(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** A slow handheld wobble: three incommensurate sines per axis, -1 to 1, the same for a clip each time it is drawn. */
export function wobble(seconds: number, seed: number): [number, number, number] {
  const axis = (k: number) => {
    const s = seed * (k + 1) * 12.9898;
    return (Math.sin(2 * Math.PI * 0.21 * seconds + s) + 0.6 * Math.sin(2 * Math.PI * 0.57 * seconds + s * 1.7) + 0.3 * Math.sin(2 * Math.PI * 1.31 * seconds + s * 2.3)) / 1.9;
  };
  return [axis(0), axis(1), axis(2)];
}
