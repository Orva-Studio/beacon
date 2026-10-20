import { z } from "zod";
import {
  animatedValue,
  defineFeature,
  defineQuery,
  mediaTimeAt,
  placement,
  project as projectPoint,
  projectDuration,
  roundSeconds,
  secondsToTicks,
  ticksToSeconds,
  ticksPerFrame,
  type Clip,
  type FeatureRegistry,
  type Project,
  type Session,
  type Track,
} from "@beacon/model";
import { captionBox } from "../captions";
import LAYOUTS from "./layouts.json";

type Rect = [number, number, number, number];

export interface SafeLayout {
  id: string;
  title: string;
  /** The canvas shape it is for, width to height. */
  aspect: [number, number];
  source: string;
  /** Where the platform draws over the video: fractions of the frame, y down. */
  zones: { id: string; label: string; rect: Rect }[];
  /** Text outside this share of the frame, centred, can be cut off by a TV or a phone's corners. */
  titleSafe?: number;
  /** Seconds at the end that end-screen cards and buttons may cover. */
  endScreen?: number;
  /** Where the top of a head goes, and where the eyes go: fractions of the height. */
  headroom: [number, number];
  eyeLine: number;
}

export const SAFE_LAYOUTS = LAYOUTS.layouts as SafeLayout[];

/** Whether a layout is for the canvas's shape (a 1080×1920 canvas and a 720×1280 one alike). */
const fits = (l: SafeLayout, s: { width: number; height: number }) => Math.abs(l.aspect[0] / l.aspect[1] - s.width / s.height) < 0.01;

/** `session.features["safe-areas"]`: the layout shown over the canvas. */
interface Shown {
  layout: string;
}

const shown = (s: Session) => (s.features["safe-areas"] as Shown | undefined)?.layout;

/** A layout's zones, the title-safe frame's edges and the guides, in canvas pixels. */
function inPixels(l: SafeLayout, s: { width: number; height: number }) {
  const px = ([x0, y0, x1, y1]: Rect): Rect => [x0 * s.width, y0 * s.height, x1 * s.width, y1 * s.height];
  const inset = l.titleSafe === undefined ? undefined : (1 - l.titleSafe) / 2;
  return {
    id: l.id,
    title: l.title,
    source: l.source,
    fits: fits(l, s),
    zones: l.zones.map((z) => ({ id: z.id, label: z.label, rect: px(z.rect) })),
    ...(inset === undefined ? {} : { titleSafe: px([inset, inset, 1 - inset, 1 - inset]) }),
    ...(l.endScreen ? { endScreen: l.endScreen } : {}),
    headroom: [l.headroom[0] * s.height, l.headroom[1] * s.height] as [number, number],
    eyeLine: l.eyeLine * s.height,
  };
}

const layoutOf = (id: string) => {
  const l = SAFE_LAYOUTS.find((x) => x.id === id);
  if (!l) throw new Error(`no safe-area layout "${id}": ${SAFE_LAYOUTS.map((x) => x.id).join(", ")}`);
  return l;
};

const aspectText = (w: number, h: number) => {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(Math.round(w), Math.round(h));
  return `${Math.round(w) / d}:${Math.round(h) / d}`;
};

type Size = { width: number; height: number };

/** Where a clip with content `size` sits on a `canvas` at main-timeline ticks `t`, through its animations (`offset`: its track's start on the main timeline). */
function placedAt(clip: Clip, size: [number, number], canvas: Size, t: number, offset: number) {
  const at = mediaTimeAt(clip, Math.min(Math.max(t - offset, clip.start), clip.start + clip.duration));
  const tr = (clip.props.transform ?? {}) as Record<string, unknown>;
  const v = (f: string, d: number) => Number(animatedValue(tr[f] ?? d, `transform.${f}`, clip.animations, at));
  return placement(canvas, size, { x: v("x", 0), y: v("y", 0), scaleX: v("scaleX", 1), scaleY: v("scaleY", 1), rotation: v("rotation", 0), rotationX: v("rotationX", 0), rotationY: v("rotationY", 0) });
}

/** A group a clip is inside: it, its own canvas's size, the canvas it is placed on, and its track's offset. */
type Ancestor = { clip: Clip; size: [number, number]; canvas: Size; offset: number };

