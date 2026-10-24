import { replica, useView } from "./store";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  editedValue,
  apply,
  compose,
  fromAffine,
  mediaTimeAt,
  multiply,
  panKeeping,
  placeCanvas,
  placement,
  project as projectPoint,
  rotate,
  scale,
  secondsToTicks,
  translate,
  type Affine,
  type Clip,
  type Project,
  type Session,
  type Track,
} from "@beacon/model";
import type { Host } from "./app";
import { addDropTarget, takes, type DropTarget } from "./drop";
import { rgba } from "./theme";
import { useTextEdit, type TextLine, type TextTarget } from "./text-edit";
import { useQuery } from "./query";
import { isFormField, useDialogsOpen } from "./controls";
import { safeAreaLines, safeAreaMarks, useSafeAreas } from "./safe-areas";
import { placeholderMarks } from "./broll";
import { canvasSnapping, type Guide } from "./canvas-snap";
import { boxGroup, contentSize, valueAt } from "./canvas-clips";
import { captionMarks, COLOR, cross, dotAt, handlePoints, HANDLE, line, MarksSvg, pivot, ROTATE, selectionMarks, type CanvasMark } from "./canvas-marks";


export interface Placed {
  clip: Clip;
  size: [number, number];
  t: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  crop: { left: number; top: number; right: number; bottom: number };
  /** What an edit at the playhead changes: mid-animation, the block's end values rather than those shown. */
  stored: { t: Placed["t"]; crop: Placed["crop"] };
  /** Content pixels → overlay points. */
  m: Affine;
  /** The visible (cropped) box's corners in overlay points: top-left, top-right, bottom-right, bottom-left. */
  corners: [number, number][];
}

/** Content pixels → canvas pixels, as the transform feature draws them (centre origin, y up). */
function contentToCanvas(p: Project, size: [number, number], t: Placed["t"]): Affine {
  return compose(translate(p.settings.width / 2 + t.x, p.settings.height / 2 - t.y), compose(rotate(t.rotation), compose(scale(t.scaleX, t.scaleY), translate(-size[0] / 2, -size[1] / 2))));
}

/** Visual clips showing at the playhead, top track first. */
function placedClips(project: Project, session: Session, view: Affine, visual: (c: Clip) => boolean): Placed[] {
  const at = secondsToTicks(session.playhead);
  const out: Placed[] = [];
  const visible = (t: Track) => !t.hidden;
  for (const track of [...project.tracks].reverse().filter(visible)) {
    for (const clip of track.clips) {
      if (clip.start > at || clip.start + clip.duration <= at || !visual(clip)) continue;
      const size = contentSize(project, clip);
      if (!size) continue;
      const v = (g: string, f: string, d: number) => valueAt(clip, session.playhead, g, f, d);
      const t = { x: v("transform", "x", 0), y: v("transform", "y", 0), scaleX: v("transform", "scaleX", 1), scaleY: v("transform", "scaleY", 1), rotation: v("transform", "rotation", 0) };
      const tilt = { rotationX: v("transform", "rotationX", 0), rotationY: v("transform", "rotationY", 0) };
      const crop = { left: v("crop", "left", 0), top: v("crop", "top", 0), right: v("crop", "right", 0), bottom: v("crop", "bottom", 0) };
      const media = mediaTimeAt(clip, Math.min(Math.max(at, clip.start), clip.start + clip.duration));
      const e = (g: string, f: string, d: number) => Number(editedValue(clip, g, f, media, d));
      const stored = {
        t: { x: e("transform", "x", 0), y: e("transform", "y", 0), scaleX: e("transform", "scaleX", 1), scaleY: e("transform", "scaleY", 1), rotation: e("transform", "rotation", 0) },
        crop: { left: e("crop", "left", 0), top: e("crop", "top", 0), right: e("crop", "right", 0), bottom: e("crop", "bottom", 0) },
      };
      const m = compose(view, contentToCanvas(project, size, t));
      // A tilted clip's outline follows its perspective; drags still work in its flat placement.
      const shown = multiply(fromAffine(view), placement(project.settings, size, { ...t, ...tilt }));
      const [l, tp, r, b] = [crop.left, crop.top, size[0] - crop.right, size[1] - crop.bottom];
      out.push({ clip, size, t, crop, stored, m, corners: [projectPoint(shown, l, tp), projectPoint(shown, r, tp), projectPoint(shown, r, b), projectPoint(shown, l, b)] });
    }
  }
  return out;
}

