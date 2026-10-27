import type { RefObject } from "react";
import {
  animatedValue,
  assetName,
  clipSpeed,
  editScope,
  envelopePoints,
  mediaTimeAt,
  rationalToNumber,
  scopedProject,
  secondsToTicks,
  ticksToSeconds,
  TRACK_HEIGHT,
  wordsInWindow,
  type Animation,
  type Clip,
  type Project,
  type Session,
  type Track,
} from "@beacon/model";
import type { PanelItem } from "./drop";
import { drawIcon, type IconName } from "./controls";
import { clipBox, cornerButtons, maxTop, rowTop, shownSpan, drawArrow, drawFxBadge, headerIcons, shownName, HEIGHT_SLIDER, PIN_H, PIN_W, RANGE_TAB, RULER, volumeY } from "./timeline-layout";
import type { ViewState } from "./store";
import { color, font } from "./theme";
import { timecode } from "./time";
import { propsOf } from "./props";

const INVALID = () => color("invalid");

export type PressDrag = { kind: "press"; clip: string; x0: number; y0: number; toggle: boolean; ripple: boolean; range: boolean };
/** `moves`: every clip that moves (with a ripple, those after it too) → tracks up. */
export type MoveDrag = { kind: "move"; ids: string[]; moves: Map<string, number>; by: number; rows: number; ripple: boolean; error?: string; x0: number; y0: number };
export type Drag =
  | { kind: "playhead" }
  | { kind: "height" }
  | { kind: "track"; track: string; from: number; to: number }
  | { kind: "anim"; clip: string; anim: string; part: "start" | "end" | "body"; x0: number; a: number; b: number; key: string }
  | { kind: "volume"; clip: string; index: number | null; x0: number; y0: number; points: { time: number; value: number }[]; base: number; key: string; at?: [number, number] }
  | { kind: "range"; anchor: number }
  | { kind: "rangeEdge"; edge: "in" | "out"; other: number }
  /** Shift-drag: time opened (d > 0) or closed (d < 0, no more than `room`) at `at`, on every unlocked track or `track` (drawn on `row`); `playhead`: begun on it, which follows. */
  | { kind: "space"; at: number; d: number; room: number; track?: string; row?: number; playhead?: boolean }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; base: string[] }
  | PressDrag
  | MoveDrag
  /** `edges`: where each trimmed clip's dragged edge is drawn, the one grabbed (at `t`) and the others selected or linked with it. */
  | { kind: "trim"; clip: string; edge: "start" | "end"; x0: number; t: number; ripple: boolean; extend: boolean; edges: Map<string, number> };


/**
 * What the timeline shows: the project, or with a group open (its
 * group tab) its tracks at main-timeline times, the times commands take.
 */
export function timelineView(project: Project, session: Session, nested: Record<string, string>): { project: Project; group?: Clip } {
  // The same object while the project and the open group are: a new one each render would redraw the timeline every tick.
  const last = lastView;
  if (last && last.project === project && last.group === session.group && last.nested === nested) return last.view;
  const scope = editScope(project, session.group, (c) => innerTracks(c, nested));
  const view = { project: scopedProject(project, scope), group: scope.group };
  lastView = { project, group: session.group, nested, view };
  return view;
}
/** No nested prop groups, as one object so `timelineView`'s callers share its cached view before `init` arrives. */
export const NO_NESTED: Record<string, string> = {};
let lastView: { project: Project; group: Session["group"]; nested: Record<string, string>; view: { project: Project; group?: Clip } } | undefined;

/** Timeline seconds of a media time in a clip. */
const onTimeline = (c: Clip, media: number) => ticksToSeconds(c.start + (media - (c.mediaStart ?? 0)) / clipSpeed(c));

/** The clip's visual animation blocks as timeline spans; audio volume points are drawn as a line instead. */
export function arrows(c: Clip): { anim: Animation; a: number; b: number }[] {
  return c.animations
    .filter((a) => Object.keys(a.to).some((k) => !k.startsWith("audio.")))
    .map((anim) => ({ anim, a: onTimeline(c, anim.end - anim.duration), b: onTimeline(c, anim.end) }));
}

/** How long a clip's fx badge flashes after an effect is added to it. */
const FLASH_MS = 1600;

/** A clip's audio points on the timeline (seconds, gain), as the volume feature reads them. */
export function volumePoints(c: Clip): { time: number; value: number }[] {
  const base = propsOf<{ volume: number }>(c, "audio").volume;
  return envelopePoints(base, c.animations, "audio.volume").map((p) => ({ time: onTimeline(c, p.time), value: p.value }));
}

export function volumeAt(c: Clip, t: number): number {
  return Number(animatedValue(propsOf<{ volume: number }>(c, "audio").volume, "audio.volume", c.animations, mediaTimeAt(c, secondsToTicks(t))));
}

const VOLUME = { line: () => color("volume-line"), selected: () => color("volume-selected") };

