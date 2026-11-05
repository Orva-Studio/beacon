import { project, type Matrix3 } from "@beacon/model";
import { homography, invert, view, type Camera } from "./camera";
import { CORNERS, shotCamera, SHOTS, type Corner, type Shot } from "./shots";

/**
 * Blueprints of the shots for their menus (the user, 2026-11-04): Beacon green on black, the whole monitor seen from
 * the shot's angle with the part the shot frames lit, worked out from the camera the effect uses. SVG, 160×90.
 */

const ACCENT = "#3ee68d";
const W = 1600;
const H = 900;
const S = 0.1;
const BEZEL = W * 0.03;

const pt = (m: Matrix3, x: number, y: number) => {
  const [u, v] = project(m, x, y);
  return `${(u * S).toFixed(1)},${(v * S).toFixed(1)}`;
};
const poly = (m: Matrix3, pts: [number, number][]) => `M${pts.map(([x, y]) => pt(m, x, y)).join("L")}Z`;
const quad = (m: Matrix3, x0: number, y0: number, x1: number, y1: number) => poly(m, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** Lines of "code" on the screen, of ragged lengths, so its tilt reads at a glance. */
function codeLines(m: Matrix3): string {
  const lengths = [0.55, 0.32, 0.7, 0.44, 0.62, 0.25, 0.5, 0.38, 0.66, 0.3, 0.58, 0.42];
  return lengths
    .map((l, i) => {
      const y = H * (0.08 + i * 0.075);
      const x0 = W * (0.06 + (i % 3) * 0.03);
      return `M${pt(m, x0, y)}L${pt(m, x0 + W * l, y)}`;
    })
    .join("");
}

const GRID = Array.from({ length: 17 }, (_, i) => `M${i * 10},0V90`).join("") + Array.from({ length: 10 }, (_, i) => `M0,${i * 10}H160`).join("");

/** What a camera frames, as a shape on the screen's plane: the frame's corners taken back through it. */
function framed(cam: Camera): [number, number][] {
  const back = invert(homography(view(cam, W, H), W, H));
  return ([[0, 0], [W, 0], [W, H], [0, H]] as [number, number][]).map(([x, y]) => project(back, x, y));
}

/**
 * The monitor seen from `cam`'s angle, whole, with what `shots` frame drawn on it: the first lit, the rest dashed
 * (where a move ends).
 */
function blueprint(cam: Camera, shots: Camera[]): string {
  const whole: Camera = { ...cam, size: 0.56, target: [W / 2, H * 0.58] };
  const m = homography(view(whole, W, H), W, H);
  const line = (d: string, attrs: string) => `<path d="${d}" stroke="${ACCENT}" ${attrs}/>`;
  const [first, ...rest] = shots.map(framed);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" fill="none" stroke-linejoin="round" stroke-linecap="round"><rect width="160" height="90" fill="#070a08"/>`,
    line(GRID, `stroke-opacity="0.07" stroke-width="0.5"`),
    line(`${quad(m, W * 0.45, H + BEZEL, W * 0.55, H * 1.2)}${quad(m, W * 0.33, H * 1.2, W * 0.67, H * 1.24)}`, `stroke-opacity="0.6" stroke-width="0.8"`),
    line(quad(m, -BEZEL, -BEZEL, W + BEZEL, H + BEZEL * 1.4), `stroke-width="1.2"`),
    line(quad(m, 0, 0, W, H), `stroke-opacity="0.5" stroke-width="0.6"`),
    line(codeLines(m), `stroke-opacity="0.3" stroke-width="1.6"`),
    first ? `<path d="${poly(m, first)}" fill="${ACCENT}" fill-opacity="0.16" stroke="${ACCENT}" stroke-width="1.2"/>` : "",
    ...rest.map((r) => line(poly(m, r), `stroke-width="1" stroke-dasharray="3 2"`)),
    `</svg>`,
  ].join("");
}

/** An SVG as an image source, for the menus. */
export const dataUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

const shot = (shot: Shot, corner: Corner = "top-left") => shotCamera({ shot, corner, zoom: 2 }, W, H, [0, 0, W, H], [W / 2, H / 2]);
/** As the effect moves the camera: Push closes in a tenth by the clip's end, Slide crosses a twentieth of the frame. */
const pushed = (c: Camera): Camera => ({ ...c, size: c.size * 1.1 });
const slid = (c: Camera, u: number): Camera => ({ ...c, target: [c.target[0] + 0.05 * W * (u - 0.5), c.target[1]] });

const SHOT_LABELS: Record<Shot, string> = {
  "head-on": "Head On",
  "corner-top-left": "Top-Left Corner",
  "corner-top-right": "Top-Right Corner",
  "edge-left": "Left Edge",
  "edge-right": "Right Edge",
  "close-left": "From the Left",
  "close-right": "From the Right",
  "low-macro": "Low Macro",
};
const CORNER_LABELS: Record<Corner, string> = { "top-left": "Top Left", "top-right": "Top Right", "bottom-left": "Bottom Left", "bottom-right": "Bottom Right" };
const head = shot("head-on");
const MOVES = {
  push: { label: "Push In", shots: [head, pushed(head)] },
  slide: { label: "Slide", shots: [slid(head, 0), slid(head, 1)] },
  still: { label: "Still", shots: [head] },
};

/** The Monitor's `choices`: each shot, head-on corner and move by name, with its blueprint. */
export const SHOT_CHOICES = {
  shot: Object.fromEntries(SHOTS.map((s) => [s, { label: SHOT_LABELS[s], art: dataUri(blueprint(shot(s), [shot(s)])) }])),
  corner: Object.fromEntries((Object.keys(CORNERS) as Corner[]).map((c) => [c, { label: CORNER_LABELS[c], art: dataUri(blueprint(head, [shot("head-on", c)])) }])),
  move: Object.fromEntries(Object.entries(MOVES).map(([id, m]) => [id, { label: m.label, art: dataUri(blueprint(head, m.shots)) }])),
};
