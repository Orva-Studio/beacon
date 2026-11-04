import { z } from "zod";
import { RgbaSchema, solidLayer, type ClipEval, type EvalContext, type Layer, type RGBA, type TextSpec, type VisualLayer } from "@beacon/model";
import { textLayout, type TextLine } from "@beacon/media";
import { trimLines } from "../callouts/svg-path";
import { shadowParams } from "../drop-shadow";
import { matteRange, type MatteData } from "../remove-background";

export const WordSchema = z.strictObject({
  text: z.string().min(1),
  start: z.number(),
  end: z.number(),
  /** Emphasised: drawn in the style's emphasis look (a keyword). */
  em: z.boolean().optional(),
});
export type CaptionWord = z.infer<typeof WordSchema>;

export const emphasisSchema = z.strictObject({
  color: RgbaSchema,
  /** Times the caption's size. */
  scale: z.number().min(0.5).max(4),
  /** Empty for the caption's own font. */
  font: z.string(),
  weight: z.number(),
  italic: z.boolean(),
  /** A soft glow around the word; transparent for none. */
  glow: RgbaSchema,
  decoration: z.enum(["none", "underline", "ellipse", "box", "highlighter"]),
  decorationColor: RgbaSchema,
});
export type Emphasis = z.infer<typeof emphasisSchema>;

/** What Dynamic Captions add to the caption style; with all of them at their defaults a caption draws as before. */
export const dynamicFields = {
  /** `word`: each word appears as it is said; `phrase`: the caption's words show together. */
  reveal: z.enum(["phrase", "word"]),
  /** How a word comes in (with `word` reveal) or the caption does (with `phrase`). */
  enter: z.enum(["none", "pop", "fade", "rise"]),
  /** Words not said yet, with `phrase` reveal; transparent to draw them in the caption's colour. */
  upcoming: RgbaSchema,
  /** How a caption leaves at its end: cut, faded, or blurred away. */
  exit: z.enum(["none", "fade", "blur"]),
  /** A soft shadow or outline behind the text; transparent for none. */
  shadow: RgbaSchema,
  /** Canvas pixels. */
  shadowBlur: z.number().nonnegative(),
  /** Radians, as Drop Shadow's: 0 points right, counter-clockwise (−π/2 straight down). */
  shadowAngle: z.number().meta({ degrees: true }),
  /** Canvas pixels the shadow falls from the text. */
  shadowDistance: z.number().min(0).max(200),
  /** `headline`: emphasised words on lines of their own, large, the rest small around them. */
  layout: z.enum(["line", "headline"]),
  emphasis: emphasisSchema,
  /** Each line widened (never narrowed) to fill `maxWidth`, up to 1.8 times, its letters stretched sideways. */
  stretch: z.boolean(),
  /** Most words on a line; 0 for as many as fit. */
  lineWords: z.int().min(0).max(8),
  /** A number said (100,000, 87%, $5) counts up to itself as it comes in. */
  countUp: z.boolean(),
  /** Drawn behind the person on camera under it (their matte from Remove Background's analysis). */
  behind: z.boolean(),
};

export interface DynamicStyle {
  font: string;
  weight: number;
  size: number;
  color: RGBA;
  background: RGBA;
  cornerRadius: number;
  anchorX: "left" | "center" | "right";
  offsetX: number;
  anchorY: "top" | "middle" | "bottom";
  offsetY: number;
  highlight: RGBA;
  maxWidth: number;
  uppercase: boolean;
  reveal: "phrase" | "word";
  enter: "none" | "pop" | "fade" | "rise";
  upcoming: RGBA;
  exit: "none" | "fade" | "blur";
  shadow: RGBA;
  shadowBlur: number;
  shadowAngle: number;
  shadowDistance: number;
  layout: "line" | "headline";
  emphasis: Emphasis;
  stretch: boolean;
  lineWords: number;
  countUp: boolean;
  behind: boolean;
}