/** `text` cut to `max` pixels wide with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

/** Clips are coloured by kind; selection adds an accent border, and brightens audio. */
const CLIP = { text: () => color("text-bright"), wave: () => color("wave"), badge: () => color("clip-badge") };
const KIND: Record<string, string> = { broll: "clip-screen", screen: "clip-screen", video: "clip-screen", image: "clip-screen", still: "clip-screen", audio: "clip-audio", callout: "clip-annotation", region: "clip-annotation", caption: "clip-annotation" };

/**
 * A clip's colour token: a recording's camera blue, other visual media (screen recordings, imported video
 * and images) green, audio orange, annotations purple; a stitched clip by its first piece; groups neutral.
 */
function kindColor(clip: Clip, nested: Record<string, string>, project: Project): string {
  const group = nested[clip.type];
  if (clip.type === "stitched" && group) {
    const first = (clip.props[group] as { tracks?: { clips: Clip[] }[] } | undefined)?.tracks?.[0]?.clips[0];
    if (first) return kindColor(first, nested, project);
  }
  if ((clip.type === "video" || clip.type === "still") && project.assets[clip.assetId ?? ""]?.kind === "recording") return "clip-video";
  return KIND[clip.type] ?? "clip";
}
const AUDIO_SELECTED = { fill: () => color("audio-selected"), top: () => color("audio-selected-top"), wave: () => color("audio-selected-wave") };
const SELECTED = () => color("accent");
const CLIP_RADIUS = 8;
/** A colour label's stripe along the top of a clip, in points. */
const LABEL_H = 6;
const STITCH = () => color("stitch");

/** A span over every track, in timeline seconds. */
export interface TimelineMark {
  start: number;
  end: number;
  /** To cut (red), kept (grey), or the take kept of a line said more than once (green). */
  tone: "cut" | "keep" | "take";
  /** The one being looked at, going through them one at a time: outlined. */
  current?: boolean;
}

const images = new Map<string, HTMLImageElement>();

/** Lets go of decoded thumbnails no clip shows any more (deleted, or another project's): `thumbs` keeps every one sent. */
export function keepImages(project: Project, thumbs: Record<string, string>) {
  const shown = new Set(project.tracks.flatMap((t) => t.clips.map((c) => thumbs[c.id])));
  for (const url of images.keys()) if (!shown.has(url)) images.delete(url);
}

/** A decoded thumbnail, or undefined until it has loaded (then `onLoad` redraws). */
function image(url: string, onLoad: () => void): HTMLImageElement | undefined {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : undefined;
}

/** Points per frame from which the ruler ticks each frame, numbers them, and shades the playhead's frame. */
const FRAME_TICKS = 5;
const FRAME_LABELS = 36;
const FRAME_SHADE = 10;

