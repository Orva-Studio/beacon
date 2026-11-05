import { z } from "zod";
import { defineFeature, eachRawClip, IDENTITY, multiply, placement, project, split, ticksToSeconds, type BackdropLayer, type ClipEval, type EvalContext, type Matrix3, type TransformValues, type VisualLayer } from "@beacon/model";
import { cursorContentPoint } from "../cursor";
import { depthAt, homography, invert, view, wobble, type Camera } from "./camera";
import { ROOM_SIZE, roomPath } from "./rooms";
import { CORNERS, deg, shotCamera, SHOTS } from "./shots";
import { SHOT_CHOICES } from "./blueprint";
import wgsl from "./device-frame.wgsl" with { type: "text" };

const params = z.strictObject({
  shot: z.enum(SHOTS).describe("Where the camera is: head on at the screen's top-left corner, or at an angle (a top corner, a side edge, across from the left or right, a low macro), in a dark room"),
  corner: z.enum(Object.keys(CORNERS) as [keyof typeof CORNERS, ...(keyof typeof CORNERS)[]]).meta({ when: { shot: "head-on" } }).describe("Which corner of the screen a head-on shot is close on"),
  room: z.enum(["teal-studio", "none"]).meta({ when: { shot: "head-on" } }).describe("Behind the monitor when head on: the studio photo, out of focus, or none (a dark room)"),
  screen: z.enum(["matte", "glossy"]).describe("Matte only glows; glossy catches a lamp's soft reflection and a sheen that move with the camera"),
  focus: z.enum(["cursor", "point"]).describe("What is sharp: the recorded cursor as it moves (smoothed), or a point of the screen"),
  focusX: z.number().min(0).max(1).meta({ percent: true, when: { focus: "point" } }).describe("The point in focus, across the screen"),
  focusY: z.number().min(0).max(1).meta({ percent: true, when: { focus: "point" } }).describe("The point in focus, down the screen"),
  blur: z.number().min(0).max(1).meta({ percent: true }).describe("How shallow the focus is: how fast the screen and the room blur away from it"),
  glow: z.number().min(0).max(1).meta({ percent: true }).describe("The screen's bright parts blooming onto the bezel and room"),
  drift: z.number().min(0).max(1).meta({ percent: true }).describe("A handheld camera's slow wobble"),
  zoom: z.number().min(0.8).max(12).meta({ slider: { min: 0.8, max: 4 } }).describe("How close the camera is: the screen's width over the frame's (2 shows half of it; under 1 the whole screen, centred)"),
});
export type DeviceFrameParams = z.infer<typeof params>;

const DEFAULTS: DeviceFrameParams = { shot: "head-on", corner: "top-left", room: "teal-studio", screen: "matte", focus: "cursor", focusX: 0.5, focusY: 0.5, blur: 0.6, glow: 0.5, drift: 0.5, zoom: 2 };

const DARK_ROOM: [number, number, number, number] = [0.045, 0.034, 0.028, 1];
const BEZEL_COLOR: [number, number, number, number] = [0.006, 0.006, 0.007, 1];
const RIM_COLOR: [number, number, number, number] = [0.13, 0.12, 0.11, 1];
/** The room lamps' warm light, caught by the bezel's top edge and the side nearest the camera. */
const LAMP: [number, number, number] = [0.62, 0.42, 0.24];

function seedOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

const translate3 = (x: number, y: number): Matrix3 => [1, 0, x, 0, 1, y, 0, 0, 1];

/**
 * The camera for this frame: the shot at its zoom, turned by the clip's X and Y rotation (as the clip itself would
 * turn: Y the screen's right side away, X its top toward the camera), and the wobble. `rect`: where the recording
 * sits on the canvas (left, top, width, height), the monitor's screen exactly.
 */
function cameraAt(p: DeviceFrameParams, e: ClipEval, t: TransformValues, W: number, H: number, rect: [number, number, number, number], aimAt: [number, number]): Camera {
  let { yaw, pitch, size, target } = shotCamera(p, W, H, rect, aimAt);
  const limit = deg(60);
  yaw = Math.max(-limit, Math.min(limit, yaw - (t.rotationY ?? 0)));
  pitch = Math.max(-limit, Math.min(limit, pitch + (t.rotationX ?? 0)));
  const [a, b, c] = wobble(ticksToSeconds(e.time), seedOf(e.clip.id));
  yaw += deg(0.6) * a * p.drift;
  pitch += deg(0.4) * b * p.drift;
  target = [target[0] + 0.004 * W * c * p.drift, target[1]];
  return { yaw, pitch, size, target };
}

