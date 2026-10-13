import { useEffect, useRef } from "react";
import {
  animatedValue,
  assetName,
  trackName,
  clipSpeed,
  editScope,
  scopedProject,
  envelopePoints,
  mediaTimeAt,
  planMove,
  trimBounds,
  rationalToNumber,
  secondsToTicks,
  snapOffset,
  snapTargets,
  ticksToSeconds,
  TRACK_HEIGHT,
  type Animation,
  type Clip,
  type Project,
  type Session,
  type Track,
} from "@beacon/model";
import { addDropTarget, droppedFiles, takes, type DropTarget, type PanelItem } from "./drop";
import type { DroppedFile } from "./rpc";
import { drawIcon, type IconName } from "./controls";
import { arrowHalfHeight, clipBox, cornerButtonAt, cornerButtons, drawArrow, drawFxBadge, EDGE, GRAB, headerIcons, headerWidth, shownName, HEIGHT_SLIDER, PIN_H, PIN_W, RANGE_TAB, rangeEdgeAt, RULER, rowTop, SNAP, volumeY } from "./timeline-layout";
import { replica, useView } from "./store";
import { color, font } from "./theme";
import { timecode } from "./time";

const INVALID = () => color("invalid");

type PressDrag = { kind: "press"; clip: string; x0: number; y0: number; toggle: boolean; ripple: boolean };
/** `moves`: every clip that moves (with a ripple, those after it too) → tracks up. */
type MoveDrag = { kind: "move"; ids: string[]; moves: Map<string, number>; by: number; rows: number; ripple: boolean; error?: string; x0: number; y0: number };
type Drag =
  | { kind: "playhead" }
  | { kind: "height" }
  | { kind: "track"; track: string; from: number; to: number }
  | { kind: "anim"; clip: string; anim: string; part: "start" | "end" | "body"; x0: number; a: number; b: number; key: string }
  | { kind: "volume"; clip: string; index: number | null; x0: number; y0: number; points: { time: number; value: number }[]; base: number; key: string; at?: [number, number] }
  | { kind: "range"; anchor: number }
  | { kind: "rangeEdge"; edge: "in" | "out"; other: number }
  | { kind: "space"; at: number; d: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; base: string[] }
  | PressDrag
  | MoveDrag
  | { kind: "trim"; clip: string; edge: "start" | "end"; x0: number; t: number; ripple: boolean; extend: boolean };

const status = (text: string) => replica.status(text);

/**
 * What the timeline shows: the project, or with a group open (its
 * group tab) its tracks at main-timeline times, the times commands take.
 */
export function timelineView(project: Project, session: Session, nested: Record<string, string>): { project: Project; group?: Clip } {
  const scope = editScope(project, session.group, (c) => innerTracks(c, nested));
  return { project: scopedProject(project, scope), group: scope.group };
}

/** Timeline seconds of a media time in a clip. */
const onTimeline = (c: Clip, media: number) => ticksToSeconds(c.start + (media - (c.mediaStart ?? 0)) / clipSpeed(c));

/** The clip's visual animation blocks as timeline spans; audio volume points are drawn as a line instead. */
function arrows(c: Clip): { anim: Animation; a: number; b: number }[] {
  return c.animations
    .filter((a) => Object.keys(a.to).some((k) => !k.startsWith("audio.")))
    .map((anim) => ({ anim, a: onTimeline(c, anim.end - anim.duration), b: onTimeline(c, anim.end) }));
}

/** How long a clip's fx badge flashes after an effect is added to it. */
const FLASH_MS = 1600;

/** A clip's audio points on the timeline (seconds, gain), as the volume feature reads them. */
function volumePoints(c: Clip): { time: number; value: number }[] {
  const base = Number((c.props.audio as { volume?: number } | undefined)?.volume ?? 1);
  return envelopePoints(base, c.animations, "audio.volume").map((p) => ({ time: onTimeline(c, p.time), value: p.value }));
}