export function dynamicDefaults(height = 1080): Pick<DynamicStyle, keyof typeof dynamicFields> {
  const k = height / 1080;
  return {
    reveal: "phrase",
    enter: "none",
    upcoming: [1, 1, 1, 0],
    exit: "none",
    shadow: [0, 0, 0, 0],
    shadowBlur: Math.round(6 * k),
    shadowAngle: -Math.PI / 2,
    shadowDistance: Math.round(6 * k * 0.3),
    layout: "line",
    emphasis: { color: [1, 0.84, 0.2, 1], scale: 1, font: "", weight: 800, italic: false, glow: [0, 0, 0, 0], decoration: "none", decorationColor: [1, 0.84, 0.2, 1] },
    stretch: false,
    lineWords: 0,
    countUp: false,
    behind: false,
  };
}

/** Whether a caption needs drawing word by word. */
export function isDynamic(style: DynamicStyle, words: CaptionWord[]): boolean {
  return style.reveal === "word" || style.enter !== "none" || style.upcoming[3] > 0 || style.exit !== "none" || style.shadow[3] > 0 || style.layout === "headline" || style.stretch || style.lineWords > 0 || style.countUp || style.behind || words.some((w) => w.em);
}

const measured = new Map<string, TextLine>();
/** One word laid out alone: its carets and its line's top and bottom. */
function measure(spec: TextSpec): TextLine {
  const key = JSON.stringify(spec);
  let line = measured.get(key);
  if (!line) {
    if (measured.size > 2000) measured.clear();
    line = textLayout(spec)[0] ?? { start: 0, end: spec.text.length, top: 0, bottom: spec.size * 1.2, carets: new Array(spec.text.length + 1).fill(0) };
    measured.set(key, line);
  }
  return line;
}

export interface PlacedWord {
  index: number;
  text: string;
  em: boolean;
  spec: TextSpec;
  /** Top left of the word's text box, from the text's origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which line it is on. */
  line: number;
  /** Its line's sideways stretch. */
  sx: number;
}

export interface DynamicGeometry {
  text: string;
  words: PlacedWord[];
  lines: TextLine[];
  box: { x: number; y: number; width: number; height: number };
  origin: [number, number];
}

/** Ascent over line height, near enough for the fonts captions use: lines of mixed sizes sit on one baseline. */
const ASCENT = 0.78;