/** The colour of canvas pixel (x, y) in the frame at the playhead, 0-1 RGB; undefined off the canvas. */
async function sampleCanvas(host: Host, x: number, y: number): Promise<[number, number, number] | undefined> {
  const url = await host.frameImage();
  if (!url) return undefined;
  const img = new Image();
  img.src = url;
  await img.decode();
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return undefined;
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d")!;
  g.drawImage(img, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return [r! / 255, gr! / 255, b! / 255];
}

function inside(pt: [number, number], poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Handle → which crop edges it moves (sx: -1 left, 1 right; sy: -1 top, 1 bottom). */
const HANDLES = [
  { id: "nw", sx: -1, sy: -1 },
  { id: "n", sx: 0, sy: -1 },
  { id: "ne", sx: 1, sy: -1 },
  { id: "e", sx: 1, sy: 0 },
  { id: "se", sx: 1, sy: 1 },
  { id: "s", sx: 0, sy: 1 },
  { id: "sw", sx: -1, sy: 1 },
  { id: "w", sx: -1, sy: 0 },
] as const;
export type Handle = (typeof HANDLES)[number];

type Drag =
  /** `x`/`y`: where each clip is shown when the drag starts; `sx`/`sy`: the stored values the drag adds to. */
  | { kind: "move"; key: string; x0: number; y0: number; start: { id: string; x: number; y: number; sx: number; sy: number }[] }
  | { kind: "scale"; key: string; handle: Handle; clip: Placed; x0: number; y0: number }
  | { kind: "crop"; key: string; handle: Handle; clip: Placed; x0: number; y0: number }
  /** `a0`: the pointer's screen angle about the pivot when the drag starts. */
  | { kind: "rotate"; key: string; clip: Placed; a0: number }
  /** A caption dragged: the box when it started (canvas pixels) and the anchors and offsets it moves. */
  /** `alone`: the caption moves on its own (⌥, or it already is), `onward` with those after it (⌥⇧); else all move. */
  | { kind: "captionMove"; key: string; x0: number; y0: number; box: [number, number][]; style: CaptionPlace; alone: boolean; onward: boolean }
  /** A caption's side handle: its text's width when it started, which the handle widens or narrows. */
  | { kind: "captionWidth"; key: string; sx: number; x0: number; width: number; style: CaptionPlace }
  /** A middle-button drag: `c`, the canvas point grabbed. */
  | { kind: "pan"; c: [number, number] }
  | { kind: "text" };

/** Where captions sit (the captions' shared style): an edge or the middle on each axis, and canvas pixels in from it. */
type CaptionPlace = { anchorX: "left" | "center" | "right"; offsetX: number; anchorY: "top" | "middle" | "bottom"; offsetY: number; size: number; maxWidth: number };

/** The `captions.layout` query: the caption showing, its box and its text's lines from `origin` (canvas pixels). */
interface CaptionLayout {
  clip: string;
  box: { x: number; y: number; width: number; height: number };
  origin: [number, number];
  lines: TextLine[];
  text: string;
  /** Placed on its own rather than where the track's captions all sit. */
  own: boolean;
}

const isCaption = (p: Placed) => p.clip.type === "caption";

/**
 * Canvas handles, over the native preview: click selects the top
 * clip under the pointer, dragging moves the selection, corner handles scale
 * it, side handles stretch it (an annotation's handles size its box instead), with ⌥ any handle crops, and the green dot
 * rotates it (Shift: 15° steps). Each drag sends
 * `clip.set` at the playhead as it goes (the preview follows), as one undo step.
 */
export function CanvasOverlay({
  project,
  session,
  host,
  view: placement,
  clipTypes,
}: {
  project: Project;
  session: Session;
  host: Host;
  /** The native preview's box in the overlay, in points: the canvas is centred in it, fitted or at the zoom. */
  view: { x: number; y: number; width: number; height: number };
  /** Clip type → traits: only "visual" clips are on the canvas. */
  clipTypes: Record<string, string[]>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pending = useRef(0);
  const [guides, setGuides] = useState<Guide[]>([]);
  /** The rotate dot is green while the pointer is on it or rotating. */
  const [hot, setHot] = useState(false);
  const [rotating, setRotating] = useState(false);
  // ⌥ held (a handle drag crops) or a crop under way: the crop cursor says so.
  const [alt, setAlt] = useState(false);
  const [cropping, setCropping] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => setAlt(e.altKey);
    const off = () => setAlt(false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", off);
    };
  }, []);
  /**
   * Space held with the pointer over the canvas: dragging pans.
   * Space is also play/pause, so over the canvas a tap toggles
   * playback on release instead, unless the canvas was panned meanwhile.
   */
  const [space, setSpace] = useState(false);
  const spaceRef = useRef({ over: false, held: false, panned: false });
  const picking = useView((v) => v.picking);
  /** The text callout being typed in place (a double-click on it). */
  const [typing, setTyping] = useState<string | null>(null);
  useEffect(() => {
    const typing = (e: KeyboardEvent) => isFormField(e.target);
    const down = (e: KeyboardEvent) => {
      const r = spaceRef.current;
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || typing(e) || !(r.over || r.held)) return;
      e.preventDefault();
      e.stopPropagation();
      if (r.held) return;
      r.held = true;
      r.panned = false;
      setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      const r = spaceRef.current;
      if (e.code !== "Space" || !r.held) return;
      e.preventDefault();
      e.stopPropagation();
      r.held = false;
      setSpace(false);
      if (!r.panned) host.run("playback.toggle");
    };
    // Before the app's own key handling, which would play on keydown.
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [host]);
  const { width: CW, height: CH } = project.settings;
  const { x: vx, y: vy, width: vw, height: vh } = placement;
  const size = { width: vw, height: vh };
  const at0 = placeCanvas(project.settings, size, session.canvas.zoom, session.canvas.pan ?? [0, 0]);
  const k = at0.k;
  const ox = vx + at0.x;
  const oy = vy + at0.y;
  /** The pan that keeps canvas point `c` under overlay point `p` at zoom percent `zoom`. */
  const panFor = (zoom: number, c: [number, number], [px, py]: [number, number]) => panKeeping(project.settings, size, zoom, c, [px - vx, py - vy]);
  const view: Affine = [k, 0, 0, k, ox, oy];
  // Captions are laid out by the renderer, so their box comes from the core rather than a transform.
  const reported = useQuery<CaptionLayout | null>(host, session.playing ? "" : "captions.layout", { time: session.playhead }, project);
  /**
   * Where a dragged caption's box is going: drawn from the drag itself, as other clips' outlines are, until the
   * box the core reports catches up (it is a round trip behind the pointer).
   */
  const [moved, setMoved] = useState<{ clip: string; x: number; y: number; done?: boolean }>();
  const caught = !!moved && !!reported && reported.clip === moved.clip && Math.abs(reported.box.x - moved.x) < 0.5 && Math.abs(reported.box.y - moved.y) < 0.5;
  useEffect(() => {
    if (moved?.done && caught) setMoved(undefined);
  }, [moved, caught]);
  const caption = reported && moved && moved.clip === reported.clip && !caught ? { ...reported, box: { ...reported.box, x: moved.x, y: moved.y }, origin: [reported.origin[0] + moved.x - reported.box.x, reported.origin[1] + moved.y - reported.box.y] as [number, number] } : reported;
  /** Each top-level clip and its track's index, built once a timeline change rather than searched per clip. */
  const where = useMemo(() => new Map(project.tracks.flatMap((t, i) => t.clips.map((c) => [c.id, { clip: c, track: i }] as const))), [project.tracks]);
  const captionAt = caption ? where.get(caption.clip) : undefined;
  const captionClip = captionAt?.clip;
  const placed = placedClips(project, session, view, (c) => clipTypes[c.type]?.includes("visual") ?? false);
  const safe = useSafeAreas(host, project, session);
  if (caption && captionClip) {
    const { x, y, width, height } = caption.box;
    const t = { x: x + width / 2 - CW / 2, y: CH / 2 - (y + height / 2), scaleX: 1, scaleY: 1, rotation: 0 };
    const crop = { left: 0, top: 0, right: 0, bottom: 0 };
    const p: Placed = { clip: captionClip, size: [width, height], t, crop, stored: { t, crop }, m: compose(view, translate(x, y)), corners: [apply(view, x, y), apply(view, x + width, y), apply(view, x + width, y + height), apply(view, x, y + height)] };
    // Drawn in track order like the rest: above the clips on lower tracks.
    const at = placed.findIndex((q) => (where.get(q.clip.id)?.track ?? -1) < captionAt!.track);
    placed.splice(at < 0 ? placed.length : at, 0, p);
  }
  const captionPlace = (): CaptionPlace => ({ anchorX: "center", offsetX: 0, anchorY: "bottom", offsetY: 0, size: 54, maxWidth: 0.8, ...(captionAt ? (project.tracks[captionAt.track]!.props?.captionStyle as Partial<CaptionPlace> | undefined) : undefined), ...(captionClip?.props.captionPlace as Partial<CaptionPlace>) });
  // A locked track's clips are drawn and snapped to, but not picked, moved or dropped on: a click goes to what is under them.
  const pickable = placed.filter((p) => !project.tracks[where.get(p.clip.id)?.track ?? -1]?.locked);
  const selected = pickable.filter((p) => session.selection.includes(p.clip.id));

  // Panel items dropped on media on the canvas apply to the top clip there that takes them, at the playhead.
  const dropRef = useRef<DropTarget>(undefined);
  dropRef.current = (cx, cy, item) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return undefined;
    // Media dropped on the canvas goes on the timeline at the playhead.
    if (item.media) return { time: session.playhead };
    const hit = pickable.find((p) => inside([cx - r.left, cy - r.top], p.corners) && takes(item, clipTypes[p.clip.type]));
    return hit && { clip: hit.clip.id, time: session.playhead };
  };
  useEffect(() => addDropTarget((...a) => dropRef.current!(...a)), []);

  const typed = typing ? placed.find((p) => p.clip.id === typing) : undefined;
  useEffect(() => {
    if (typing && (!typed || !session.selection.includes(typing))) setTyping(null);
  }, [typing, typed, session.selection]);
  /** Box units of the typed text → overlay points: a callout's box, or a caption's text origin. */
  const typedM = typed && (isCaption(typed) && caption ? compose(view, translate(...caption.origin)) : typed.m);
  const target: TextTarget | undefined = !typed
    ? undefined
    : isCaption(typed)
      ? caption ? {
          id: typed.clip.id,
          text: caption.text,
          layoutKey: JSON.stringify(caption.lines),
          lines: async () => caption.lines,
          set: (t) => host.run("caption.setText", { clip: typed.clip.id, text: t }, "Edit Caption", `caption-text-${typed.clip.id}`),
          draft: true,
        } : undefined
      : (() => {
          const c = typed.clip.props.callout as { text?: { text: string } & Record<string, unknown>; width: number; height: number } | undefined;
          return (
            c?.text ? {
              id: typed.clip.id,
              text: c.text.text,
              layoutKey: JSON.stringify({ ...c.text, width: c.width, height: c.height }),
              lines: async () => (await host.query("callout.textLayout", { clip: typed.clip.id })) as TextLine[],
              set: (t: string) => host.run("clip.set", { clips: [typed.clip.id], props: { callout: { text: { ...c.text, text: t } } } }, "Edit Text", `text-${typed.clip.id}`),
            } : undefined
          );
        })();
  const text = useTextEdit(target, typedM, () => setTyping(null));
  /** A point in the typed text's box units, if inside its box. */
  const inTyped = (pt: [number, number]): [number, number] | undefined => (typed && typedM && inside(pt, typed.corners) ? apply(invert(typedM), ...pt) : undefined);

  const at = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];
  const marks: CanvasMark[] = [
    // An empty B-roll placeholder draws nothing: its box shows where its footage will go.
    ...placed.filter((p) => p.clip.type === "broll" && !p.clip.assetId).flatMap(placeholderMarks),
    ...(safe.shown ? safeAreaMarks(safe.shown, at, k, CW, safe.hidden) : []),
    ...text.marks,
    // The canvas's thin grey border, just outside it.
    ...(() => {
      const [l, t, r, b] = [ox - 0.5, oy - 0.5, ox + CW * k + 0.5, oy + CH * k + 0.5];
      return [line([l, t], [r, t], COLOR.border), line([r, t], [r, b], COLOR.border), line([r, b], [l, b], COLOR.border), line([l, b], [l, t], COLOR.border)];
    })(),
    // While typing in place, the box shows its outline only: the rotate control would sit on the text.
    ...selected.flatMap((p) =>
      p.clip.id === typing ? selectionMarks(p, false).filter((m) => m.kind === "line").slice(0, 4) : isCaption(p) ? captionMarks(p) : selectionMarks(p, hot || rotating),
    ),
    ...guides.flatMap((g) => {
      const pt = (v: number) => (g.axis === "x" ? at(g.at, v) : at(v, g.at));
      return [line(pt(g.from), pt(g.to), COLOR.guide), ...g.marks.flatMap((m) => cross(pt(m), 3, COLOR.guide))];
    }),
  ];
  const sentMarks = useRef("");
  const dimmed = useDialogsOpen();
  useEffect(() => {
    if (!host.canvasMarks) return;
    // In canvas pixels, which the preview places with the picture: panning and zooming don't resend them.
    const r = (v: number) => Math.round(v * 100) / 100;
    const c = ([x, y]: [number, number]): [number, number] => [r((x - ox) / k), r((y - oy) / k)];
    const shifted = marks.map((m) => (m.kind === "line" ? { ...m, from: c(m.from), to: c(m.to) } : { ...m, at: c(m.at) }));
    // Under a dialog, the backdrop's dimming: one band wider and taller than any view, drawn last.
    if (dimmed) shifted.push({ kind: "line", from: [-1e5, 0], to: [1e5, 0], width: 1e5, color: rgba("backdrop"), butt: true });
    const json = JSON.stringify(shifted);
    if (json === sentMarks.current) return;
    sentMarks.current = json;
    host.canvasMarks(shifted);
  });

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const send = (steps: { clip: string; props: Record<string, Record<string, number>> }[], label: string, key: string) => {
    cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => {
      for (const s of steps) host.run("clip.set", { clip: s.clip, at: session.playhead, props: s.props }, label, key);
    });
  };

  const { snapResize, snapMove } = canvasSnapping({ placed, ox, oy, k, width: CW, height: CH, on: session.canvas.snapping, moving: new Set(selected.map((p) => p.clip.id)), ...(safe.shown && !safe.hidden.includes("zones") ? { extra: safeAreaLines(safe.shown) } : {}) });

  return (
    <div
      ref={box}
      data-canvas-overlay
      className="absolute inset-0"
      style={picking ? { cursor: "crosshair" } : cropping ? { cursor: CROP_CURSOR } : space ? { cursor: drag.current?.kind === "pan" ? "grabbing" : "grab" } : undefined}
      // Typing in place: a click in the box must not take focus from the unseen text field.
      onMouseDown={(e) => typing && e.preventDefault()}
      onPointerEnter={() => void (spaceRef.current.over = true)}
      onPointerLeave={() => void (spaceRef.current.over = false)}
      onWheel={(e) => {
        // The wheel (and a trackpad pinch, which arrives as a wheel with Control) zooms about the pointer.
        const pt = local(e as unknown as React.PointerEvent);
        const c: [number, number] = [(pt[0] - ox) / k, (pt[1] - oy) / k];
        const next = clamp(Math.round(k * 100 * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)) * 10) / 10, 5, 800);
        if (next === Math.round(k * 1000) / 10) return;
        host.run("canvas.zoom", { zoom: next, pan: panFor(next, c, pt) });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const hit = pickable.find((p) => inside(local(e), p.corners));
        if (!hit) return host.canvasMenu();
        if (!session.selection.includes(hit.clip.id)) host.run("selection.set", { clips: [hit.clip.id], linked: true });
        host.clipMenu(hit.clip.id, "canvas");
      }}
      onPointerDown={(e) => {
        if (picking && e.button === 0) {
          e.preventDefault();
          e.stopPropagation();
          const pt = local(e);
          replica.pick(undefined);
          void sampleCanvas(host, (pt[0] - ox) / k, (pt[1] - oy) / k).then(picking, () => picking());
          return;
        }
        if (e.button === 1 || (e.button === 0 && spaceRef.current.held)) {
          e.preventDefault();
          spaceRef.current.panned = true;
          const pt = local(e);
          box.current!.setPointerCapture(e.pointerId);
          drag.current = { kind: "pan", c: [(pt[0] - ox) / k, (pt[1] - oy) / k] };
          return;
        }
        if (e.button !== 0) return;
        const pt = local(e);
        const key = `canvas-${Date.now()}`;
        const handle = (e.target as HTMLElement).dataset.handle;
        const owner = (e.target as HTMLElement).dataset.clip;
        const target = handle && owner ? selected.find((p) => p.clip.id === owner) : undefined;
        box.current!.setPointerCapture(e.pointerId);
        if (target && handle === "rotate") {
          const [cx, cy] = pivot(target);
          drag.current = { kind: "rotate", key, clip: target, a0: Math.atan2(pt[1] - cy, pt[0] - cx) };
          setRotating(true);
          return;
        }
        if (target && handle && isCaption(target)) {
          const place = captionPlace();
          drag.current = { kind: "captionWidth", key, sx: HANDLES.find((x) => x.id === handle)!.sx, x0: pt[0], width: target.size[0] - 2 * place.size * 0.45, style: place };
          return;
        }
        if (target && handle) {
          const h = HANDLES.find((x) => x.id === handle)!;
          drag.current = { kind: e.altKey ? "crop" : "scale", key, handle: h, clip: target, x0: pt[0], y0: pt[1] };
          setCropping(e.altKey);
          return;
        }
        if (typing && text.pointer("down", inTyped(pt), e.detail, e.shiftKey)) {
          drag.current = { kind: "text" };
          return;
        }
        const hit = pickable.find((p) => inside(pt, p.corners));
        // A callout's or a caption's text is typed in place after a double-click.
        if (hit && e.detail === 2 && (isCaption(hit) || (hit.clip.props.callout as { text?: unknown } | undefined)?.text)) {
          host.run("inspector.tab", { tab: isCaption(hit) ? "caption" : "callout" });
          setTyping(hit.clip.id);
          return;
        }
        // A caption moves every caption, which share one place, unless it is placed on its own or ⌥ places it so.
        if (hit && isCaption(hit) && !e.metaKey && (!e.shiftKey || e.altKey)) {
          if (!session.selection.includes(hit.clip.id) || session.selection.length > 1) host.run("selection.set", { clips: [hit.clip.id], linked: false });
          const alone = e.altKey || !!caption?.own;
          drag.current = { kind: "captionMove", key, x0: pt[0], y0: pt[1], box: hit.corners.map(([x, y]) => [(x - ox) / k, (y - oy) / k] as [number, number]), style: captionPlace(), alone, onward: e.altKey && e.shiftKey };
          setMoved(undefined);
          return;
        }
        if (!hit) {
          if (session.selection.length) host.run("selection.clear");
          return;
        }
        let ids = session.selection;
        if (e.shiftKey || e.metaKey) {
          host.run("selection.set", { clips: [hit.clip.id], toggle: true, linked: true });
          return;
        }
        if (!ids.includes(hit.clip.id)) {
          ids = [hit.clip.id];
          host.run("selection.set", { clips: ids, linked: true });
        }
        const start = pickable.filter((p) => ids.includes(p.clip.id)).map((p) => ({ id: p.clip.id, x: p.t.x, y: p.t.y, sx: p.stored.t.x, sy: p.stored.t.y }));
        drag.current = { kind: "move", key, x0: pt[0], y0: pt[1], start };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const [px, py] = local(e);
        if (d.kind === "text") {
          // Past the box's edge the selection keeps to the nearest offset.
          if (typedM) text.pointer("move", apply(invert(typedM), px, py));
          return;
        }
        if (d.kind === "pan") {
          const zoom = Math.round(k * 1000) / 10;
          cancelAnimationFrame(pending.current);
          pending.current = requestAnimationFrame(() => host.run("canvas.zoom", { zoom, pan: panFor(zoom, d.c, [px, py]) }));
          return;
        }
        if (d.kind === "captionMove") {
          const snap = snapMove([d.box], (px - d.x0) / k, (py - d.y0) / k, e.ctrlKey);
          setGuides(snap.guides);
          const s = d.style;
          const offsetX = s.offsetX + (s.anchorX === "right" ? -snap.dx : snap.dx);
          const offsetY = s.offsetY + (s.anchorY === "bottom" ? -snap.dy : snap.dy);
          // Offsets are whole pixels, so the box drawn now is where the renderer will put it.
          const [x, y] = [Math.round(offsetX) - s.offsetX, Math.round(offsetY) - s.offsetY];
          setMoved({ clip: captionClip!.id, x: d.box[0]![0] + (s.anchorX === "right" ? -x : x), y: d.box[0]![1] + (s.anchorY === "bottom" ? -y : y) });
          const place = { offsetX: Math.round(offsetX), offsetY: Math.round(offsetY) };
          if (d.alone) host.run("caption.place", { clip: captionClip!.id, place, onward: d.onward }, d.onward ? "Move Captions From Here" : "Move Caption", d.key);
          else host.run("captions.style", { style: place }, "Move Captions", d.key);
          return;
        }
        if (d.kind === "captionWidth") {
          const s = d.style;
          const du = (px - d.x0) / k;
          // About the centre both sides move; against an edge, the other side moves and the box keeps to the edge.
          const grow = s.anchorX === "center" ? 2 * d.sx * du : d.sx * du;
          const width = clamp(d.width + grow, CW * 0.2, CW);
          const moves = (s.anchorX === "left" && d.sx < 0) || (s.anchorX === "right" && d.sx > 0);
          const offsetX = moves ? s.offsetX - (width - d.width) : s.offsetX;
          host.run("captions.style", { style: { maxWidth: Math.round((width / CW) * 1000) / 1000, ...(moves ? { offsetX: Math.round(offsetX) } : {}) } }, "Caption Width", d.key);
          return;
        }
        if (d.kind === "move") {
          const boxes = placed.filter((p) => d.start.some((s) => s.id === p.clip.id)).map((p) => {
            const s = d.start.find((x) => x.id === p.clip.id)!;
            // Corners as they were when the drag began, in canvas pixels.
            return p.corners.map(([x, y]) => [(x - ox) / k - (p.t.x - s.x), (y - oy) / k + (p.t.y - s.y)] as [number, number]);
          });
          const snap = snapMove(boxes, (px - d.x0) / k, (py - d.y0) / k, e.ctrlKey);
          setGuides(snap.guides);
          send(d.start.map((s) => ({ clip: s.id, props: { transform: { x: s.sx + snap.dx, y: s.sy - snap.dy } } })), "Move", d.key);
          return;
        }
        const p = d.clip;
        if (d.kind === "rotate") {
          const [cx, cy] = pivot(p);
          // Screen angles grow clockwise (y down); rotation grows anticlockwise.
          const turn = Math.atan2(py - cy, px - cx) - d.a0;
          const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn));
          let r = p.t.rotation - wrapped;
          if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
          send([{ clip: p.clip.id, props: { transform: { rotation: p.stored.t.rotation + r - p.t.rotation } } }], "Rotate", d.key);
          return;
        }
        // The pointer's movement in the clip's own content pixels.
        const inv = invert(p.m);
        const [u0, v0] = apply(inv, d.x0, d.y0);
        const [u1, v1] = apply(inv, px, py);
        const { sx, sy } = d.handle;
        if (d.kind === "crop") {
          const c = { ...p.crop };
          if (sx < 0) c.left = clamp(p.crop.left + (u1 - u0), 0, p.size[0] - p.crop.right - 2);
          if (sx > 0) c.right = clamp(p.crop.right - (u1 - u0), 0, p.size[0] - p.crop.left - 2);
          if (sy < 0) c.top = clamp(p.crop.top + (v1 - v0), 0, p.size[1] - p.crop.bottom - 2);
          if (sy > 0) c.bottom = clamp(p.crop.bottom - (v1 - v0), 0, p.size[1] - p.crop.top - 2);
          const sc = p.stored.crop;
          send([{ clip: p.clip.id, props: { crop: { left: sc.left + c.left - p.crop.left, top: sc.top + c.top - p.crop.top, right: sc.right + c.right - p.crop.right, bottom: sc.bottom + c.bottom - p.crop.bottom } } }], "Crop", d.key);
          return;
        }
        const box = boxGroup(p.clip);
        if (box) {
          // An annotation's handles size its box (text rewraps, outlines keep their width); its scale is the Visual tab's.
          const snapped = snapResize(p, d.handle, [(p.size[0] + sx * (u1 - u0)) / p.size[0], (p.size[1] + sy * (v1 - v0)) / p.size[1]], false, e.ctrlKey);
          setGuides(snapped.guides);
          const width = Math.max(8, Math.round(p.size[0] * snapped.rel[0]));
          const height = Math.max(8, Math.round(p.size[1] * snapped.rel[1]));
          const size: [number, number] = [sx ? width : p.size[0], sy ? height : p.size[1]];
          const fixed = (s: [number, number]): [number, number] => [sx > 0 ? 0 : sx < 0 ? s[0] : s[0] / 2, sy > 0 ? 0 : sy < 0 ? s[1] : s[1] / 2];
          const before = apply(contentToCanvas(project, p.size, p.t), ...fixed(p.size));
          const after = apply(contentToCanvas(project, size, p.t), ...fixed(size));
          const st = p.stored.t;
          send([{ clip: p.clip.id, props: { [box]: { width: size[0], height: size[1] }, transform: { x: st.x - (after[0] - before[0]), y: st.y + (after[1] - before[1]) } } }], "Resize", d.key);
          return;
        }
        // Scale about the opposite side or corner, which stays put.
        const w = p.size[0] - p.crop.left - p.crop.right;
        const h = p.size[1] - p.crop.top - p.crop.bottom;
        const fx = sx ? Math.max(0.02, (w + sx * (u1 - u0)) / w) : 1;
        const fy = sy ? Math.max(0.02, (h + sy * (v1 - v0)) / h) : 1;
        const corner = sx && sy;
        const f = corner ? Math.max(fx, fy) : 1;
        const snapped = snapResize(p, d.handle, [corner ? f : fx, corner ? f : fy], !!corner, e.ctrlKey);
        setGuides(snapped.guides);
        const [kx, ky] = snapped.rel;
        const anchor: [number, number] = [sx > 0 ? p.crop.left : sx < 0 ? p.size[0] - p.crop.right : p.size[0] / 2, sy > 0 ? p.crop.top : sy < 0 ? p.size[1] - p.crop.bottom : p.size[1] / 2];
        const before = apply(contentToCanvas(project, p.size, p.t), ...anchor);
        const t = { ...p.t, scaleX: p.t.scaleX * kx, scaleY: p.t.scaleY * ky };
        const after = apply(contentToCanvas(project, p.size, t), ...anchor);
        const st = p.stored.t;
        send([{ clip: p.clip.id, props: { transform: { scaleX: st.scaleX * kx, scaleY: st.scaleY * ky, x: st.x - (after[0] - before[0]), y: st.y + (after[1] - before[1]) } } }], "Scale", d.key);
      }}
      onPointerUp={(e) => {
        if (drag.current?.kind === "text") text.pointer("up", undefined);
        if (drag.current?.kind === "captionMove") setMoved((m) => m && { ...m, done: true });
        drag.current = null;
        setGuides([]);
        setRotating(false);
        setCropping(false);
        box.current!.releasePointerCapture(e.pointerId);
      }}
    >
      {text.element}
      {!host.canvasMarks && <MarksSvg marks={marks} />}
      {selected.filter((p) => p.clip.id !== typing).map((p) => (
        <Grips key={p.clip.id} p={p} onHot={setHot} crop={alt || cropping} caption={isCaption(p)} />
      ))}
    </div>
  );
}

