import type { AngleProps } from "@beacon/features";

/**
 * Camera Angle's menu pictures (the user, 2026-11-05, as Monitor's shots): one small 3D wireframe of the person at
 * their desk (a head with rings and a nose, a rounded body, arms, a desk with a keyboard, a floor), seen in
 * perspective from where each angle's camera stands. Beacon green on black, SVG, 160×90.
 */

type V = [number, number, number];
const ACCENT = "#3ee68d";
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V) => mul(a, 1 / Math.hypot(...a));

/** A camera at `eye` looking at `at`; `f` its focal length in picture units (bigger is closer in). */
interface Cam {
  eye: V;
  at: V;
  f: number;
}

/**
 * A line through 3D points, with how bright it is. `round`: the centre of the round thing it lies on (a sphere's, or
 * a point on a body's upright axis with `upright`), so the part on the far side, facing away from the camera, is
 * drawn faint, as hidden.
 */
type Stroke = { points: V[]; opacity: number; width?: number; round?: V; upright?: boolean };

const ring = (c: V, a: V, b: V, r: number, from = 0, to = Math.PI * 2, n = 36): V[] =>
  Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n).map((t) => add(c, add(mul(a, r * Math.cos(t)), mul(b, r * Math.sin(t)))));
const ellipse = (c: V, a: V, b: V, ra: number, rb: number, n = 36): V[] => Array.from({ length: n + 1 }, (_, i) => (Math.PI * 2 * i) / n).map((t) => add(c, add(mul(a, ra * Math.cos(t)), mul(b, rb * Math.sin(t)))));
const X: V = [1, 0, 0];
const Y: V = [0, 1, 0];
const Z: V = [0, 0, 1];

/** The person faces +z, toward the camera's usual place, the desk in front of them. `body`: above the arms too. */
function scene(floor: boolean, body = true): Stroke[] {
  const head: V = [0, 1.55, 0];
  const r = 0.11;
  const out: Stroke[] = [
    { points: ring(head, X, Z, r), opacity: 0.8, round: head },
    { points: ring(head, X, Y, r), opacity: 1, round: head },
    { points: ring(head, Z, Y, r), opacity: 0.8, round: head },
    // Eyes and ears make it a face; the nose says which way it looks.
    ...[-1, 1].map((s): Stroke => ({ points: ring(add(head, [s * 0.04, 0.02, r * 0.93]), X, Y, 0.012, 0, Math.PI * 2, 10), opacity: 0.9, round: head })),
    ...[-1, 1].map((s): Stroke => ({ points: ellipse(add(head, [s * r, 0, -0.005]), Z, Y, 0.022, 0.035, 14), opacity: 0.8, round: head })),
    { points: [add(head, [0, 0.01, r]), add(head, [0, -0.03, r + 0.045]), add(head, [0, -0.045, r])], opacity: 1 },
    { points: [add(head, [0, -r, 0]), [0, 1.36, 0]], opacity: 0.8 },
    // The body: rounded, a ring at the shoulders and two below, joined down the sides.
    // The body: shoulders broader than the waist, rounded over the top.
    { points: ellipse([0, 1.33, 0], X, Z, 0.23, 0.13), opacity: 1, round: [0, 1.33, 0], upright: true },
    { points: ellipse([0, 1.17, 0], X, Z, 0.2, 0.14), opacity: 0.6, round: [0, 1.17, 0], upright: true },
    { points: ellipse([0, 1.0, 0], X, Z, 0.17, 0.12), opacity: 0.9, round: [0, 1.0, 0], upright: true },
    ...[-1, 1].flatMap((s): Stroke[] => [
      { points: ring([s * 0.2, 1.32, 0], Z, Y, 0.06, 0, Math.PI), opacity: 0.7, round: [s * 0.2, 1.32, 0] },
      { points: ring([s * 0.2, 1.32, 0], X, Y, 0.06, 0, Math.PI), opacity: 0.7, round: [s * 0.2, 1.32, 0] },
    ]),
    ...[-1, 1].map((s): Stroke => ({ points: [[s * 0.05, 1.39, 0], [s * 0.17, 1.38, 0], [s * 0.23, 1.33, 0], [s * 0.21, 1.17, 0], [s * 0.17, 1.0, 0]], opacity: 0.85 })),
    // Arms down to the hands on the keyboard.
    ...[-1, 1].map((s): Stroke => ({ points: [[s * 0.21, 1.3, 0], [s * 0.27, 1.0, 0.12], [s * 0.13, 0.79, 0.42]], opacity: 0.9 })),
    ...[-1, 1].map((s): Stroke => ({ points: ellipse([s * 0.12, 0.79, 0.45], X, Z, 0.045, 0.06, 20), opacity: 1 })),
    // The desk and its keyboard.
    { points: [[-0.8, 0.75, 0.15], [0.8, 0.75, 0.15], [0.8, 0.75, 0.7], [-0.8, 0.75, 0.7], [-0.8, 0.75, 0.15]], opacity: 0.7 },
    { points: [[-0.8, 0.75, 0.7], [-0.8, 0.7, 0.7], [0.8, 0.7, 0.7], [0.8, 0.75, 0.7]], opacity: 0.45 },
    { points: [[-0.24, 0.76, 0.36], [0.24, 0.76, 0.36], [0.24, 0.76, 0.54], [-0.24, 0.76, 0.54], [-0.24, 0.76, 0.36]], opacity: 0.8 },
    ...[0.4, 0.45, 0.5].map((z): Stroke => ({ points: [[-0.21, 0.76, z], [0.21, 0.76, z]], opacity: 0.35 })),
  ];
  // The arms, hands, desk and keyboard: the last ten.
  if (!body) out.splice(0, out.length - 10);
  if (floor) for (let i = -4; i <= 4; i++) out.push({ points: [[i * 0.5, 0, -1], [i * 0.5, 0, 2.5]], opacity: 0.22, width: 0.8 }, { points: [[-2, 0, i * 0.4 + 0.6], [2, 0, i * 0.4 + 0.6]], opacity: 0.22, width: 0.8 });
  return out;
}