export function dynamicGeometry(words: CaptionWord[], shown: string[], style: DynamicStyle, canvas: { width: number; height: number }): DynamicGeometry | undefined {
  if (!words.length) return undefined;
  const em = style.emphasis;
  const headline = style.layout === "headline";
  const specOf = (i: number): TextSpec => {
    const on = !!words[i]!.em;
    return {
      text: shown[i]!,
      font: on && em.font ? em.font : style.font,
      weight: on ? em.weight : style.weight,
      italic: on && em.italic,
      size: Math.round(style.size * (on ? em.scale : 1)),
      color: style.color,
      tracking: 0,
      lineSpacing: 0,
      align: "left",
      valign: "top",
      width: 100_000,
      height: Math.ceil(style.size * (on ? em.scale : 1) * 2),
      scale: 1,
    };
  };
  const specs = words.map((_, i) => specOf(i));
  const metrics = specs.map((s) => measure(s));
  const widths = metrics.map((m) => m.carets.at(-1)! - m.carets[0]!);
  const space = (() => {
    const m = measure({ ...specs[0]!, text: "a a", weight: style.weight, italic: false, size: style.size, font: style.font });
    return m.carets[2]! - m.carets[1]!;
  })();
  const max = Math.max(1, canvas.width * style.maxWidth);
  // Lines of word indices: a headline's emphasised runs on lines of their own.
  const lines: number[][] = [];
  let cur: number[] = [];
  let curWidth = 0;
  for (let i = 0; i < words.length; i++) {
    const breakRun = headline && cur.length > 0 && !!words[i]!.em !== !!words[cur.at(-1)!]!.em;
    const w = widths[i]! + (cur.length ? space : 0);
    if (cur.length && (breakRun || curWidth + w > max || (style.lineWords > 0 && cur.length >= style.lineWords))) {
      lines.push(cur);
      cur = [];
      curWidth = 0;
    }
    curWidth += widths[i]! + (cur.length ? space : 0);
    cur.push(i);
  }
  if (cur.length) lines.push(cur);
  const natural = (l: number[]) => l.reduce((n, i, k) => n + widths[i]! + (k ? space : 0), 0);
  const stretchOf = (l: number[]) => (style.stretch ? Math.min(1.8, Math.max(1, max / natural(l))) : 1);
  const lineWidth = (l: number[]) => natural(l) * stretchOf(l);
  const blockWidth = Math.max(...lines.map(lineWidth));
  const placed: PlacedWord[] = [];
  const textLines: TextLine[] = [];
  const offsets: number[] = [];
  for (let i = 0, o = 0; i < shown.length; i++) {
    offsets.push(o);
    o += shown[i]!.length + 1;
  }
  let y = 0;
  for (const [li, l] of lines.entries()) {
    const heights = l.map((i) => metrics[i]!.bottom - metrics[i]!.top);
    const lineHeight = Math.max(...heights);
    const baseline = y + lineHeight * ASCENT;
    const width = lineWidth(l);
    const sx = stretchOf(l);
    let x = style.anchorX === "left" ? 0 : style.anchorX === "right" ? blockWidth - width : (blockWidth - width) / 2;
    const carets: number[] = [];
    for (const [k, i] of l.entries()) {
      if (k) {
        carets.push(x);
        x += space * sx;
      }
      const m = metrics[i]!;
      const h = m.bottom - m.top;
      for (const c of m.carets.slice(0, -1)) carets.push(x + (c - m.carets[0]!) * sx);
      placed.push({ index: i, text: shown[i]!, em: !!words[i]!.em, spec: { ...specs[i]!, width: Math.ceil(widths[i]! + specs[i]!.size), height: Math.ceil(h) + 2 }, x: x - m.carets[0]! * sx, y: baseline - h * ASCENT - m.top, width: widths[i]! * sx, height: h, line: li, sx });
      x += widths[i]! * sx;
    }
    carets.push(x);
    const first = l[0]!;
    const last = l.at(-1)!;
    textLines.push({ start: offsets[first]!, end: offsets[last]! + shown[last]!.length, top: y, bottom: y + lineHeight, carets });
    y += lineHeight;
  }
  const pad: [number, number] = [style.size * 0.45, style.size * 0.2];
  const size: [number, number] = [blockWidth + 2 * pad[0], y + 2 * pad[1]];
  const bx = style.anchorX === "left" ? style.offsetX : style.anchorX === "right" ? canvas.width - style.offsetX - size[0] : (canvas.width - size[0]) / 2 + style.offsetX;
  const by = style.anchorY === "top" ? style.offsetY : style.anchorY === "bottom" ? canvas.height - style.offsetY - size[1] : (canvas.height - size[1]) / 2 + style.offsetY;
  return { text: shown.join(" "), words: placed, lines: textLines, box: { x: bx, y: by, width: size[0], height: size[1] }, origin: [bx + pad[0], by + pad[1]] };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (p: number) => 1 - (1 - p) ** 3;
/** Overshoots a little before settling (a pop). */
const backOut = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
};
const ENTER = { none: 0, pop: 0.18, fade: 0.14, rise: 0.2 } as const;
const EXIT = 0.25;
const BLUR_OUT = 0.15;
const COUNT = 0.6;

/** A number as said ("100,000", "87%", "$5.50"): what is around it, its value, decimals and whether it has commas. */
const NUMBER = /^([^\d]*)(\d[\d,]*(?:\.\d+)?)([^\d]*)$/;
function counted(text: string, p: number): string | undefined {
  const m = NUMBER.exec(text);
  if (!m) return undefined;
  const [, before, digits, after] = m;
  const value = Number(digits!.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10) return undefined;
  const decimals = digits!.split(".")[1]?.length ?? 0;
  const now = (value * p).toFixed(decimals);
  const shown = digits!.includes(",") ? Number(now).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : now;
  return `${before}${shown}${after}`;
}