/** Ruler ticks: the smallest step that leaves room for a label. */
function step(pxPerSecond: number, fps: number): number {
  const steps = [1 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find((s) => s * pxPerSecond >= 90) ?? 3600;
}

/** A group's or stitched clip's own tracks, through the prop group that holds them (`Init.nested`). */
export function innerTracks(clip: Clip, nested: Record<string, string>): Track[] | undefined {
  const g = nested[clip.type];
  return g ? (clip.props[g] as { tracks?: Track[] } | undefined)?.tracks : undefined;
}

/** The media's file name without its extension; a group is "Group". */
export function clipLabel(project: Project, clip: Clip, nested: Record<string, string>, traits: string[] = []): string {
  if (traits.includes("group")) return "Group";
  // Stitched media is named after the recording its pieces come from.
  const inner = innerTracks(clip, nested)?.[0]?.clips[0];
  const asset = project.assets[clip.assetId ?? inner?.assetId ?? ""];
  if (asset) return assetName(asset);
  // Annotations say what they are: a text callout its text, the rest their shape or kind.
  const callout = clip.props.callout as { shape?: string; text?: { text?: string } } | undefined;
  if (callout?.shape === "text") return callout.text?.text?.split("\n")[0]?.trim() || "Text";
  if (callout?.shape) return callout.shape === "rectangle" ? "Shape" : callout.shape[0]!.toUpperCase() + callout.shape.slice(1);
  const caption = (clip.props.caption as { words?: { text: string; start: number; end: number }[] } | undefined)?.words;
  if (caption) return wordsInWindow(clip, caption).map((w) => w.text).join(" ") || "Caption";
  // B-roll without footage yet: what it will show.
  if (clip.type === "broll") return ((b) => (b?.source === "manual" ? b.manual : b?.prompt))(clip.props.broll as { prompt?: string; manual?: string; source?: string } | undefined)?.trim() || "B-roll";
  const region = (clip.props.region as { kind?: string } | undefined)?.kind;
  if (region) return region[0]!.toUpperCase() + region.slice(1);
  return clip.type;
}

/**
 * The timeline, drawn on a canvas (PLAN §10). Drags draw a ghost and send
 * one command when they end, so each is one undo step.
 */
/** What drawing the timeline reads: the component's latest render, its refs and its hit tests. */
export interface TimelineDrawing {
  canvas: RefObject<HTMLCanvasElement | null>;
  latest: RefObject<{ project: Project; session: Session; waveforms: Record<string, Record<number, number[]>>; thumbs: Record<string, string>; dragging: ViewState["dragging"]; marks?: TimelineMark[] }>;
  size: RefObject<{ w: number; h: number }>;
  staticLayer: RefObject<{ canvas?: HTMLCanvasElement; key: unknown[] }>;
  dragState: RefObject<Drag | null>;
  settling: RefObject<{ drag: Drag; timer: ReturnType<typeof setTimeout> } | null>;
  snapLine: RefObject<number | undefined>;
  pickedDiamond: RefObject<{ anim: string; part: "start" | "end" } | undefined>;
  loaded: RefObject<number>;
  flashes: RefObject<Map<string, number>>;
  HEADER: number;
  nested: Record<string, string>;
  clipTypes: Record<string, string[]>;
  label: (clip: Clip) => string;
  /** Draws again: a thumbnail decoded. */
  redraw: () => void;
  dropHit: (clientX: number, clientY: number, item: PanelItem) => { clip: Clip; row: number; time: number } | undefined;
  mediaHit: (clientX: number, clientY: number, seconds: number) => { row?: number; track?: string; time: number; bad: boolean } | undefined;
}

/** Draws the timeline: everything but the playhead into a cached layer, redrawn only when what it shows changes. */
export function drawTimeline(t: TimelineDrawing) {
  const { canvas, latest, size, staticLayer, dragState, settling, snapLine, pickedDiamond, loaded, flashes, HEADER, nested, clipTypes, label, dropHit, mediaHit } = t;
  const drawRef = { current: t.redraw };
    const c = canvas.current;
    if (!c) return;
    const { project, session, waveforms, thumbs, marks } = latest.current;
    const tracks = [...project.tracks].reverse();
    const TRACK = session.timeline.trackHeight;
    const fps = rationalToNumber(project.settings.fps);
    const { w, h } = size.current;
    const TOP = Math.min(session.timeline.top ?? 0, maxTop(tracks.length, TRACK, h));
    const dpr = window.devicePixelRatio || 1;
    const { start, end } = session.timeline;
    const width = Math.max(1, w - HEADER);
    const pps = width / (end - start);
    const x = (t: number) => HEADER + (t - start) * pps;
    const shown = (t: Track, clip: Clip) =>
      shownSpan(ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration), t.clips.filter((c) => c !== clip).map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)] as const), 1 / pps);

    // Everything but the playhead is drawn into a cached layer, redrawn only when what it shows changes:
    // a playback tick then costs a copy and the playhead.
    const now = performance.now();
    for (const [id, at] of flashes.current) if (now - at > FLASH_MS) flashes.current.delete(id);
    const key = [project, waveforms, thumbs, latest.current.dragging, dragState.current, settling.current, loaded.current, w, h, dpr, session.selection, session.range, session.timeline, session.animation, session.group, session.track, flashes.current.size ? now : 0];
    const layer = staticLayer.current;
    if (!layer.canvas || layer.canvas.width !== c.width || layer.canvas.height !== c.height) {
      layer.canvas = document.createElement("canvas");
      layer.canvas.width = c.width;
      layer.canvas.height = c.height;
      layer.key = [];
    }
    if (layer.key.length !== key.length || key.some((k, i) => k !== layer.key[i])) {
      layer.key = key;
      drawStatic(layer.canvas.getContext("2d")!);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPlayhead(ctx);

    function drawStatic(ctx: CanvasRenderingContext2D) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = color("well");
    ctx.fillRect(0, 0, w, h);

    tracks.forEach((_, i) => {
      const y = rowTop(i, TRACK, TOP);
      ctx.fillStyle = color("well");
      ctx.fillRect(HEADER, y, width, TRACK);
      ctx.strokeStyle = color("track-line");
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK + 0.5);
      ctx.lineTo(w, y + TRACK + 0.5);
      ctx.stroke();
    });

    const d = dragState.current ?? settling.current?.drag;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER, RULER, width, h - RULER);
    ctx.clip();
    /**
     * A clip from `a` to `b` on row `i`: its colour, waveform or thumbnail, name and outline. `ghost`: where a move
     * would put it. `by`: how far it is drawn from where it is, its waveform and volume read where they are in it.
     */
    const drawClip = (clip: Clip, t: Track, i: number, a: number, b: number, alpha: number, ghost?: { bad: boolean; fresh: boolean }, by = 0) => {
      const { y, h: ch } = clipBox(i, TRACK, TOP);
      const audio = clip.type === "audio";
      const x0 = x(a) + 0.5;
      const cw = Math.max(1, (b - a) * pps - 1.5);
      const selected = session.selection.includes(clip.id);
      const teal = audio && selected;
      // A muted track's or clip's audio is drawn silent (faded, its waveform flat); its pictures are unaffected.
      const silent = audio && (!!t.muted || !!(clip.props.audio as { muted?: boolean } | undefined)?.muted);
      ctx.globalAlpha = (t.hidden || silent ? 0.4 : 1) * alpha * (t.locked ? 0.6 : 1);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, y, cw, ch, CLIP_RADIUS);
      const kind = kindColor(clip, nested, project);
      ctx.fillStyle = teal ? AUDIO_SELECTED.fill() : color(kind);
      ctx.fill();
      ctx.clip();
      let textX = x0 + 10;
      const tag = (clip.props.label as { color?: string | null } | undefined)?.color;
      if (audio) {
        if (teal && !tag) {
          ctx.fillStyle = AUDIO_SELECTED.top();
          ctx.fillRect(x0, y, cw, 2);
        }
        const peaks = clip.assetId ? waveforms[clip.assetId]?.[propsOf<{ stream: number }>(clip, "media").stream] : undefined;
        if (peaks) {
          ctx.fillStyle = teal ? AUDIO_SELECTED.wave() : CLIP.wave();
          const media0 = ticksToSeconds(clip.mediaStart ?? 0);
          const speed = clip.speed ? clip.speed.num / clip.speed.den : 1;
          // Drawn at the level it plays: boost times the volume line, so fades taper and a quiet clip looks quiet.
          const boost = propsOf<{ gain: number }>(clip, "audio").gain;
          for (let px = Math.max(x0, HEADER); px < Math.min(x0 + cw, w); px += 2) {
            const t = start + (px - HEADER) / pps;
            const m = media0 + (t - by - ticksToSeconds(clip.start)) * speed;
            const k = Math.floor(m * 100);
            let peak = 0;
            for (let j = k; j < k + Math.max(1, Math.ceil((2 / pps) * 100 * speed)); j++) peak = Math.max(peak, peaks[j] ?? 0);
            const hgt = silent ? 1 : Math.min(1, (peak / 255) * boost * volumeAt(clip, t - by)) * (ch - 6);
            ctx.fillRect(px, y + ch - hgt, 1.5, hgt);
          }
        }
      } else {
        const url = thumbs[clip.id];
        const img = url ? image(url, () => (loaded.current++, drawRef.current())) : undefined;
        if (img && cw > 40) {
          const th = ch - 10;
          const tw = (img.naturalWidth / img.naturalHeight) * th;
          ctx.drawImage(img, x0 + 6, y + 5, tw, th);
          textX = x0 + 6 + tw + 10;
        }
      }
      if (tag) {
        ctx.fillStyle = color(`label-${tag}`);
        ctx.fillRect(x0, y, cw, LABEL_H);
      }
      // Linked clips (a recording's screen, camera and audio) move and cut together: a chain says so, in the
      // top-left corner of each (over a video's thumbnail) so a recording's clips show it in the same place.
      if (clip.linkId && cw > 40) {
        ctx.fillStyle = CLIP.badge();
        ctx.beginPath();
        ctx.roundRect(x0 + 4, y + 4, 20, 18, 4);
        ctx.fill();
        ctx.fillStyle = CLIP.text();
        drawIcon(ctx, "link-simple-horizontal", x0 + 14, y + 13, 14);
        textX = Math.max(textX, x0 + 30);
      }
      if (cw > 24) {
        ctx.fillStyle = CLIP.text();
        ctx.font = font(13);
        ctx.textBaseline = audio ? "top" : "middle";
        ctx.fillText(label(clip), textX, audio ? y + 5 : y + ch / 2);
        ctx.textBaseline = "alphabetic";
      }
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x0, y, cw, ch, CLIP_RADIUS);
      if (ghost?.fresh) ctx.setLineDash([5, 4]);
      ctx.strokeStyle = ghost ? (ghost.bad ? INVALID() : SELECTED()) : selected ? SELECTED() : color(`${kind}-edge`);
      ctx.lineWidth = selected || ghost ? 2 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    tracks.forEach((t, i) => {
      for (const clip of t.clips) {
        let [a, b] = shown(t, clip);
        if (d?.kind === "trim" && d.edges.has(clip.id) && !d.extend) {
          [a, b] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
          if (d.edge === "start") a = d.edges.get(clip.id)!;
          else b = d.edges.get(clip.id)!;
        }
        // Shift-drag opens or closes time as it goes: what is after the point is drawn moved, a clip across it split.
        let by = 0;
        if (d?.kind === "space" && d.d !== 0 && (d.track ? d.track === t.id : !t.locked)) {
          [a, b] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
          if (a >= d.at) (by = d.d), (a += by), (b += by);
          else if (b > d.at) {
            if (a <= end && d.at >= start) drawClip(clip, t, i, a, d.at, 1);
            if (b + d.d >= start && d.at + d.d <= end) drawClip(clip, t, i, d.at + d.d, b + d.d, 1, undefined, d.d);
            continue;
          }
        }
        if (b < start || a > end) continue;
        drawClip(clip, t, i, a, b, d?.kind === "move" && d.moves.has(clip.id) ? 0.35 : 1, undefined, by);
      }
    });
    // Animation arrows across each clip, and the volume line on audio.
    tracks.forEach((t, i) => {
      const { y, h: ch } = clipBox(i, TRACK, TOP);
      for (const clip of t.clips) {
        const cs = ticksToSeconds(clip.start);
        const ce = ticksToSeconds(clip.start + clip.duration);
        const shifted = d?.kind === "space" && d.d !== 0 && (d.track ? d.track === t.id : !t.locked) ? d : undefined;
        // Drawn split while a shift-drag opens time across it: its marks wait for the drop.
        if (shifted && cs < shifted.at && ce > shifted.at) continue;
        const by = shifted && cs >= shifted.at ? shifted.d : 0;
        if (ce + by < start || cs + by > end) continue;
        // While an edge is dragged, what is drawn over the clip is cropped to it, and its fx badge rides the edge.
        const trim = d?.kind === "trim" && d.edges.has(clip.id) && !d.extend ? d : undefined;
        const [sa, sb] = shifted ? [cs, ce] : shown(t, clip);
        const left = trim?.edge === "start" ? trim.edges.get(clip.id)! : trim ? cs : sa;
        const right = trim && trim.edge !== "start" ? trim.edges.get(clip.id)! : trim ? ce : sb;
        ctx.save();
        ctx.translate(by * pps, 0);
        ctx.beginPath();
        ctx.rect(x(left), y, (right - left) * pps, ch);
        ctx.clip();
        const selectedClip = session.selection.includes(clip.id);
        if (clipTypes[clip.type]?.includes("audio")) {
          const vy = (v: number) => volumeY(i, TRACK, v, TOP);
          const pts = volumePoints(clip);
          ctx.strokeStyle = selectedClip ? VOLUME.selected() : VOLUME.line();
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x(cs), vy(volumeAt(clip, cs)));
          for (const p of pts) if (p.time > cs && p.time < ce) ctx.lineTo(x(p.time), vy(p.value));
          ctx.lineTo(x(ce), vy(volumeAt(clip, ce)));
          ctx.stroke();
          if (selectedClip) {
            ctx.fillStyle = VOLUME.selected();
            for (const p of pts) {
              ctx.beginPath();
              ctx.arc(x(p.time), vy(p.value), 3.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        // Stitched media: a column of grey zig-zag stitches at each join; a group: its tracks as thin bars.
        const traits = clipTypes[clip.type] ?? [];
        const own = innerTracks(clip, nested);
        const stitchTrack = traits.includes("stitched") ? own?.[0] : undefined;
        if (stitchTrack) {
          ctx.strokeStyle = STITCH();
          ctx.lineWidth = 1.5;
          ctx.lineCap = ctx.lineJoin = "round";
          const marks = Math.max(1, Math.floor((ch - 8) / 12));
          const top = y + (ch - marks * 12) / 2 + 2;
          for (const seg of stitchTrack.clips.slice(1)) {
            const tj = cs + ticksToSeconds(seg.start - (clip.mediaStart ?? 0));
            if (tj <= cs || tj >= ce) continue;
            const jx = Math.round(x(tj));
            ctx.beginPath();
            for (let m = 0; m < marks; m++) {
              const my = top + m * 12;
              ctx.moveTo(jx - 3.5, my);
              ctx.lineTo(jx + 3.5, my + 1.5);
              ctx.lineTo(jx - 3.5, my + 6.5);
              ctx.lineTo(jx + 3.5, my + 8);
            }
            ctx.stroke();
          }
          ctx.lineCap = "butt";
          ctx.lineJoin = "miter";
        }
        const groupTracks = traits.includes("group") ? own : undefined;
        if (groupTracks?.length && ch > 24) {
          const lanes = Math.min(groupTracks.length, 4);
          [...groupTracks].reverse().slice(0, lanes).forEach((gt, li) => {
            ctx.fillStyle = color("group-lane");
            for (const c of gt.clips) {
              const ta = cs + ticksToSeconds(c.start - (clip.mediaStart ?? 0));
              const tb = ta + ticksToSeconds(c.duration);
              ctx.fillRect(x(Math.max(cs, ta)), y + ch - 6 - (lanes - li) * 4, Math.max(1, (Math.min(ce, tb) - Math.max(cs, ta)) * pps - 1), 2);
            }
          });
        }
        for (const { anim, a, b } of arrows(clip)) {
          const on = session.animation?.clip === clip.id && session.animation.id === anim.id;
          drawArrow(ctx, x(a), x(b), y + ch / 2, ch, on, on && pickedDiamond.current?.anim === anim.id ? pickedDiamond.current.part : undefined);
        }
        // Effects are edited in the properties panel; the timeline marks the clip with Photoshop's "fx".
        if (clip.effects.length) {
          const age = flashes.current.get(clip.id);
          const pulse = age === undefined ? undefined : 0.55 + 0.45 * Math.abs(Math.sin(((now - age) / 400) * Math.PI));
          drawFxBadge(ctx, Math.min(x(right), w) - 6, y + 4, clip.effects.some((fx) => fx.enabled), pulse);
        }
        ctx.restore();
      }
    });
    // A panel item dragged over a clip that takes it: the clip is outlined (and where an animation would go).
    const over = latest.current.dragging;
    const drop = over && dropHit(over.x, over.y, over.item);
    if (over && drop) {
      const y = rowTop(drop.row, TRACK, TOP) + 3;
      const [cs, ce] = [ticksToSeconds(drop.clip.start), ticksToSeconds(drop.clip.start + drop.clip.duration)];
      ctx.beginPath();
      ctx.roundRect(x(cs) + 0.5, y, Math.max(1, (ce - cs) * pps - 1.5), TRACK - 6, CLIP_RADIUS);
      ctx.fillStyle = color("accent-wash");
      ctx.fill();
      ctx.strokeStyle = SELECTED();
      ctx.lineWidth = 2;
      ctx.stroke();
      if (over.item.timed) {
        const dur = Number(over.item.args.duration ?? 1);
        const a = Math.max(cs, Math.min(drop.time, ce - dur));
        ctx.globalAlpha = 0.6;
        drawArrow(ctx, x(a), x(Math.min(ce, a + dur)), y + (TRACK - 6) / 2, TRACK - 6, false);
        ctx.globalAlpha = 1;
      }
    }
    if (d?.kind === "track" && d.to !== d.from) {
      ctx.fillStyle = SELECTED();
      ctx.fillRect(0, rowTop(d.to > d.from ? d.to + 1 : d.to, TRACK, TOP) - 1, w, 2);
    }
    // A locked track is dimmed with diagonal lines.
    tracks.forEach((t, i) => {
      if (!t.locked) return;
      const y = rowTop(i, TRACK, TOP);
      ctx.save();
      ctx.beginPath();
      ctx.rect(HEADER, y, width, TRACK);
      ctx.clip();
      ctx.strokeStyle = color("locked-hatch");
      ctx.lineWidth = 2;
      for (let lx = HEADER - TRACK; lx < w; lx += 8) {
        ctx.beginPath();
        ctx.moveTo(lx, y + TRACK);
        ctx.lineTo(lx + TRACK, y);
        ctx.stroke();
      }
      ctx.restore();
    });
    // Where a drag would put things.
    const ghost = (a: number, b: number, i: number, label: string, bad?: boolean) => ghostRow(a, b, Math.max(0, i), label, i < 0, bad);
    /** `fresh`: on a track the drop makes, dashed. */
    const ghostRow = (a: number, b: number, row: number, label: string, fresh: boolean, bad?: boolean) => {
      const gy = clipBox(row, TRACK, TOP).y;
      if (fresh) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.roundRect(x(a) + 0.5, gy, Math.max(1, (b - a) * pps - 1.5), TRACK - 6, CLIP_RADIUS);
      ctx.fillStyle = color("clip-ghost");
      ctx.fill();
      ctx.strokeStyle = bad ? INVALID() : SELECTED();
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CLIP.text();
      ctx.font = font(13);
      ctx.textBaseline = "middle";
      ctx.fillText(label, x(a) + 10, gy + (TRACK - 6) / 2);
      ctx.textBaseline = "alphabetic";
    };
    if (d?.kind === "move") {
      // The clips themselves where they would land, waveforms and all, so they can be lined up by eye.
      project.tracks.forEach((t, ti) => {
        for (const clip of t.clips) {
          const rows = d.moves.get(clip.id);
          if (rows === undefined) continue;
          const a = ticksToSeconds(clip.start) + d.by;
          const row = project.tracks.length - 1 - (ti + rows);
          // Past the top or below the lowest track: on the new one there, dashed.
          drawClip(clip, t, Math.min(Math.max(0, row), project.tracks.length), a, a + ticksToSeconds(clip.duration), 0.9, { bad: !!d.error, fresh: row < 0 || row >= project.tracks.length }, d.by);
        }
      });
    } else if (d?.kind === "trim" && d.extend) {
      const ti = project.tracks.findIndex((t) => t.clips.some((c) => c.id === d.clip));
      const clip = project.tracks[ti]!.clips.find((c) => c.id === d.clip)!;
      // Before the start, or with room made (ripple), at the clip's start, the clip moving on after it.
      const s = ticksToSeconds(clip.start);
      const [a, b] = d.edge === "end" ? [ticksToSeconds(clip.start + clip.duration), d.t] : d.ripple ? [s, s + (s - d.t)] : [d.t, s];
      ghost(a, b, project.tracks.length - 1 - ti, `Frame of ${label(clip)}`);
    }
    if (d && snapLine.current !== undefined) {
      ctx.strokeStyle = SELECTED();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(snapLine.current)) + 0.5, RULER);
      ctx.lineTo(Math.round(x(snapLine.current)) + 0.5, h);
      ctx.stroke();
    }
    const media = over?.item.media && mediaHit(over.x, over.y, over.item.media.seconds);
    if (media) {
      const { seconds, layers } = over!.item.media!;
      const stack = layers?.length ? layers : [{ label: over!.item.label, seconds }];
      const t = media.time;
      if (media.row === undefined) {
        // No track under the pointer: each clip on a new track at the top, the last listed highest.
        stack.forEach((l, k) => ghostRow(t, t + l.seconds, stack.length - 1 - k, l.label, true));
      } else {
        // The first clip on the track under the pointer, the rest on the tracks above it; those past the top make new tracks.
        const fits = stack.slice(0, media.row + 1);
        const extra = stack.slice(media.row + 1);
        fits.forEach((l, k) => ghost(t, t + l.seconds, media.row! - k, l.label, media.bad && k === 0));
        if (extra.length) ghost(t, t + Math.max(...extra.map((l) => l.seconds)), -1, `New tracks: ${extra.map((l) => l.label).join(", ")}`);
      }
    }
    if (d?.kind === "marquee") {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color("text-dim");
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
    ctx.restore();

    ctx.fillStyle = color("ruler");
    ctx.fillRect(0, 0, w, RULER);
    const s = step(pps, fps);
    ctx.strokeStyle = color("ruler-tick");
    ctx.fillStyle = color("ruler-text");
    ctx.font = font(10);
    // Zoomed in, every frame shows: a short tick each, and its number (;ff) where there is room.
    const framePx = pps / fps;
    if (framePx >= FRAME_TICKS && s > 1 / fps) {
      for (let f = Math.ceil(start * fps); f <= end * fps; f++) {
        const px = Math.round(x(f / fps)) + 0.5;
        if (px < HEADER) continue;
        ctx.beginPath();
        ctx.moveTo(px, RULER - 4);
        ctx.lineTo(px, RULER);
        ctx.stroke();
        if (framePx >= FRAME_LABELS && f % Math.round(s * fps) !== 0) ctx.fillText(`;${String(f % Math.round(fps)).padStart(2, "0")}`, px + 3, RULER - 6);
      }
    }
    for (let t = Math.ceil(start / s) * s; t <= end; t += s) {
      const px = Math.round(x(t)) + 0.5;
      if (px < HEADER) continue;
      ctx.beginPath();
      ctx.moveTo(px, RULER - 8);
      ctx.lineTo(px, RULER);
      ctx.stroke();
      ctx.fillText(timecode(t, fps), px + 3, RULER - 12);
    }
    for (const m of project.markers) {
      const px = x(ticksToSeconds(m.time));
      if (px < HEADER) continue;
      ctx.fillStyle = color("marker");
      ctx.beginPath();
      ctx.moveTo(px, RULER - 10);
      ctx.lineTo(px + 5, RULER - 5);
      ctx.lineTo(px, RULER);
      ctx.lineTo(px - 5, RULER - 5);
      ctx.fill();
    }

    ctx.fillStyle = color("well");
    ctx.fillRect(0, 0, HEADER, h);
    tracks.forEach((t, i) => {
      const y = rowTop(i, TRACK, TOP);
      ctx.fillStyle = color("track-head");
      ctx.fillRect(0, y + 1, HEADER - 1, TRACK - 1);
      // The header Lock Track and Mute Track act on while nothing is selected.
      if (t.id === session.track && !session.selection.length) {
        ctx.fillStyle = color("accent-wash");
        ctx.fillRect(0, y + 1, HEADER - 1, TRACK - 1);
      }
      ctx.textBaseline = "middle";
      const icons = headerIcons(i, TRACK, HEADER, TOP);
      const ny = icons.magnet ? icons.eye[1] : y + TRACK / 2;
      // A name only when the track has one; otherwise its number, faint (Track N to agents and menus).
      if (shownName(t.name)) {
        ctx.fillStyle = t.hidden ? color("text-off") : color("text-strong");
        ctx.font = font(13, 600);
        ctx.fillText(fit(ctx, shownName(t.name), icons.mute[0] - 12 - 22), 12, ny);
      } else {
        ctx.fillStyle = color("text-off");
        ctx.font = font(11, 500);
        ctx.fillText(String(tracks.length - i), 12, ny);
      }
      // Mute, lock and eye (and the magnet on tall tracks): bright while on, dim while off.
      const icon = (name: IconName, [ix, iy]: [number, number], on: boolean, lit: string, dim: string) => {
        ctx.fillStyle = color(on ? lit : dim);
        drawIcon(ctx, name, ix, iy, 16, on && name !== "eye");
      };
      icon(t.muted ? "speaker-slash" : "speaker-high", icons.mute, !!t.muted, "wave", "head-icon");
      icon(t.locked ? "lock-simple" : "lock-simple-open", icons.lock, !!t.locked, "text-bright", "head-icon-off");
      icon(t.hidden ? "eye-slash" : "eye", icons.eye, !t.hidden, "head-icon", "head-icon-off");
      if (icons.magnet) icon("magnet", icons.magnet, !!t.magnetic, "text-bright", "text-disabled");
      ctx.textBaseline = "alphabetic";
    });

    // The corner above the headers: track height slider and magnifier, add-track and options buttons.
    ctx.fillStyle = color("panel");
    ctx.fillRect(0, 0, HEADER, RULER);
    const knob = HEIGHT_SLIDER.bottom - ((TRACK - TRACK_HEIGHT.min) / (TRACK_HEIGHT.max - TRACK_HEIGHT.min)) * (HEIGHT_SLIDER.bottom - HEIGHT_SLIDER.top);
    ctx.fillStyle = color("groove");
    ctx.fillRect(HEIGHT_SLIDER.x - 2, HEIGHT_SLIDER.top, 4, HEIGHT_SLIDER.bottom - HEIGHT_SLIDER.top);
    ctx.fillStyle = color("text-strong");
    ctx.beginPath();
    ctx.arc(HEIGHT_SLIDER.x, knob, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color("text-muted");
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(33, 20, 3, 0, Math.PI * 2);
    ctx.moveTo(35, 22);
    ctx.lineTo(37, 24);
    ctx.moveTo(33, 7);
    ctx.lineTo(33, 13);
    ctx.moveTo(31, 9);
    ctx.lineTo(33, 7);
    ctx.lineTo(35, 9);
    ctx.moveTo(33, 27);
    ctx.lineTo(33, 33);
    ctx.moveTo(31, 31);
    ctx.lineTo(33, 33);
    ctx.lineTo(35, 31);
    ctx.stroke();
    for (const b of cornerButtons(HEADER)) {
      const glyph = b.id === "add" ? "+" : "⌄";
      ctx.fillStyle = color("tile");
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 4);
      ctx.fill();
      ctx.fillStyle = color("text-strong");
      ctx.font = font(13, "bold");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, b.x + b.w / 2, b.y + (glyph === "+" ? 8 : 5));
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    }

    function drawPlayhead(ctx: CanvasRenderingContext2D) {
    // One colour, as CapCut, Premiere and Resolve: a pin-shaped head on the ruler over a thin line, its timecode beside it.
    const space = dragState.current?.kind === "space" && dragState.current.playhead ? dragState.current : undefined;
    const playhead = space ? space.at + space.d : session.playhead;
    const ph = x(playhead);
    // Zoomed in, the frame on show is a band from the playhead to the next frame.
    if (pps / fps >= FRAME_SHADE) {
      ctx.fillStyle = color("frame-shade");
      ctx.fillRect(ph, RULER, pps / fps, h - RULER);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER, 0, w - HEADER, h);
    ctx.clip();
    if (session.range) {
      // The in/out range: a band on the ruler and a light tint over the tracks, its edges brackets dragged on the ruler.
      const [a, b] = [x(session.range.in), x(session.range.out)];
      ctx.fillStyle = color("range-ruler");
      ctx.fillRect(a, 0, b - a, RULER);
      ctx.fillStyle = color("range-band");
      ctx.fillRect(a, RULER, b - a, h - RULER);
      ctx.fillStyle = color("range-edge");
      for (const [ex, dir] of [[a, 1], [b, -1]] as const) {
        const lx = Math.round(ex) - (dir > 0 ? 0 : 1);
        ctx.fillRect(lx, 0, 1.5, h);
        ctx.fillRect(dir > 0 ? lx : lx - RANGE_TAB + 1.5, 0, RANGE_TAB, 2);
        ctx.fillRect(dir > 0 ? lx : lx - RANGE_TAB + 1.5, RULER - 2, RANGE_TAB, 2);
      }
    }
    for (const m of marks ?? []) {
      const [a, b] = [x(m.start), x(m.end)];
      if (b < HEADER || a > w) continue;
      ctx.fillStyle = color(m.tone === "cut" ? "silence-cut" : m.tone === "take" ? "take-kept" : "silence-keep");
      ctx.fillRect(a, RULER, Math.max(1, b - a), h - RULER);
      ctx.fillRect(a, RULER - 4, Math.max(1, b - a), 4);
      if (m.current) {
        ctx.strokeStyle = color("accent");
        ctx.lineWidth = 2;
        ctx.strokeRect(a - 1, RULER - 3, Math.max(1, b - a) + 2, h - RULER + 2);
      }
    }
    const drag = dragState.current;
    const dragged = drag?.kind === "volume" && drag.at ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === drag.clip) : undefined;
    if (drag?.kind === "volume" && drag.at && dragged) {
      // The level being dragged, as a percentage beside the pointer.
      const level = drag.index === null ? volumeAt(dragged, start + (drag.at[0] - HEADER) / pps) : (volumePoints(dragged)[drag.index]?.value ?? 0);
      const text = `${Math.round(level * 100)}%`;
      ctx.font = font(11);
      const tw = ctx.measureText(text).width + 12;
      const [lx, ly] = [Math.min(drag.at[0] + 12, w - tw - 4), Math.max(RULER + 2, drag.at[1] - 26)];
      ctx.fillStyle = color("chip");
      ctx.beginPath();
      ctx.roundRect(lx, ly, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = color("text-strong");
      ctx.fillText(text, lx + 6, ly + 13);
    }
    if (ph >= HEADER - 12 && ph <= w + 12) {
      const cx = Math.round(ph) + 0.5;
      ctx.fillStyle = color("text-bright");
      ctx.fillRect(cx - 0.5, PIN_H, 1, h - PIN_H);
      ctx.beginPath();
      ctx.roundRect(cx - PIN_W / 2, 3, PIN_W, PIN_H - 7, 3);
      ctx.moveTo(cx - PIN_W / 2 + 1, PIN_H - 5);
      ctx.lineTo(cx, PIN_H);
      ctx.lineTo(cx + PIN_W / 2 - 1, PIN_H - 5);
      ctx.closePath();
      ctx.fill();
      // White on the ruler's own colour, as Camtasia's: the ruler's labels underneath don't run into it.
      const text = timecode(playhead, fps);
      ctx.font = font(12, 600);
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = color("ruler");
      ctx.fillRect(cx + PIN_W / 2 + 2, 2, tw + 8, 17);
      ctx.fillStyle = color("text-bright");
      ctx.fillText(text, cx + PIN_W / 2 + 6, 15);
    }
    ctx.restore();
    }
}