function draw(e: ClipEval & { main: VisualLayer }, p: DeviceFrameParams, ctx: EvalContext) {
  const { width: W, height: H } = ctx.canvas;
  const [w, h] = e.main.size;
  const t = e.props.transform as unknown as TransformValues | undefined;
  if (!t || !w || !h) return;
  const fit = Math.min(W / w, H / h);
  // The screen is the recording's own shape: fitted to the canvas, its spare strips would show as a wide black rim.
  const rect: [number, number, number, number] = [(W - w * fit) / 2, (H - h * fit) / 2, w * fit, h * fit];
  // The recording fills the monitor's screen; the clip's own placement (a zoom) is the camera punching in.
  const F = placement(ctx.canvas, e.main.size, { x: 0, y: 0, scaleX: fit, scaleY: fit, rotation: 0, rotationX: 0, rotationY: 0 });
  const T = placement(ctx.canvas, e.main.size, t);
  const toScreen = multiply(F, invert(T));
  const onScreen = (pt: [number, number] | undefined) => (pt ? project(F, pt[0], pt[1]) : undefined);
  let focusPoint: [number, number] = p.focus === "cursor" ? (onScreen(cursorContentPoint(e, ctx, e.time, 0.35)) ?? [W / 2, H / 2]) : [rect[0] + p.focusX * rect[2], rect[1] + p.focusY * rect[3]];
  const aimPoint = p.focus === "cursor" ? (onScreen(cursorContentPoint(e, ctx, e.time, 0.9)) ?? focusPoint) : focusPoint;
  const cam = cameraAt(p, e, t, W, H, rect, aimPoint);
  const headOn = p.shot === "head-on";
  const M = view(cam, W, H);
  const Hc = homography(M, W, H);
  // The cursor out of shot (a corner, far down the screen), the focus is on what the camera is aimed at instead.
  const [fx, fy] = project(Hc, ...focusPoint);
  if (p.focus === "cursor" && (fx < 0 || fy < 0 || fx > W || fy > H)) focusPoint = cam.target;
  // The clip's own Scale, Position and Rotation (Z) move the filmed shot as they would move the clip: a zoom in,
  // a pan, a roll; animated, they are the camera's moves.
  const k = Math.max(0.05, Math.abs(t.scaleX) / fit);
  const [cs, sn] = [Math.cos(t.rotation ?? 0), Math.sin(t.rotation ?? 0)];
  const Z: Matrix3 = [k * cs, k * sn, W / 2 + t.x - k * (cs * W / 2 + sn * H / 2), -k * sn, k * cs, H / 2 - t.y - k * (-sn * W / 2 + cs * H / 2), 0, 0, 1];
  const frameOf = multiply(Z, Hc);
  const place = (m: Matrix3) => split(m);

  for (const layer of e.layers) {
    if (layer.kind !== "visual") continue;
    const placed = place(multiply(frameOf, multiply(toScreen, [layer.transform[0], layer.transform[2], layer.transform[4], layer.transform[1], layer.transform[3], layer.transform[5], ...(layer.perspective ?? [0, 0]), 1] as Matrix3)));
    layer.transform = placed.transform;
    if (placed.perspective) layer.perspective = placed.perspective;
    else delete layer.perspective;
    delete layer.motion;
    delete layer.motionPerspective;
  }
  // The sheen sits where the room's light would glance off the screen for this camera, so it slides as the camera moves.
  const sheenAt = 0.35 - Math.sin(cam.yaw) * 0.9 - (cam.target[0] / W - 0.5) * 0.4;
  // A Film Look on the clip grades the whole shot (room, bezel and screen), not just the recording under the glass.
  const grades = (e.main.passes ?? []).filter((x) => x.pass === "film-look");
  e.main.passes = [...(e.main.passes ?? []).filter((x) => x.pass !== "film-look"), { pass: "device-screen", params: [p.screen === "glossy" ? 1 : 0, w, h, sheenAt] }];

  // Thin, as the reference's: about 2% of the frame at this shot's size.
  const bezel = [0.007 * W, 0.007 * W, 0.007 * W, 0.01 * W] as const;
  const rim = 0.0012 * W;
  const solid = (color: [number, number, number, number], left: number, top: number, right: number, bottom: number, radius: number): VisualLayer => {
    const placed = place(multiply(frameOf, translate3(rect[0] - left, rect[1] - top)));
    return { kind: "visual", content: { type: "solid", color }, size: [rect[2] + left + right, rect[3] + top + bottom], transform: placed.transform, ...(placed.perspective ? { perspective: placed.perspective } : {}), radius: [radius, radius, radius, radius] };
  };
  const nearSide = cam.yaw >= 0 ? 0 : 1;
  const lit = (layer: VisualLayer, strength: number, width: number): VisualLayer => ({ ...layer, passes: [{ pass: "device-rim", params: [...LAMP, strength, width, nearSide, ...layer.size] }] });
  // Head on, the studio photo filling the frame, a little larger so the camera's moves shift it a touch (a far wall
  // behind a near screen), lifted a little so a grade doesn't sink it, and keeping half its colour (the user found it
  // too vivid). Otherwise a dark room drawn: a warm lamp's falloff from the side away from the camera.
  const [iw, ih] = ROOM_SIZE;
  const sc = Math.max(W / iw, H / ih) * 1.08 * (1 + (k - 1) * 0.3);
  const cx = W / 2 - (cam.target[0] - W / 2) * 0.03;
  const cy = H / 2 - (cam.target[1] - H / 2) * 0.03;
  const photo = headOn && p.room === "teal-studio";
  const room: VisualLayer = photo
    ? { kind: "visual", content: { type: "source", source: ctx.source({ kind: "image", path: roomPath() }) }, size: [iw, ih], transform: [sc, 0, 0, sc, cx - (sc * iw) / 2, cy - (sc * ih) / 2], passes: [{ pass: "device-room", params: [1, 1.25, 0.5] }] }
    : { kind: "visual", content: { type: "solid", color: DARK_ROOM }, size: [W, H], transform: IDENTITY, passes: [{ pass: "device-room", params: [0, Math.sin(cam.yaw)] }] };
  const under = [room, lit(solid(RIM_COLOR, bezel[0] + rim, bezel[1] + rim, bezel[2] + rim, bezel[3] + rim, 0.004 * W), 0.5, 0.02 * W), lit(solid(BEZEL_COLOR, ...bezel, 0.004 * W), 0.18, 0.05 * W)];

  const focusDepth = depthAt(M, ...focusPoint);
  // Far enough that a photo's detail melts into soft shapes (the user: the less busy the background the better).
  const roomDepth = depthAt(M, W / 2, H / 2) + (photo ? 1.4 : 0.6) * W;
  const back = invert(frameOf);
  const frame: BackdropLayer = {
    kind: "backdrop",
    size: [W, H],
    transform: IDENTITY,
    passes: [
      {
        pass: "device-frame",
        params: [...back, M[6], M[7], M[8], focusDepth, p.blur * 0.05 * W * Math.min(1, (cam.size / 2) ** 0.7), roomDepth, ...bezel, rect[2], rect[3], 0.014 * W, p.glow * 0.6, 0.62, 0.012 * W, 0.0012 * W, ...focusPoint, headOn ? 0.09 * W : 1e9, rect[0], rect[1]],
      },
      ...grades,
    ],
  };
  e.layers.unshift(...under);
  e.layers.push(frame);
  const fade = Math.max(0, Math.min(1, (t as TransformValues & { opacity?: number }).opacity ?? 1));
  if (fade < 1) {
    // The shot fades as one: layer by layer, the opaque room and bezel would hide the screen fading (the user's
    // Opacity did nothing). The clip's opacity is already on its own layers, so it comes off them here.
    for (const l of e.layers) if (l.kind === "visual") l.opacity = fade > 0 ? Math.min(1, (l.opacity ?? 1) / fade) : 1;
    const shot = e.layers.splice(0, e.layers.length);
    e.layers.push({ kind: "visual", content: { type: "group", background: [0, 0, 0, 0], layers: shot }, size: [W, H], transform: IDENTITY, opacity: fade });
  }
}