/** The person on camera under `e`'s track at its time, each drawn again through their matte (Remove Background's). */
function people(e: ClipEval, ctx: EvalContext): Layer[] {
  const at = ctx.project.tracks.indexOf(e.track);
  const out: Layer[] = [];
  for (const track of ctx.project.tracks.slice(0, Math.max(0, at))) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== "video" || !clip.assetId || clip.start > e.time || e.time >= clip.start + clip.duration) continue;
      const stream = (clip.props.media as { stream?: number } | undefined)?.stream ?? 0;
      const matte = ctx.data<MatteData>(clip.assetId, "matte")?.streams[stream];
      if (!matte) continue;
      const main = ctx.evalClip(clip, track, e.time).main;
      if (!main || main.kind !== "visual" || main.content.type !== "source") continue;
      out.push({ ...main, matte: { source: ctx.source({ kind: "video", path: matte.path, stream: 0 }), time: main.content.time ?? 0, range: matteRange({ softness: 0.5, shrink: 0 }) } });
    }
  }
  return out;
}
const DRAW = 0.4;

/** A hand-drawn ring around a `w` × `h` box at (x, y): a little more than one turn, slightly uneven. */
function ring(x: number, y: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w / 2, h / 2];
  for (let i = 0; i <= 64; i++) {
    const a = -Math.PI * 0.6 + (i / 64) * Math.PI * 2.12;
    const wobble = 1 + 0.035 * Math.sin(a * 3 + 0.7) + (i / 64) * 0.05;
    out.push([cx + Math.cos(a) * rx * wobble, cy + Math.sin(a) * ry * wobble]);
  }
  return out;
}