/** The crop glyph, white edged in black so it shows on any picture; the hotspot at its middle. */
const CROP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="black" stroke-width="4"><path d="M6 2v16h16"/><path d="M2 6h16v16"/></g>' +
    '<g stroke="white" stroke-width="2"><path d="M6 2v16h16"/><path d="M2 6h16v16"/></g></svg>',
)}") 12 12, crosshair`;

function Grips({ p, onHot, crop, caption }: { p: Placed; onHot: (on: boolean) => void; crop: boolean; caption?: boolean }) {
  const at = handlePoints(p);
  const dot = dotAt(p);
  const round = (x: number, y: number, size: number) => ({ left: x - size / 2, top: y - size / 2, width: size, height: size });
  // The clip's angle on screen, so the resize cursors follow the rotation.
  const turn = Math.atan2(p.corners[1]![1] - p.corners[0]![1], p.corners[1]![0] - p.corners[0]![0]);
  const cursorAt = (h: Handle) => {
    const angle = (Math.atan2(h.sy, h.sx) + turn + 2 * Math.PI) % Math.PI;
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(angle / (Math.PI / 4)) % 4];
  };
  return (
    <>
      {HANDLES.filter((h) => !caption || h.sy === 0).map((h) => (
        <div key={h.id} data-handle={h.id} data-clip={p.clip.id} className="absolute rounded-full" style={{ ...round(at[h.id]![0], at[h.id]![1], HANDLE + 4), cursor: !caption && crop ? CROP_CURSOR : cursorAt(h) }} />
      ))}
      {!caption && <div
        data-handle="rotate"
        data-clip={p.clip.id}
        title="Drag to rotate (Shift: 15° steps)"
        className="absolute cursor-grab rounded-full"
        style={round(dot[0], dot[1], ROTATE.dot + 4)}
        onPointerEnter={() => onHot(true)}
        onPointerLeave={() => onHot(false)}
      />}
    </>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function invert(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