/** v1's own grade, on Film Look's sliders: v2 moved it into a Film Look on the clip. */
const V1_GRADE = { exposure: 0.05, warmth: 0.4, tint: 0, fade: 0, contrast: 1.08, saturation: 0.88, grain: 0.12, grainSize: 0, halation: 0.06, halationSize: 6, vignette: 0.3, splitTone: 0.35, shadowHue: 200, highlightHue: 35, highlightStrength: 0.5 };

/**
 * v2: the settings the user's tries left behind (2026-11-04) dropped (`room`, `shot`), Sunlit back to matte, `zoom`
 * added at its default, and the grade kept as a Film Look on the clip at the same strength (it grades the whole shot
 * now), unless the clip has one; the dev app had already saved projects with them (adfinder). The Film Look's id is
 * the effect's own, its hex digits turned by 8, so migrating twice gives the same document.
 */
function settleSettings(doc: unknown): unknown {
  const keys = Object.keys(V2_DEFAULTS);
  eachRawClip(doc, (o) => {
    if (!Array.isArray(o.effects)) return;
    const effects = o.effects as { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[];
    for (const fx of [...effects]) {
      if (fx.type !== "device-frame") continue;
      const grade = Number(fx.params?.grade ?? 0);
      if (grade > 0 && !effects.some((x) => x.type === "film-look")) {
        const id = fx.id.replace(/(?<=-)[0-9a-f]+$/, (hex) => hex.replace(/./g, (d) => ((parseInt(d, 16) + 8) % 16).toString(16)));
        effects.splice(effects.indexOf(fx), 0, { id, type: "film-look", enabled: fx.enabled, params: { strength: grade, ...V1_GRADE } });
      }
      const kept = Object.fromEntries(Object.entries(fx.params ?? {}).filter(([k]) => keys.includes(k)));
      if (kept.screen !== "matte" && kept.screen !== "glossy") delete kept.screen;
      fx.params = { ...V2_DEFAULTS, ...kept };
    }
  });
  return doc;
}

/** v2's settings, as v2 saved them: its migration's output, whatever the current settings become. */
const V2_DEFAULTS = { move: "push", screen: "matte", focus: "cursor", focusX: 0.5, focusY: 0.5, blur: 0.6, glow: 0.5, drift: 0.5, zoom: 2 };

/** v4: the head-on Corner menu (the top left, the only one before). */
function addCorner(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    for (const fx of Array.isArray(o.effects) ? (o.effects as { type: string; params: Record<string, unknown> }[]) : []) {
      if (fx.type === "device-frame") fx.params = { corner: "top-left", ...fx.params };
    }
  });
  return doc;
}