/** A callout or caption on a visible track, inside groups or not, with where its track starts and when it shows (main-timeline ticks). */
interface Leaf {
  clip: Clip;
  track: Track;
  canvas: Size;
  offset: number;
  chain: Ancestor[];
  from: number;
  to: number;
}

function* leaves(tracks: Track[], registry: FeatureRegistry, canvas: Size, offset: number, chain: Ancestor[], from: number, to: number): Generator<Leaf> {
  for (const track of tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const [a, b] = [Math.max(from, offset + clip.start), Math.min(to, offset + clip.start + clip.duration)];
      if (b <= a) continue;
      if (clip.type === "caption" || clip.type === "callout") yield { clip, track, canvas, offset, chain, from: a, to: b };
      for (const g of registry.groupsFor(clip.type)) {
        const value = clip.props[g.id];
        if (!g.nested || !g.size || !value) continue;
        const size = g.size(value);
        yield* leaves(g.nested(value), registry, { width: size[0], height: size[1] }, offset + clip.start - (clip.mediaStart ?? 0), [...chain, { clip, size, canvas, offset }], a, b);
      }
    }
  }
}

/** A leaf's box on the main canvas at main-timeline ticks `t`: its corners carried out through every group it is in. */
function boxAt(leaf: Leaf, t: number): Rect | undefined {
  const { clip, track, canvas } = leaf;
  let pts: [number, number][];
  if (clip.type === "caption") {
    const b = captionBox(clip, track, canvas);
    if (!b) return undefined;
    pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]];
  } else {
    const box = clip.props.callout as { width?: number; height?: number } | undefined;
    if (!box?.width || !box.height) return undefined;
    const m = placedAt(clip, [box.width, box.height], canvas, t, leaf.offset);
    pts = [projectPoint(m, 0, 0), projectPoint(m, box.width, 0), projectPoint(m, box.width, box.height), projectPoint(m, 0, box.height)];
  }
  for (const g of [...leaf.chain].reverse()) {
    const m = placedAt(g.clip, g.size, g.canvas, t, g.offset);
    pts = pts.map(([x, y]) => projectPoint(m, x, y));
  }
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

const overlaps = (a: Rect, b: Rect) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5;

export interface SafeIssue {
  clip: string;
  type: string;
  text: string;
  /** The zone's id ("bottom", "rail"), or "titleSafe" (beyond the title-safe frame) or "endScreen". */
  zone: string;
  label: string;
  /** Timeline seconds. */
  from: number;
  to: number;
}

/**
 * Every callout and caption on a visible track, inside groups too, that lies under one of `l`'s zones, beyond its
 * title-safe frame, or in its end-screen seconds, on any frame it shows (once when nothing moves it).
 */
function check(project: Project, registry: FeatureRegistry, l: SafeLayout): SafeIssue[] {
  const s = project.settings;
  const z = inPixels(l, s);
  const end = projectDuration(project);
  const frame = ticksPerFrame(s.fps);
  const endScreen = z.endScreen ? end - secondsToTicks(z.endScreen) : undefined;
  const issues: SafeIssue[] = [];
  for (const leaf of leaves(project.tracks, registry, s, 0, [], 0, Infinity)) {
    const { clip } = leaf;
    const text =
      clip.type === "caption"
        ? ((clip.props.caption as { words?: { text: string }[] } | undefined)?.words ?? []).map((w) => w.text).join(" ")
        : ((clip.props.callout as { text?: { text?: string } } | undefined)?.text?.text ?? "");
    const still = !clip.animations.length && leaf.chain.every((g) => !g.clip.animations.length);
    // Still, it is checked once over its whole time, the end screen apart; moving, on each frame.
    const spans: [number, number][] = still
      ? endScreen !== undefined && leaf.from < endScreen && leaf.to > endScreen
        ? [[leaf.from, endScreen], [endScreen, leaf.to]]
        : [[leaf.from, leaf.to]]
      : [];
    if (!still) for (let t = leaf.from; t < leaf.to; t += frame) spans.push([t, Math.min(t + frame, leaf.to)]);
    const open = new Map<string, SafeIssue>();
    for (const [a, b] of spans) {
      const box = boxAt(leaf, a);
      if (!box) continue;
      const hit: { zone: string; label: string }[] = z.zones.filter((zone) => overlaps(box, zone.rect)).map((zone) => ({ zone: zone.id, label: zone.label }));
      const ts = z.titleSafe;
      if (ts && (box[0] < ts[0] - 0.5 || box[1] < ts[1] - 0.5 || box[2] > ts[2] + 0.5 || box[3] > ts[3] + 0.5)) hit.push({ zone: "titleSafe", label: "Beyond the title-safe frame" });
      if (endScreen !== undefined && a >= endScreen) hit.push({ zone: "endScreen", label: `End screen (the last ${z.endScreen} s)` });
      for (const h of hit) {
        const run = open.get(h.zone);
        if (run && a <= run.to) run.to = b;
        else {
          const next = { clip: clip.id, type: clip.type, text: text.slice(0, 80), zone: h.zone, label: h.label, from: a, to: b };
          issues.push(next);
          open.set(h.zone, next);
        }
      }
    }
  }
  return issues.map((i) => ({ ...i, from: roundSeconds(ticksToSeconds(i.from)), to: roundSeconds(ticksToSeconds(i.to)) })).sort((x, y) => x.from - y.from);
}