/** A stroke seen by `cam`, as SVG paths: its near side as given, its far side faint; points behind the camera left out. */
function paths(cam: Cam, s: Stroke): string {
  const fwd = unit(sub(cam.at, cam.eye));
  const right = unit(cross(fwd, Y));
  const up = cross(right, fwd);
  const seen = (p: V) => {
    if (!s.round) return true;
    const n = sub(p, s.round);
    return dot(s.upright ? [n[0], 0, n[2]] : n, sub(cam.eye, p)) > 0;
  };
  const runs: { near: boolean; d: string }[] = [];
  let last: { near: boolean; d: string } | undefined;
  let prev = "";
  for (const p of s.points) {
    const q = sub(p, cam.eye);
    const z = dot(q, fwd);
    if (z < 0.05) {
      last = undefined;
      continue;
    }
    const at = `${(80 + (cam.f * dot(q, right)) / z).toFixed(1)},${(45 - (cam.f * dot(q, up)) / z).toFixed(1)}`;
    const near = seen(p);
    if (!last || last.near !== near) {
      // A new run starts where the last ended, so near and far sides meet.
      last = { near, d: `M${last ? prev : at}` };
      runs.push(last);
    }
    last.d += `L${at}`;
    prev = at;
  }
  return runs.map((r) => `<path d="${r.d}" stroke="${ACCENT}" stroke-opacity="${r.near ? s.opacity : s.opacity * 0.2}" stroke-width="${s.width ?? 1.3}"/>`).join("");
}

/** Where each angle's camera stands, and what it looks at. */
const CAMS: Record<AngleProps["view"], Cam & { floor?: boolean; body?: boolean }> = {
  "three-quarter-left": { eye: [-0.62, 1.54, 0.9], at: [0, 1.4, 0], f: 150 },
  "three-quarter-right": { eye: [0.62, 1.54, 0.9], at: [0, 1.4, 0], f: 150 },
  high: { eye: [0.5, 2.45, -0.45], at: [0, 1.05, 0.25], f: 135, floor: true },
  wide: { eye: [0.9, 1.65, 2.7], at: [0, 1.0, 0.15], f: 115, floor: true },
  closeup: { eye: [0.12, 1.56, 0.85], at: [0, 1.44, 0], f: 160 },
  detail: { eye: [0.3, 1.32, 1.45], at: [0, 0.8, 0.42], f: 105, body: false },
};

const GRID = Array.from({ length: 17 }, (_, i) => `M${i * 10},0V90`).join("") + Array.from({ length: 10 }, (_, i) => `M0,${i * 10}H160`).join("");

const svg = (cam: Cam & { floor?: boolean; body?: boolean }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect width="160" height="90" fill="#070a08"/><path d="${GRID}" stroke="${ACCENT}" stroke-opacity="0.07" stroke-width="0.5"/>${[...scene(!!cam.floor, cam.body ?? true), ...(cam.body ?? true ? [outline(cam)] : [])]
    .map((s) => paths(cam, s))
    .join("")}</svg>`;

/** The head's edge as this camera sees it: the ring square to its line of sight. */
function outline(cam: Cam): Stroke {
  const head: V = [0, 1.55, 0];
  const look = unit(sub(head, cam.eye));
  const a = unit(cross(look, Y));
  return { points: ring(head, a, cross(a, look), 0.11, 0, Math.PI * 2, 48), opacity: 1 };
}

/** Each angle's picture as an image source. */
export const ANGLE_ART = Object.fromEntries(Object.entries(CAMS).map(([id, cam]) => [id, `data:image/svg+xml;utf8,${encodeURIComponent(svg(cam))}`])) as Record<AngleProps["view"], string>;