/** v3: the Shot (head on, as v2 always was) and Room (the studio photo, as v2 always had) menus. */
function addShotAndRoom(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    for (const fx of Array.isArray(o.effects) ? (o.effects as { type: string; params: Record<string, unknown> }[]) : []) {
      if (fx.type === "device-frame") fx.params = { shot: "head-on", room: "teal-studio", ...fx.params };
    }
  });
  return doc;
}

/** v5: Move goes (the user, 2026-11-05): the clip's own Scale and Position, animated, move the camera. */
function dropMove(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    for (const fx of Array.isArray(o.effects) ? (o.effects as { type: string; params: Record<string, unknown> }[]) : []) {
      if (fx.type === "device-frame") delete fx.params.move;
    }
  });
  return doc;
}

/** A screen recording filmed on a monitor in a dim room: head on, steered by the clip's transform, shallow focus (on the cursor) and glow; a Film Look on the clip grades it all. */
export const deviceFrame = defineFeature({
  id: "device-frame",
  version: 5,
  migrations: [
    { version: 2, migrate: settleSettings },
    { version: 3, migrate: addShotAndRoom },
    { version: 4, migrate: addCorner },
    { version: 5, migrate: dropMove },
  ],
  effects: [
    {
      id: "device-frame",
      title: "Monitor",
      description: "The recording on a monitor in a dim room, filmed head on: shallow focus that can follow the cursor, the screen's glow; the clip's Scale, Position and Rotation (and their animations) move the camera; add Film Look to grade the whole shot",
      traits: ["visual"],
      params,
      defaults: () => ({ ...DEFAULTS }),
      choices: { ...SHOT_CHOICES, room: { "teal-studio": { label: "Studio" }, none: { label: "None" } } },
      apply(e, p, ctx) {
        draw(e, p as DeviceFrameParams, ctx);
      },
    },
  ],
  passes: [
    { id: "device-frame", wgsl, steps: ["fs_glow_h", "fs_glow_v", "fs_glow_add", "fs_dof_h", "fs_dof_v"] },
    { id: "device-screen", wgsl, steps: ["fs_screen"] },
    { id: "device-rim", wgsl, steps: ["fs_rim"] },
    { id: "device-room", wgsl, steps: ["fs_room"] },
  ],
});