/** Where a platform's own UI sits over the video (TikTok, Reels, Shorts, YouTube): guides on the canvas, and a check for text under it. */
export const safeAreas = defineFeature({
  id: "safe-areas",
  version: 1,
  sessionSaved: (state) => {
    const layout = (state as Shown | undefined)?.layout;
    return layout ? { layout } : undefined;
  },
  sessionCommands: [
    {
      id: "safeAreas.show",
      description: `Show a platform's safe areas over the canvas (View › Safe Areas): where its own UI sits (caption band, username, the like/comment column), a headroom band and an eye line; drawn by the preview, never exported, kept with the project. \`layout\`: ${SAFE_LAYOUTS.map((l) => `"${l.id}" (${l.title}, ${l.aspect.join(":")})`).join(", ")}, only on a canvas of its shape; null hides them`,
      args: z.strictObject({ layout: z.enum(SAFE_LAYOUTS.map((l) => l.id) as [string, ...string[]]).nullable() }),
      apply: (s, { layout }: { layout: string | null }, { full }) => {
        if (!layout) return void delete s.features["safe-areas"];
        const l = layoutOf(layout);
        const { width, height } = full.settings;
        if (!fits(l, full.settings)) throw new Error(`${l.title}'s safe areas are for a ${l.aspect.join(":")} canvas; this one is ${aspectText(width, height)} (${width}×${height})`);
        s.features["safe-areas"] = { layout } satisfies Shown;
      },
    },
  ],
  queries: [
    defineQuery({
      id: "safeAreas.layouts",
      description:
        "The platforms' safe-area layouts: each one's zones (where its UI sits, labelled), its title-safe frame and end-screen seconds if it has them, and its headroom band and eye line, in canvas pixels for this project's canvas (y down), whether it fits the canvas's shape, and which is shown",
      args: z.strictObject({}),
      run: (_, { project }) => SAFE_LAYOUTS.map((l) => inPixels(l, project.settings)),
    }),
    defineQuery({
      id: "safeAreas.check",
      description:
        "Text the platform's UI would cover: every callout and caption that lies under one of the layout's zones (or beyond its title-safe frame, or in its end-screen seconds) at any moment it shows, with the zone and the timeline seconds; `clean` when there are none. `layout`: one of safeAreas.layouts', else the one shown (ui_state), else the first for the canvas's shape. A callout counts by its box, so a text box wider than its words can be flagged",
      args: z.strictObject({ layout: z.string().optional() }),
      run: ({ layout }, { project, registry, session }) => {
        const id = layout ?? (session && shown(session)) ?? SAFE_LAYOUTS.find((l) => fits(l, project.settings))?.id;
        if (!id) throw new Error(`no platform's safe areas are for a ${aspectText(project.settings.width, project.settings.height)} canvas`);
        const l = layoutOf(id);
        const issues = check(project, registry, l);
        return { layout: l.id, title: l.title, fits: fits(l, project.settings), clean: !issues.length, issues };
      },
    }),
  ],
});
