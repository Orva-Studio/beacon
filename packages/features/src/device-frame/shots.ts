import type { Camera } from "./camera";

export const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Head on (the default, the user, 2026-11-04): no angle, close on one corner of the screen (the top left, as their
 * terminal reference), a thin black bezel and the room out of focus past it. The corner stays a fifth of the way in
 * from the frame's side and a third from its top or bottom at any zoom, so zooming out shows more of the screen.
 */
export const CORNERS = { "top-left": [0.21, 0.33], "top-right": [0.79, 0.33], "bottom-left": [0.21, 0.67], "bottom-right": [0.79, 0.67] } as const;
export type Corner = keyof typeof CORNERS;

/**
 * The angled shots, always in the drawn dark room (a photo at an angle looked fake): `anchor` the point of the screen
 * aimed at (a share of its width and height), `aim` how far the camera turns from it toward the focus, `size` the
 * screen's width over the frame's at zoom 2.
 */
export const ANGLES = {
  "corner-top-left": { yaw: deg(26), pitch: deg(-8), size: 2.6, anchor: [0.09, 0.1], aim: 0 },
  "corner-top-right": { yaw: deg(-26), pitch: deg(-8), size: 2.6, anchor: [0.91, 0.1], aim: 0 },
  "edge-left": { yaw: deg(32), pitch: deg(3), size: 2.3, anchor: [0.06, 0.5], aim: 0.3 },
  "edge-right": { yaw: deg(-32), pitch: deg(3), size: 2.3, anchor: [0.94, 0.5], aim: 0.3 },
  "close-left": { yaw: deg(30), pitch: deg(4), size: 2.2, anchor: [0.5, 0.5], aim: 0.75 },
  "close-right": { yaw: deg(-30), pitch: deg(4), size: 2.2, anchor: [0.5, 0.5], aim: 0.75 },
  "low-macro": { yaw: deg(36), pitch: deg(-12), size: 3.2, anchor: [0.5, 0.5], aim: 0.85 },
} as const;
export const SHOTS = ["head-on", ...(Object.keys(ANGLES) as (keyof typeof ANGLES)[])] as ["head-on", ...(keyof typeof ANGLES)[]];
export type Shot = (typeof SHOTS)[number];

/**
 * The shot's camera before its move and wobble. `rect`: where the screen is on the canvas (left, top, width,
 * height); `aimAt`: the focus an angled shot turns toward.
 */
export function shotCamera(p: { shot: Shot; corner: Corner; zoom: number }, W: number, H: number, rect: [number, number, number, number], aimAt: [number, number]): Camera {
  // Zoomed out (under 1.6), the shot eases toward the screen's centre, so by 0.8 the whole screen is in it.
  const b = Math.max(0, Math.min(1, (p.zoom - 0.8) / 0.8));
  const centre: [number, number] = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
  const eased = ([x, y]: [number, number]): [number, number] => [centre[0] + (x - centre[0]) * b, centre[1] + (y - centre[1]) * b];
  if (p.shot !== "head-on") {
    const a = ANGLES[p.shot];
    const [ax, ay] = [rect[0] + a.anchor[0] * rect[2], rect[1] + a.anchor[1] * rect[3]];
    return { yaw: a.yaw, pitch: a.pitch, size: (a.size * p.zoom) / 2, target: eased([ax + (aimAt[0] - ax) * a.aim, ay + (aimAt[1] - ay) * a.aim]) };
  }
  // Aimed so the screen's corner lands where CORNERS puts it in the frame: the centre is that far from it, over the zoom.
  const [fx, fy] = CORNERS[p.corner];
  const [sx, sy] = [fx < 0.5 ? rect[0] : rect[0] + rect[2], fy < 0.5 ? rect[1] : rect[1] + rect[3]];
  return { yaw: 0, pitch: 0, size: p.zoom, target: eased([sx + ((0.5 - fx) * W) / p.zoom, sy + ((0.5 - fy) * H) / p.zoom]) };
}