/** A caption drawn word by word into one group: reveal, entrance, colours, emphasis and its decorations, exit. */
export function evaluateDynamic(e: ClipEval, ctx: EvalContext, words: CaptionWord[], style: DynamicStyle, g: DynamicGeometry, t: number, span: [number, number]) {
  const em = style.emphasis;
  const margin = Math.ceil(style.size * Math.max(1, em.scale) * 1.2);
  const gx = Math.floor(g.box.x - margin);
  const gy = Math.floor(g.box.y - margin);
  const gw = Math.ceil(g.box.width + 2 * margin);
  const gh = Math.ceil(g.box.height + 2 * margin);
  const ox = g.origin[0] - gx;
  const oy = g.origin[1] - gy;
  const layers: Layer[] = [];
  const exit = style.exit === "fade" ? clamp01((span[1] - t) / EXIT) : style.exit === "blur" ? clamp01((span[1] - t) / BLUR_OUT) : 1;
  const phraseIn = style.reveal === "phrase" && style.enter !== "none" ? clamp01((t - span[0]) / ENTER[style.enter]) : 1;
  const current = words.findLastIndex((w) => w.start <= t);
  if (style.background[3] > 0) layers.push(solidLayer(style.background, [g.box.width, g.box.height], Math.min(style.cornerRadius, g.box.height / 2), [g.box.x - gx, g.box.y - gy]));

  // Emphasised runs, a run per line: decorated together, drawn on from their first word.
  const runs: PlacedWord[][] = [];
  for (const p of g.words) {
    const last = runs.at(-1)?.at(-1);
    if (p.em && last && last.line === p.line && last.index === p.index - 1) runs.at(-1)!.push(p);
    else if (p.em) runs.push([p]);
  }
  const decorations: Layer[] = [];
  if (em.decoration !== "none") {
    for (const run of runs) {
      const from = style.reveal === "word" ? words[run[0]!.index]!.start : span[0];
      const p = clamp01((t - from) / DRAW);
      if (p <= 0) continue;
      const size = run[0]!.spec.size;
      const x0 = ox + run[0]!.x;
      const x1 = ox + run.at(-1)!.x + run.at(-1)!.width;
      const top = oy + Math.min(...run.map((r) => r.y));
      const bottom = oy + Math.max(...run.map((r) => r.y + r.height));
      if (em.decoration === "highlighter") {
        const h = (bottom - top) * 0.62;
        const w = (x1 - x0 + size * 0.3) * easeOut(p);
        decorations.push({ ...solidLayer(em.decorationColor, [w, h], h * 0.15, [x0 - size * 0.15, bottom - h - (bottom - top) * 0.1]), opacity: exit });
        continue;
      }
      const sw = Math.max(2, size * 0.07);
      const path: [number, number][] =
        em.decoration === "underline"
          ? Array.from({ length: 17 }, (_, i) => [x0 + ((x1 - x0) * i) / 16, bottom + size * 0.02 + Math.sin((i / 16) * Math.PI) * size * 0.04] as [number, number])
          : em.decoration === "ellipse"
            ? ring(x0 - size * 0.45, top - size * 0.12, x1 - x0 + size * 0.9, bottom - top + size * 0.24)
            : [[x0 - size * 0.25, top - size * 0.05], [x1 + size * 0.25, top - size * 0.05], [x1 + size * 0.25, bottom + size * 0.02], [x0 - size * 0.25, bottom + size * 0.02], [x0 - size * 0.25, top - size * 0.05]];
      decorations.push({
        kind: "visual",
        content: { type: "source", source: ctx.source({ kind: "strokes", lines: trimLines([path], easeOut(p)), width: gw, height: gh, strokeWidth: sw, color: em.decorationColor, scale: 1 }) },
        size: [gw, gh],
        transform: [1, 0, 0, 1, 0, 0],
        opacity: exit,
      });
    }
  }
  // The highlighter goes under the words, lines over them.
  layers.push(...decorations.filter((d) => d.kind === "visual" && d.content.type === "solid"));

  for (const p of g.words) {
    const w = words[p.index]!;
    const appear = style.reveal === "word" ? w.start : span[0];
    if (style.reveal === "word" && t < appear) continue;
    const k = style.reveal === "word" && style.enter !== "none" ? clamp01((t - appear) / ENTER[style.enter]) : phraseIn;
    const enter = style.enter;
    let opacity = exit;
    let scale = 1;
    let dy = 0;
    if (enter === "pop") {
      opacity *= clamp01(k * 3);
      scale = 0.5 + 0.5 * backOut(k);
    } else if (enter === "fade") opacity *= easeOut(k);
    else if (enter === "rise") {
      opacity *= easeOut(k);
      dy = (1 - easeOut(k)) * p.spec.size * 0.35;
    }
    if (opacity <= 0) continue;
    const color: RGBA = p.em
      ? em.color
      : p.index === current && style.highlight[3] > 0
        ? style.highlight
        : p.index > current && style.reveal === "phrase" && style.upcoming[3] > 0
          ? style.upcoming
          : style.color;
    // A number counting up is drawn against its right end, where the final figure ends, so it doesn't jump.
    const count = style.countUp ? counted(p.text, easeOut(clamp01((t - appear) / COUNT))) : undefined;
    const spec = count !== undefined && count !== p.text ? { ...p.spec, color, text: count, align: "right" as const, width: Math.ceil(p.width / p.sx) + 1 } : { ...p.spec, color };
    const cx = ox + p.x + (spec.width * p.sx) / 2;
    const cy = oy + p.y + p.height / 2;
    const layer: VisualLayer = {
      kind: "visual",
      content: { type: "source", source: ctx.source({ kind: "text", ...spec }) },
      size: [spec.width, spec.height],
      transform: [scale * p.sx, 0, 0, scale, cx - ((spec.width * p.sx) / 2) * scale, cy - (p.height / 2) * scale + dy],
      opacity,
    };
    if (p.em && em.glow[3] > 0) layer.passes = [{ pass: "drop-shadow", params: shadowParams({ angle: 0, offset: 0, blur: p.spec.size * 0.5, opacity: 1, color: em.glow }) }];
    layers.push(layer);
  }
  layers.push(...decorations.filter((d) => !(d.kind === "visual" && d.content.type === "solid")));

  const group: VisualLayer = {
    kind: "visual",
    content: { type: "group", background: [0, 0, 0, 0], layers },
    size: [gw, gh],
    transform: [1, 0, 0, 1, gx, gy],
  };
  if (style.shadow[3] > 0) group.passes = [{ pass: "drop-shadow", params: shadowParams({ angle: style.shadowAngle, offset: style.shadowDistance, blur: style.shadowBlur, opacity: 1, color: style.shadow }) }];
  if (style.exit === "blur" && exit < 1) (group.passes ??= []).push({ pass: "remove-background-blur", params: [(1 - exit) * style.size * 0.35] });
  e.layers.push(group);
  e.main = group;
  if (style.behind) e.layers.push(...people(e, ctx));
}