function volumeAt(c: Clip, t: number): number {
  return Number(animatedValue((c.props.audio as { volume?: number } | undefined)?.volume ?? 1, "audio.volume", c.animations, mediaTimeAt(c, secondsToTicks(t))));
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
const CLIP = { text: () => color("text-bright"), wave: () => color("wave") };
const KIND: Record<string, string> = { screen: "clip-screen", video: "clip-screen", image: "clip-screen", still: "clip-screen", audio: "clip-audio", callout: "clip-annotation", region: "clip-annotation" };

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
const STITCH = () => color("stitch");

interface Props {
  project: Project;
  session: Session;
  waveforms: Record<string, Record<number, number[]>>;
  thumbs: Record<string, string>;
  clipTypes: Record<string, string[]>;
  /** Clip type → the prop group holding its own tracks. */
  nested: Record<string, string>;
  run: (command: string, args?: unknown, label?: string, coalesce?: string) => void;
  /** The right-click menu for a clip, shown natively by the main process. */
  menu: (clip: string) => void;
  /** A track's menu (Insert Track, Rename…, Lock…), or with null the track options under ⌄. */
  trackMenu: (track: string | null) => void;
  /** Files dragged in from Finder, dropped at a time (and on a track). */
  dropFiles: (files: DroppedFile[], at: { time: number; track?: string }) => void;
}

const images = new Map<string, HTMLImageElement>();

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
function clipLabel(project: Project, clip: Clip, nested: Record<string, string>, traits: string[] = []): string {
  if (traits.includes("group")) return "Group";
  // Stitched media is named after the recording its pieces come from.
  const inner = innerTracks(clip, nested)?.[0]?.clips[0];
  const asset = project.assets[clip.assetId ?? inner?.assetId ?? ""];
  if (asset) return assetName(asset);
  // Annotations say what they are: a text callout its text, the rest their shape or kind.
  const callout = clip.props.callout as { shape?: string; text?: { text?: string } } | undefined;
  if (callout?.shape === "text") return callout.text?.text?.split("\n")[0]?.trim() || "Text";
  if (callout?.shape) return callout.shape === "rectangle" ? "Shape" : callout.shape[0]!.toUpperCase() + callout.shape.slice(1);
  const region = (clip.props.region as { kind?: string } | undefined)?.kind;
  if (region) return region[0]!.toUpperCase() + region.slice(1);
  return clip.type;
}

/**
 * The timeline, drawn on a canvas (PLAN §10). Drags draw a ghost and send
 * one command when they end, so each is one undo step.
 */
export function Timeline({ project: full, session, waveforms, thumbs, clipTypes, nested, run, menu, trackMenu, dropFiles }: Props) {
  const { project } = timelineView(full, session, nested);
  const HEADER = headerWidth(project.tracks);
  const label = (clip: Clip) => clipLabel(project, clip, nested, clipTypes[clip.type]);
  const renaming = useView((s) => s.renaming);
  const dragging = useView((s) => s.dragging);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const dragState = useRef<Drag | null>(null);
  /** Where the dragged edge last snapped (seconds), drawn as a line while the drag lasts. */
  const snapLine = useRef<number | undefined>(undefined);
  /** The animation diamond last clicked (drawn red while its animation is selected). */
  const pickedDiamond = useRef<{ anim: string; part: "start" | "end" } | undefined>(undefined);
  // Selecting another animation, or none, from anywhere (Properties, undo) forgets it.
  useEffect(() => {
    if (pickedDiamond.current?.anim !== session.animation?.id) pickedDiamond.current = undefined;
  }, [session.animation?.id]);
  const pending = useRef(0);
  const latest = useRef({ project, session, waveforms, thumbs, dragging });
  const staticLayer = useRef<{ canvas?: HTMLCanvasElement; key: unknown[] }>({ key: [] });
  /** Counts thumbnails decoded, so the cached layer is redrawn with them. */
  const loaded = useRef(0);
  /** When each clip last had an effect added, for its badge's flash. */
  const flashes = useRef(new Map<string, number>());
  const effectCounts = useRef<Map<string, number> | null>(null);
  latest.current = { project, session, waveforms, thumbs, dragging };

  const tracks = [...project.tracks].reverse();
  const TRACK = session.timeline.trackHeight;

  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const { project, session, waveforms, thumbs } = latest.current;
    const tracks = [...project.tracks].reverse();
    const TRACK = session.timeline.trackHeight;
    const fps = rationalToNumber(project.settings.fps);
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const { start, end } = session.timeline;
    const width = Math.max(1, w - HEADER);
    const pps = width / (end - start);
    const x = (t: number) => HEADER + (t - start) * pps;

    // Everything but the playhead is drawn into a cached layer, redrawn only when what it shows changes:
    // a playback tick then costs a copy and the playhead.
    const now = performance.now();
    for (const [id, at] of flashes.current) if (now - at > FLASH_MS) flashes.current.delete(id);
    const key = [project, waveforms, thumbs, latest.current.dragging, dragState.current, loaded.current, w, h, dpr, session.selection, session.range, session.timeline, session.animation, session.group, flashes.current.size ? now : 0];
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

    tracks.forEach((t, i) => {
      const y = RULER + i * TRACK;
      ctx.fillStyle = color("well");
      ctx.fillRect(HEADER, y, width, TRACK);
      ctx.strokeStyle = color("track-line");
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK + 0.5);
      ctx.lineTo(w, y + TRACK + 0.5);
      ctx.stroke();
    });

    const d = dragState.current;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER, RULER, width, h - RULER);
    ctx.clip();
    tracks.forEach((t, i) => {
      const { y, h: ch } = clipBox(i, TRACK);
      for (const clip of t.clips) {
        let a = ticksToSeconds(clip.start);
        let b = ticksToSeconds(clip.start + clip.duration);
        if (d?.kind === "trim" && d.clip === clip.id && !d.extend) {
          if (d.edge === "start") a = d.t;
          else b = d.t;
        }
        if (b < start || a > end) continue;
        const audio = clip.type === "audio";
        const x0 = x(a) + 0.5;
        const cw = Math.max(1, (b - a) * pps - 1.5);
        const selected = session.selection.includes(clip.id);
        const teal = audio && selected;
        ctx.globalAlpha = (t.hidden ? 0.4 : 1) * (d?.kind === "move" && d.moves.has(clip.id) ? 0.35 : 1) * (t.locked ? 0.6 : 1);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x0, y, cw, ch, CLIP_RADIUS);
        const kind = kindColor(clip, nested, project);
        ctx.fillStyle = teal ? AUDIO_SELECTED.fill() : color(kind);
        ctx.fill();
        ctx.clip();
        let textX = x0 + 10;
        if (audio) {
          if (teal) {
            ctx.fillStyle = AUDIO_SELECTED.top();
            ctx.fillRect(x0, y, cw, 2);
          }
          const peaks = clip.assetId ? waveforms[clip.assetId]?.[Number((clip.props.media as { stream?: number } | undefined)?.stream ?? 0)] : undefined;
          if (peaks) {
            ctx.fillStyle = teal ? AUDIO_SELECTED.wave() : CLIP.wave();
            const media0 = ticksToSeconds(clip.mediaStart ?? 0);
            const speed = clip.speed ? clip.speed.num / clip.speed.den : 1;
            // Drawn at the level it plays: boost times the volume line, so fades taper and a quiet clip looks quiet.
            const boost = Number((clip.props.audio as { gain?: number } | undefined)?.gain ?? 1);
            for (let px = Math.max(x0, HEADER); px < Math.min(x0 + cw, w); px += 2) {
              const t = start + (px - HEADER) / pps;
              const m = media0 + (t - a) * speed;
              const k = Math.floor(m * 100);
              let peak = 0;
              for (let j = k; j < k + Math.max(1, Math.ceil((2 / pps) * 100 * speed)); j++) peak = Math.max(peak, peaks[j] ?? 0);
              const hgt = Math.min(1, (peak / 255) * boost * volumeAt(clip, t)) * (ch - 6);
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
        // Linked clips (a recording's screen, camera and audio) move and cut together: a chain before the name says so.
        if (clip.linkId && cw > 40) {
          ctx.fillStyle = CLIP.text();
          drawIcon(ctx, "link-simple-horizontal", textX + 7, audio ? y + 12 : y + ch / 2, 14);
          textX += 18;
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
        ctx.strokeStyle = selected ? SELECTED() : color(`${kind}-edge`);
        ctx.lineWidth = selected ? 2 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
    // Animation arrows across each clip, and the volume line on audio.
    tracks.forEach((t, i) => {
      const { y, h: ch } = clipBox(i, TRACK);
      for (const clip of t.clips) {
        const cs = ticksToSeconds(clip.start);
        const ce = ticksToSeconds(clip.start + clip.duration);
        if (ce < start || cs > end) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x(cs), y, (ce - cs) * pps, ch);
        ctx.clip();
        const selectedClip = session.selection.includes(clip.id);
        if (clipTypes[clip.type]?.includes("audio")) {
          const vy = (v: number) => volumeY(i, TRACK, v);
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
          drawFxBadge(ctx, Math.min(x(ce), w) - 6, y + 4, clip.effects.some((fx) => fx.enabled), pulse);
        }
        ctx.restore();
      }
    });
    // A panel item dragged over a clip that takes it: the clip is outlined (and where an animation would go).
    const over = latest.current.dragging;
    const drop = over && dropHit(over.x, over.y, over.item);
    if (over && drop) {
      const y = RULER + drop.row * TRACK + 3;
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
      ctx.fillRect(0, RULER + (d.to > d.from ? d.to + 1 : d.to) * TRACK - 1, w, 2);
    }
    // A locked track is dimmed with diagonal lines.
    tracks.forEach((t, i) => {
      if (!t.locked) return;
      const y = RULER + i * TRACK;
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
    const ghost = (a: number, b: number, i: number, label: string, bad?: boolean) => {
      const gy = RULER + Math.max(0, i) * TRACK + 3;
      // Above the top track: the drop makes a new track.
      if (i < 0) ctx.setLineDash([5, 4]);
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
      project.tracks.forEach((t, ti) => {
        for (const clip of t.clips) {
          const rows = d.moves.get(clip.id);
          if (rows === undefined) continue;
          const a = ticksToSeconds(clip.start) + d.by;
          ghost(a, a + ticksToSeconds(clip.duration), project.tracks.length - 1 - (ti + rows), label(clip), !!d.error);
        }
      });
    } else if (d?.kind === "trim" && d.extend) {
      const ti = project.tracks.findIndex((t) => t.clips.some((c) => c.id === d.clip));
      const clip = project.tracks[ti]!.clips.find((c) => c.id === d.clip)!;
      ghost(ticksToSeconds(clip.start + clip.duration), d.t, project.tracks.length - 1 - ti, `Frame of ${label(clip)}`);
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
    if (media) ghost(media.time, media.time + over!.item.media!.seconds, media.row ?? -1, over!.item.label, media.bad);
    if (d?.kind === "marquee") {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color("text-dim");
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    } else if (d?.kind === "space" && d.d > 0) {
      ctx.fillStyle = color("insert-space");
      ctx.fillRect(x(d.at), RULER, d.d * pps, h - RULER);
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
      const y = RULER + i * TRACK;
      ctx.fillStyle = color("track-head");
      ctx.fillRect(0, y + 1, HEADER - 1, TRACK - 1);
      ctx.textBaseline = "middle";
      const icons = headerIcons(i, TRACK, HEADER);
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
      icon(t.muted ? "speaker-slash" : "speaker-high", icons.mute, !!t.muted, "text-bright", "head-icon");
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
    const ph = x(session.playhead);
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
      ctx.fillStyle = color("text-muted");
      ctx.font = font(11);
      ctx.fillText(timecode(session.playhead, fps), cx + PIN_W / 2 + 6, 14);
    }
    ctx.restore();
    }
  };

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      const c = canvas.current!;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(draw);
  // Callbacks registered once (the resize observer, thumbnail loads) must draw with the latest render's data.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // An effect added to a clip flashes its fx badge, redrawn each frame until it fades.
  useEffect(() => {
    const counts = new Map(project.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.effects.length] as const)));
    const before = effectCounts.current;
    effectCounts.current = counts;
    if (!before) return;
    const grew = [...counts].filter(([id, n]) => n > (before.get(id) ?? 0)).map(([id]) => id);
    if (!grew.length) return;
    for (const id of grew) flashes.current.set(id, performance.now());
    let frame = 0;
    const tick = () => {
      drawRef.current();
      if (flashes.current.size) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [project]);

  // Escape drops a drag that has only drawn a ghost so far: nothing is sent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dragState.current;
      if (e.key !== "Escape" || !d || !["press", "move", "trim", "space", "track"].includes(d.kind)) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = null;
      snapLine.current = undefined;
      drawRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const { start, end } = latest.current.session.timeline;
    return Math.max(0, start + ((clientX - r.left - HEADER) / Math.max(1, r.width - HEADER)) * (end - start));
  };

  /** Seconds per screen point. */
  const spp = () => {
    const { start, end } = latest.current.session.timeline;
    return (end - start) / Math.max(1, size.current.w - HEADER);
  };

  const xOf = (t: number) => {
    const { start } = latest.current.session.timeline;
    return HEADER + (t - start) / spp();
  };

  const clipAt = (clientX: number, clientY: number): Clip | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const i = Math.floor((clientY - r.top - RULER) / TRACK);
    const t = tracks[i];
    if (!t) return undefined;
    const ticks = timeAt(clientX);
    return t.clips.find((c) => ticksToSeconds(c.start) <= ticks && ticks < ticksToSeconds(c.start + c.duration));
  };

  /** The clip a panel item dropped at a point would go on: one that takes it, on an unlocked track. */
  const dropHit = (clientX: number, clientY: number, item: PanelItem) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || clientX < r.left + HEADER || clientX > r.right || clientY > r.bottom) return undefined;
    const row = rowAt(clientY - r.top);
    const clip = row === undefined || tracks[row]!.locked ? undefined : clipAt(clientX, clientY);
    return clip && takes(item, clipTypes[clip.type]) ? { clip, row: row!, time: timeAt(clientX) } : undefined;
  };
  /** Where Media Bin media dropped at a point would go: its start at the pointer on that track (none: new tracks), refused over other media. */
  const mediaHit = (clientX: number, clientY: number, seconds: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || latest.current.session.group || clientX < r.left + HEADER || clientX > r.right || clientY < r.top + RULER || clientY > r.bottom) return undefined;
    const row = rowAt(clientY - r.top);
    const time = timeAt(clientX);
    const t = row === undefined ? undefined : tracks[row]!;
    const [a, b] = [secondsToTicks(time), secondsToTicks(time + seconds)];
    const bad = !!t && (t.locked || (!t.magnetic && t.clips.some((c) => c.start < b && c.start + c.duration > a)));
    return { row, track: t?.id, time, bad };
  };
  const dropRef = useRef<DropTarget>(undefined);
  dropRef.current = (cx, cy, item) => {
    if (item.media) return ((h) => (h && !h.bad ? { time: h.time, ...(h.track ? { track: h.track } : {}) } : undefined))(mediaHit(cx, cy, item.media.seconds));
    return ((h) => h && { clip: h.clip.id, time: h.time })(dropHit(cx, cy, item));
  };
  useEffect(() => addDropTarget((...a) => dropRef.current!(...a)), []);

  /** The track row under a point (display order: top first), if any. */
  const rowAt = (y: number): number | undefined => {
    const i = Math.floor((y - RULER) / TRACK);
    return y > RULER && i >= 0 && i < tracks.length ? i : undefined;
  };

  /** The header icon under a point: mute, lock and eye, and on tall tracks the magnet (see the drawing). */
  const headerIcon = (x: number, y: number, i: number): "eye" | "magnet" | "lock" | "mute" | undefined => {
    const icons = headerIcons(i, TRACK, HEADER);
    const near = ([ix, iy]: [number, number]) => Math.abs(x - ix) <= 9 && Math.abs(y - iy) <= 8;
    if (near(icons.eye)) return "eye";
    if (near(icons.lock)) return "lock";
    if (near(icons.mute)) return "mute";
    if (icons.magnet && near(icons.magnet)) return "magnet";
    return undefined;
  };

  /** An animation arrow under the pointer (anywhere across its head's height), and which part: its start or end (to change its length) or its body (to move it). */
  const arrowAt = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowAt(py);
    if (i === undefined) return undefined;
    const box = clipBox(i, TRACK);
    const ay = box.y + box.h / 2;
    for (const clip of tracks[i]!.clips) {
      // Only the part of an arrow inside its clip is drawn, so only that part is grabbed.
      const [cx0, cx1] = [xOf(ticksToSeconds(clip.start)), xOf(ticksToSeconds(clip.start + clip.duration))];
      if (px < cx0 || px > cx1) continue;
      for (const { anim, a, b } of arrows(clip)) {
        const [xa, xb] = [xOf(a), xOf(b)];
        if (px < xa - 6 || px > xb + 6) continue;
        if (Math.abs(py - ay) > Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6) + 2)) continue;
        const grab = Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6));
        const part: "start" | "end" | "body" = Math.abs(px - xa) <= grab ? "start" : Math.abs(px - xb) <= grab ? "end" : "body";
        return { clip, anim, a, b, part };
      }
    }
    return undefined;
  };

  /** On a selected audio clip: the volume point under the pointer (its index), or the line itself. */
  const volumeHit = (clip: Clip, clientX: number, clientY: number): { index: number | null } | undefined => {
    const { session } = latest.current;
    if (!session.selection.includes(clip.id) || !clipTypes[clip.type]?.includes("audio")) return undefined;
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowAt(py)!;
    const vy = (v: number) => volumeY(i, TRACK, v);
    // Points beyond the clip's edges aren't drawn, so they aren't grabbed either.
    const [cs, ce] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
    const pts = volumePoints(clip);
    const index = pts.findIndex((p) => p.time >= cs && p.time <= ce && Math.hypot(xOf(p.time) - px, vy(p.value) - py) <= 6);
    if (index >= 0) return { index };
    return Math.abs(vy(volumeAt(clip, timeAt(clientX))) - py) <= 4 ? { index: null } : undefined;
  };

  /** The edge of `clip` under the pointer, if it is wide enough to have grabbable edges. */
  const edgeAt = (clip: Clip, clientX: number): "start" | "end" | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const px = clientX - r.left;
    const a = xOf(ticksToSeconds(clip.start));
    const b = xOf(ticksToSeconds(clip.start + clip.duration));
    if (b - a < 3 * EDGE) return undefined;
    if (px - a <= EDGE) return "start";
    if (b - px <= EDGE) return "end";
    return undefined;
  };

  /** Snaps `edges` (seconds) by the smallest shift onto a snap target, unless snapping is off or Control is held. */
  const snapped = (edges: number[], exclude: Set<string>, ctrl: boolean): number => {
    const { project, session } = latest.current;
    snapLine.current = undefined;
    if (!session.snapping || ctrl) return 0;
    const targets = snapTargets(project, {
      playhead: secondsToTicks(session.playhead),
      range: session.range ? [secondsToTicks(session.range.in), secondsToTicks(session.range.out)] : undefined,
      exclude,
    }).map(ticksToSeconds);
    const by = snapOffset(edges, targets, SNAP * spp());
    if (by !== undefined) snapLine.current = targets.find((t) => edges.some((e) => Math.abs(e + by - t) < 1e-9));
    return by ?? 0;
  };

  const setHeight = (clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const f = (HEIGHT_SLIDER.bottom - (clientY - r.top)) / (HEIGHT_SLIDER.bottom - HEIGHT_SLIDER.top);
    run("timeline.trackHeight", { height: Math.min(TRACK_HEIGHT.max, Math.max(TRACK_HEIGHT.min, TRACK_HEIGHT.min + f * (TRACK_HEIGHT.max - TRACK_HEIGHT.min))) });
  };

  /** Session commands while dragging go out at most once a frame. */
  const throttled = (command: string, args: unknown, label?: string, key?: string) => {
    cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => run(command, args, label, key));
  };

  const scrub = (clientX: number) => throttled("playhead.set", { time: timeAt(clientX) });

  const pointer = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** A move of `ids` by `by` seconds and `rows` tracks up, checked as the command will check it. */
  const planned = (ids: string[], by: number, rows: number, ripple: boolean): MoveDrag => {
    const { project } = latest.current;
    const moves = new Map(ids.map((id) => [id, ripple ? 0 : rows]));
    if (ripple) {
      for (const t of project.tracks) {
        const mine = t.clips.filter((c) => moves.has(c.id));
        if (!mine.length) continue;
        const from = Math.min(...mine.map((c) => c.start));
        for (const c of t.clips) if (c.start >= from) moves.set(c.id, 0);
      }
    }
    const plan = planMove(project.tracks, moves, secondsToTicks(by));
    return { kind: "move", ids, moves, by, rows: ripple ? 0 : rows, ripple, error: plan.error, x0: 0, y0: 0 };
  };

  const startMove = (press: PressDrag, e: React.PointerEvent) => {
    const { session } = latest.current;
    const ids = session.selection.includes(press.clip) ? session.selection : press.ripple ? [...session.selection, press.clip] : [press.clip];
    dragState.current = { ...planned(ids, 0, 0, press.ripple), x0: press.x0, y0: press.y0 };
    updateMove(e);
  };

  const updateMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (d?.kind !== "move") return;
    const { project } = latest.current;
    const { x, y } = pointer(e);
    const moving = project.tracks.flatMap((t) => t.clips).filter((c) => d.moves.has(c.id));
    // Inside an opened group, clips can't go before the group's own start.
    const earliest = Math.min(...moving.map((c) => ticksToSeconds(c.start)));
    let by = Math.max(-earliest, (x - d.x0) * spp());
    const edges = moving.flatMap((c) => [ticksToSeconds(c.start) + by, ticksToSeconds(c.start + c.duration) + by]);
    by = Math.max(-earliest, by + snapped(edges, new Set(d.moves.keys()), e.ctrlKey));
    // Whole frames, as the command moves, so the ghost checks what will happen.
    const frame = 1 / rationalToNumber(project.settings.fps);
    by = Math.sign(by) * Math.round(Math.abs(by) / frame) * frame;
    const rows = -Math.round((y - d.y0) / TRACK);
    dragState.current = { ...planned(d.ids, by, rows, d.ripple), x0: d.x0, y0: d.y0 };
    draw();
  };

  const finish = (e: React.PointerEvent) => {
    const d = dragState.current;
    dragState.current = null;
    snapLine.current = undefined;
    if (canvas.current!.hasPointerCapture(e.pointerId)) canvas.current!.releasePointerCapture(e.pointerId);
    if (!d) return;
    const { session } = latest.current;
    if (d.kind === "track") {
      // Display rows run top to bottom; tracks are stored bottom to top.
      if (d.to !== d.from) run("track.move", { track: d.track, index: tracks.length - 1 - d.to }, "Move Track");
    } else if (d.kind === "press") {
      run("selection.set", d.toggle ? { clips: [d.clip], toggle: true, linked: true } : { clips: [d.clip], linked: true });
    } else if (d.kind === "move") {
      if (d.error) return void (draw(), status(`Can't move there: ${d.error}`));
      if (Math.abs(d.by) > 1e-9 || d.rows) run("clip.move", { clips: d.ids, by: d.by, tracks: d.rows, linked: true, ripple: d.ripple }, "Move Media");
    } else if (d.kind === "trim") {
      const clip = latest.current.project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clip)!;
      const end = ticksToSeconds(clip.start + clip.duration);
      if (d.extend) {
        if (d.t > end) run("clip.extendFrame", { clip: d.clip, duration: d.t - end, ripple: d.ripple }, "Extend Frame");
      } else if (Math.abs(d.t - (d.edge === "start" ? ticksToSeconds(clip.start) : end)) > 1e-9) {
        run("clip.trim", { clip: d.clip, [d.edge]: d.t, linked: true, ripple: d.ripple }, "Trim Media");
      }
    } else if (d.kind === "space") {
      if (d.d > 0) run("timeline.insertSpace", { at: d.at, duration: d.d }, "Ripple Split");
    } else if (d.kind === "range" || d.kind === "rangeEdge") {
      if (!session.range) run("range.clear");
    }
    draw();
  };

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas
        ref={canvas}
        data-timeline
        className="absolute inset-0"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = droppedFiles(e.dataTransfer);
          if (!files.length || latest.current.session.group) return;
          e.preventDefault();
          e.stopPropagation();
          const r = canvas.current!.getBoundingClientRect();
          const row = rowAt(e.clientY - r.top);
          const t = row === undefined ? undefined : tracks[row];
          dropFiles(files, { time: timeAt(Math.max(e.clientX, r.left + HEADER)), ...(t && !t.locked ? { track: t.id } : {}) });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const { x, y } = pointer(e);
          const { session } = latest.current;
          const capture = () => canvas.current!.setPointerCapture(e.pointerId);
          if (x < HEIGHT_SLIDER.hit && y < RULER) {
            dragState.current = { kind: "height" };
            capture();
            return setHeight(e.clientY);
          }
          if (x < HEADER) {
            const { project } = latest.current;
            if (y < RULER) {
              const button = cornerButtonAt(HEADER, x, y);
              if (button === "add") {
                if (latest.current.session.group) status("Close the group (⌃⇧U) to add a track");
                else run("track.add", { name: "" }, "Add Track");
              } else if (button === "menu") trackMenu(null);
              return;
            }
            const i = rowAt(y);
            if (i === undefined) return;
            const t = tracks[i]!;
            const icon = headerIcon(x, y, i);
            if (icon === "eye") return run("track.set", { track: t.id, hidden: !t.hidden }, t.hidden ? "Enable Track" : "Disable Track");
            if (icon === "magnet") return run("track.set", { track: t.id, magnetic: !t.magnetic }, "Magnetic Track");
            if (icon === "lock") return run("track.set", { track: t.id, locked: !t.locked }, t.locked ? "Unlock Track" : "Lock Track");
            if (icon === "mute") return run("track.set", { track: t.id, muted: !t.muted }, t.muted ? "Unmute Track" : "Mute Track");
            dragState.current = { kind: "track", track: t.id, from: i, to: i };
            return capture();
          }
          const ph = xOf(session.playhead);
          // A range's edges are dragged on the ruler.
          if (session.range && y < RULER) {
            const edge = rangeEdgeAt(x, xOf(session.range.in), xOf(session.range.out));
            if (edge) {
              dragState.current = { kind: "rangeEdge", edge, other: edge === "in" ? session.range.out : session.range.in };
              return capture();
            }
          }
          // On the tracks, an arrow or volume point under the playhead line wins over grabbing the line.
          const overMark =
            y >= RULER &&
            (arrowAt(e.clientX, e.clientY) || ((c) => c && volumeHit(c, e.clientX, e.clientY))(clipAt(e.clientX, e.clientY)));
          if (y < RULER || (Math.abs(x - ph) <= GRAB && !overMark)) {
            capture();
            if (e.metaKey) dragState.current = { kind: "range", anchor: session.playhead };
            else if (e.shiftKey && session.group) status("Close the group (⌃⇧U) to insert space");
            else if (e.shiftKey) dragState.current = { kind: "space", at: session.playhead, d: 0 };
            else {
              dragState.current = { kind: "playhead" };
              scrub(e.clientX);
            }
            return;
          }
          capture();
          const arrow = arrowAt(e.clientX, e.clientY);
          if (arrow) {
            pickedDiamond.current = arrow.part === "body" ? undefined : { anim: arrow.anim.id, part: arrow.part };
            run("animation.select", { clip: arrow.clip.id, animation: arrow.anim.id });
            dragState.current = { kind: "anim", clip: arrow.clip.id, anim: arrow.anim.id, part: arrow.part, x0: x, a: arrow.a, b: arrow.b, key: `anim-${Date.now()}` };
            return;
          }
          const clip = clipAt(e.clientX, e.clientY);
          const vol = clip && volumeHit(clip, e.clientX, e.clientY);
          if (clip && vol) {
            const base = Number((clip.props.audio as { volume?: number } | undefined)?.volume ?? 1);
            dragState.current = { kind: "volume", clip: clip.id, index: vol.index, x0: x, y0: y, points: volumePoints(clip), base, key: `volume-${Date.now()}` };
            return;
          }
          if (session.animation) run("animation.select", {});
          if (session.effects.length) run("effect.select", { effects: [] });
          const edge = clip && edgeAt(clip, e.clientX);
          if (clip && edge) {
            if (!session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
            const t = ticksToSeconds(edge === "start" ? clip.start : clip.start + clip.duration);
            dragState.current = { kind: "trim", clip: clip.id, edge, x0: x, t, ripple: e.shiftKey, extend: false };
          } else if (clip) {
            const toggle = e.metaKey || e.shiftKey;
            if (!toggle && !session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
            dragState.current = { kind: "press", clip: clip.id, x0: x, y0: y, toggle, ripple: e.shiftKey };
          } else {
            const base = e.shiftKey || e.metaKey ? session.selection : [];
            if (!base.length && session.selection.length) run("selection.clear");
            dragState.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, base };
          }
        }}
        onPointerMove={(e) => {
          const d = dragState.current;
          const { x, y } = pointer(e);
          const { project, session } = latest.current;
          if (!d) {
            const clip = y > RULER && x > HEADER ? clipAt(e.clientX, e.clientY) : undefined;
            const onPlayhead = x > HEADER && (y < RULER || Math.abs(x - xOf(session.playhead)) <= GRAB);
            canvas.current!.style.cursor = onPlayhead || (clip && edgeAt(clip, e.clientX)) ? "ew-resize" : "default";
            return;
          }
          if (d.kind === "playhead") return scrub(e.clientX);
          if (d.kind === "anim") {
            let dt = (x - d.x0) * spp();
            const edges = d.part === "start" ? [d.a + dt] : d.part === "end" ? [d.b + dt] : [d.a + dt, d.b + dt];
            dt += snapped(edges, new Set(), e.ctrlKey);
            const frame = 1 / rationalToNumber(project.settings.fps);
            const a = d.part === "end" ? d.a : Math.min(d.a + dt, d.part === "start" ? d.b - frame : Infinity);
            const b = d.part === "start" ? d.b : Math.max(d.b + dt, d.part === "end" ? d.a + frame : -Infinity);
            const args = d.part === "body" ? { end: Math.max(0, d.b + dt) } : { end: Math.max(0, b), duration: b - a };
            throttled("animation.set", { clip: d.clip, animation: d.anim, ...args }, d.part === "body" ? "Move Animation" : "Change Animation Duration", d.key);
            return;
          }
          if (d.kind === "volume") {
            d.at = [x, y];
            draw();
            // Up to 100% by dragging, but points already above it aren't pulled down.
            const v = (val: number, was = 0) => Math.min(Math.max(1, was), Math.max(0, val));
            const dv = -(y - d.y0) / (TRACK - 12);
            if (d.index === null) {
              if (d.points.length) throttled("volume.setPoints", { clip: d.clip, points: d.points.map((p) => ({ time: p.time, value: v(p.value + dv, p.value) })) }, "Volume", d.key);
              else throttled("clip.set", { clip: d.clip, props: { audio: { volume: v(d.base + dv) } } }, "Volume", d.key);
              return;
            }
            const p = d.points[d.index]!;
            const lo = d.points[d.index - 1]?.time ?? -Infinity;
            const hi = d.points[d.index + 1]?.time ?? Infinity;
            // A frame apart at least: points are snapped to frames, and two on one frame would merge.
            const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
            const t = Math.min(hi - frame, Math.max(lo + frame, p.time + (x - d.x0) * spp()));
            const points = d.points.map((q, j) => (j === d.index ? { time: t, value: v(p.value + dv, p.value) } : q));
            throttled("volume.setPoints", { clip: d.clip, points }, "Move Audio Point", d.key);
            return;
          }
          if (d.kind === "track") {
            dragState.current = { ...d, to: Math.min(tracks.length - 1, Math.max(0, Math.floor((y - RULER) / TRACK))) };
            return draw();
          }
          if (d.kind === "height") return setHeight(e.clientY);
          if (d.kind === "press") {
            if (Math.hypot(x - d.x0, y - d.y0) > 3) startMove(d, e);
            return;
          }
          if (d.kind === "move") return updateMove(e);
          if (d.kind === "trim") {
            const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clip)!;
            const a = ticksToSeconds(clip.start);
            const b = ticksToSeconds(clip.start + clip.duration);
            let t = timeAt(e.clientX);
            t += snapped([t], new Set([clip.id]), e.ctrlKey);
            // Edges stop at the clips beside them, as the command does; Shift (ripple) pushes them instead.
            if (!e.shiftKey) {
              const [lo, hi] = trimBounds(project.tracks.find((tr) => tr.clips.includes(clip))!, clip);
              t = Math.min(Math.max(t, ticksToSeconds(lo)), ticksToSeconds(hi));
            }
            const frame = 1 / rationalToNumber(project.settings.fps);
            t = d.edge === "start" ? Math.min(t, b - frame) : Math.max(t, a + frame);
            const video = clipTypes[clip.type]?.includes("video") ?? false;
            dragState.current = { ...d, t, ripple: e.shiftKey, extend: video && d.edge === "end" && e.altKey && t > b };
            return draw();
          }
          if (d.kind === "marquee") {
            dragState.current = { ...d, x1: x, y1: y };
            const [x0, x1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
            const [y0, y1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
            const hit = tracks.flatMap((t, i) => {
              const ty = RULER + i * TRACK;
              if (ty + TRACK < y0 || ty > y1) return [];
              return t.clips.filter((c) => xOf(ticksToSeconds(c.start)) < x1 && xOf(ticksToSeconds(c.start + c.duration)) > x0).map((c) => c.id);
            });
            const next = [...new Set([...d.base, ...hit])];
            if (next.join() !== session.selection.join()) throttled("selection.set", { clips: next, linked: true });
            return draw();
          }
          let t = timeAt(e.clientX);
          t += snapped([t], new Set(), e.ctrlKey);
          if (d.kind === "range") return throttled("range.set", { in: d.anchor, out: t, playhead: t });
          if (d.kind === "rangeEdge") return throttled("range.set", { in: d.other, out: t });
          if (d.kind === "space") {
            dragState.current = { ...d, d: Math.max(0, t - d.at) };
            return draw();
          }
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={(e) => dragState.current && finish(e)}
        onDoubleClick={(e) => {
          const { x, y } = pointer(e as unknown as React.PointerEvent);
          const i = rowAt(y);
          if (x < HEADER && i !== undefined && !headerIcon(x, y, i)) replica.rename(tracks[i]!.id);
          if (x < HEADER || i === undefined) return;
          // On a selected audio clip's volume line: add a point there, or remove the one double-clicked.
          const clip = clipAt(e.clientX, e.clientY);
          if (clip && clipTypes[clip.type]?.includes("group") && !latest.current.session.group) return run("group.open", { clip: clip.id });
          const vol = clip && volumeHit(clip, e.clientX, e.clientY);
          if (!clip || !vol) return;
          const pts = volumePoints(clip);
          if (vol.index !== null) run("volume.setPoints", { clip: clip.id, points: pts.filter((_, j) => j !== vol.index) }, "Delete Audio Point");
          else {
            const t = timeAt(e.clientX);
            run("volume.setPoints", { clip: clip.id, points: [...pts, { time: t, value: volumeAt(clip, t) }].sort((p, q) => p.time - q.time) }, "Add Audio Point");
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const { x, y } = pointer(e as unknown as React.PointerEvent);
          if (x < HEADER) {
            const i = rowAt(y);
            if (i !== undefined) trackMenu(tracks[i]!.id);
            return;
          }
          const clip = clipAt(e.clientX, e.clientY);
          if (!clip) return;
          if (!latest.current.session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
          menu(clip.id);
        }}
        onWheel={(e) => {
          const { start, end } = latest.current.session.timeline;
          const span = end - start;
          if (e.metaKey || e.ctrlKey) {
            const at = timeAt(e.clientX);
            const f = Math.exp(e.deltaY * 0.01);
            run("timeline.view", { start: Math.max(0, at - (at - start) * f), end: at + (end - at) * f });
          } else {
            const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (span / Math.max(1, size.current.w - HEADER));
            run("timeline.scroll", { start: Math.max(0, start + d) });
          }
        }}
      />
      {renaming && tracks.some((t) => t.id === renaming) && (
        <input
          autoFocus
          defaultValue={((i) => trackName(tracks[i]!, tracks.length - 1 - i))(tracks.findIndex((t) => t.id === renaming))}
          className="absolute rounded-sm border border-accent bg-well px-1 text-body font-semibold text-text-strong outline-none"
          style={{ left: 8, top: RULER + tracks.findIndex((t) => t.id === renaming) * TRACK + TRACK / 2 - 11, width: HEADER - 40, height: 22 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") replica.rename(undefined);
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            const t = tracks.find((x) => x.id === renaming);
            if (t && name !== t.name && name !== trackName(t, tracks.length - 1 - tracks.indexOf(t))) run("track.set", { track: t.id, name }, "Rename Track");
            replica.rename(undefined);
          }}
        />
      )}
    </div>
  );
}
