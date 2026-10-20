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
  type Clip,
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

/** Seconds between samples of a clip's place: animations move it. */
const STEP = 0.25;

/** A callout's corners on the canvas (canvas pixels, y down) at timeline seconds `t`, through its animations. */
function calloutCorners(project: Project, clip: Clip, t: number): [number, number][] | undefined {
  const box = clip.props.callout as { width?: number; height?: number } | undefined;
  if (!box?.width || !box.height) return undefined;
  const at = mediaTimeAt(clip, Math.min(Math.max(secondsToTicks(t), clip.start), clip.start + clip.duration));
  const tr = (clip.props.transform ?? {}) as Record<string, unknown>;
  const v = (f: string, d: number) => Number(animatedValue(tr[f] ?? d, `transform.${f}`, clip.animations, at));
  const m = placement(project.settings, [box.width, box.height], { x: v("x", 0), y: v("y", 0), scaleX: v("scaleX", 1), scaleY: v("scaleY", 1), rotation: v("rotation", 0), rotationX: v("rotationX", 0), rotationY: v("rotationY", 0) });
  return [projectPoint(m, 0, 0), projectPoint(m, box.width, 0), projectPoint(m, box.width, box.height), projectPoint(m, 0, box.height)];
}

/** What a clip shows on the canvas at `t` as a box (canvas pixels): callouts and captions, the clips that carry words. */
function boxAt(project: Project, track: Track, clip: Clip, t: number): Rect | undefined {
  if (clip.type === "caption") {
    const b = captionBox(clip, track, project.settings);
    return b && [b.x, b.y, b.x + b.width, b.y + b.height];
  }
  const c = calloutCorners(project, clip, t);
  return c && [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
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
 * Every callout and caption on a visible track (top level) that lies under one of `l`'s zones, beyond its
 * title-safe frame, or in its end-screen seconds, at any moment it shows, sampled every quarter second.
 */
function check(project: Project, l: SafeLayout): SafeIssue[] {
  const s = project.settings;
  const z = inPixels(l, s);
  const end = ticksToSeconds(projectDuration(project));
  const issues: SafeIssue[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== "caption" && clip.type !== "callout") continue;
      const [a, b] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
      const text =
        clip.type === "caption"
          ? ((clip.props.caption as { words?: { text: string }[] } | undefined)?.words ?? []).map((w) => w.text).join(" ")
          : ((clip.props.callout as { text?: { text?: string } } | undefined)?.text?.text ?? "");
      const open = new Map<string, SafeIssue>();
      const times = [];
      for (let t = a; t < b - 1e-6; t += STEP) times.push(t);
      times.push(Math.max(a, b - 1e-3));
      for (const t of times) {
        const box = boxAt(project, track, clip, t);
        if (!box) continue;
        const hit: { zone: string; label: string }[] = z.zones.filter((zone) => overlaps(box, zone.rect)).map((zone) => ({ zone: zone.id, label: zone.label }));
        const ts = z.titleSafe;
        if (ts && (box[0] < ts[0] - 0.5 || box[1] < ts[1] - 0.5 || box[2] > ts[2] + 0.5 || box[3] > ts[3] + 0.5)) hit.push({ zone: "titleSafe", label: "Beyond the title-safe frame" });
        if (z.endScreen && t >= end - z.endScreen) hit.push({ zone: "endScreen", label: `End screen (the last ${z.endScreen} s)` });
        for (const h of hit) {
          const run = open.get(h.zone);
          const to = Math.min(t + STEP, b);
          if (run && t <= run.to + 1e-6) run.to = to;
          else {
            const next = { clip: clip.id, type: clip.type, text: text.slice(0, 80), zone: h.zone, label: h.label, from: t, to };
            issues.push(next);
            open.set(h.zone, next);
          }
        }
      }
    }
  }
  return issues.map((i) => ({ ...i, from: roundSeconds(i.from), to: roundSeconds(i.to) })).sort((x, y) => x.from - y.from);
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
      run: ({ layout }, { project, session }) => {
        const id = layout ?? (session && shown(session)) ?? SAFE_LAYOUTS.find((l) => fits(l, project.settings))?.id;
        if (!id) throw new Error(`no platform's safe areas are for a ${aspectText(project.settings.width, project.settings.height)} canvas`);
        const l = layoutOf(id);
        const issues = check(project, l);
        return { layout: l.id, title: l.title, fits: fits(l, project.settings), clean: !issues.length, issues };
      },
    }),
  ],
});
