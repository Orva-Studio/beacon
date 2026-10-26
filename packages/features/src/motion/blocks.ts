import { z } from "zod";
import type { Easing, RGBA, TextSpec } from "@beacon/model";
import type { Look } from "./looks";
import type { TextLine } from "@beacon/media";

/** An animation block of a part, in seconds from the part's start. */
export interface PartAnimation {
  end: number;
  duration: number;
  easing: Easing;
  to: Record<string, unknown>;
}

/** A clip a piece makes, in seconds from the clip's start; ids are given when it is placed. */
export interface Part {
  type: string;
  start: number;
  duration: number;
  props: Record<string, unknown>;
  effects: { type: string; params: Record<string, unknown> }[];
  animations: PartAnimation[];
}

/** Where in the box a piece goes. */
export const AREAS = ["full", "top", "middle", "bottom", "left", "right"] as const;
export type Area = (typeof AREAS)[number];

export const KINDS = ["title", "lowerThird", "number", "list", "text"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * One piece of a composition, as the AI writes it: what it is, its words, when it shows (seconds from the clip's
 * start) and where in the box. Fields a kind doesn't use are empty.
 */
export const PieceSchema = z.strictObject({
  kind: z.enum(KINDS),
  start: z.number(),
  end: z.number(),
  area: z.enum(AREAS),
  /** The title, the name (lower third), the label under a number, or the line of text. */
  text: z.string().max(120),
  /** The line under a title, or the role under a name. */
  detail: z.string().max(120),
  /** A number's value, and what goes before and after it ("$", "%"). */
  value: z.number(),
  prefix: z.string().max(8),
  suffix: z.string().max(12),
  /** A list's items. */
  items: z.array(z.string().max(80)).max(6),
});
export type Piece = z.infer<typeof PieceSchema>;

/** What the kinds are, for the AI and for agents. */
export const KIND_GUIDE: Record<Kind, string> = {
  title: "a few large words coming in one after another (`text`), an optional smaller line under them (`detail`)",
  lowerThird: "a name (`text`) and a role or place (`detail`) on a bar that wipes in, low and to the left",
  number: "a number counting up to `value`, with `prefix` / `suffix` (\"$\", \"%\", \"x\") and a label under it (`text`)",
  list: "2 to 5 short `items`, each coming in after the one before, with a dot",
  text: "one line of text (`text`)",
};

/** Behind a graphic, in its box: nothing, the talk darkened, or a card in the Look's card colour. */
export const BACKGROUNDS = ["none", "dim", "card"] as const;
export type Background = (typeof BACKGROUNDS)[number];

export interface BuildEnv {
  /** The box, in pixels: the clip's group canvas. */
  width: number;
  height: number;
  /** Seconds the clip lasts. */
  length: number;
  look: Look;
  /** The Text annotation's font, for a Look's empty font and one this Mac hasn't. */
  fallbackFont: string;
  hasFont: (family: string) => boolean;
  background: Background;
  layout: (spec: TextSpec) => TextLine[];
}

/** Where pieces sit: x, y, width, height in box pixels from its top left. */
type Rect = [number, number, number, number];

/** Seconds a part takes to come in at the Look's speed 1; the next starts a little after. */
const IN = 0.6;
const STAGGER_MAX = 0.8;
const OUT = 0.35;

export function areaRect(area: Area, w: number, h: number): Rect {
  switch (area) {
    case "full":
      return [0, 0, w, h];
    case "top":
      return [0, 0, w, h / 3];
    case "middle":
      return [0, h / 3, w, h / 3];
    case "bottom":
      return [0, (2 * h) / 3, w, h / 3];
    case "left":
      return [0, 0, w / 2, h];
    case "right":
      return [w / 2, 0, w / 2, h];
  }
}

/** Pixels per design point in a rect: text sizes below are for a 1920-wide strip at least 400 tall. */
const unit = ([, , w, h]: Rect) => Math.min(w / 1920, h / 400);

const comeInTime = (env: BuildEnv) => IN / env.look.speed;

/** Non-space runs of a laid-out line, as offsets into the text. */
function wordsOf(text: string, line: TextLine): [number, number][] {
  const out: [number, number][] = [];
  let i = line.start;
  while (i < line.end) {
    while (i < line.end && /\s/.test(text[i]!)) i++;
    const s = i;
    while (i < line.end && !/\s/.test(text[i]!)) i++;
    if (i > s) out.push([s, i]);
  }
  return out;
}

/** The text shrunk until it fits in `lines` lines and `height` pixels. */
function fit(env: BuildEnv, base: TextSpec, lines: number, height: number): { spec: TextSpec; laid: TextLine[] } {
  let spec = base;
  let laid = env.layout(spec);
  const tall = (l: TextLine[]) => (l.length ? l.at(-1)!.bottom - l[0]!.top : 0);
  for (let n = 0; n < 12 && (laid.length > lines || tall(laid) > height); n++) {
    spec = { ...spec, size: spec.size * 0.88 };
    laid = env.layout(spec);
  }
  return { spec, laid };
}

/** The Look's font for a role, the Text annotation's when it has none or this Mac hasn't it. */
const fontOf = (env: BuildEnv, role: "heading" | "body") => {
  const f = env.look[role].font;
  return f && env.hasFont(f) ? f : env.fallbackFont;
};

const textSpec = (env: BuildEnv, role: "heading" | "body", text: string, size: number, width: number, align: TextSpec["align"] = "center", weight = env.look[role].weight): TextSpec => ({
  text,
  font: fontOf(env, role),
  weight,
  italic: false,
  size,
  color: env.look.text,
  tracking: 0,
  lineSpacing: 0,
  width,
  height: 10_000,
  align,
  valign: "top",
  scale: 1,
});

const placeAt = (env: BuildEnv, cx: number, cy: number) => ({ x: cx - env.width / 2, y: env.height / 2 - cy, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 });

/** The Look's shadow, scaled to the box, as the drop-shadow effect takes it. */
function shadow(env: BuildEnv): Part["effects"] {
  const s = env.look.shadow;
  if (!s) return [];
  const k = env.height / 1080;
  return [{ type: "drop-shadow", params: { angle: s.angle, offset: s.offset * k, blur: s.blur * k, opacity: s.opacity, color: s.color } }];
}

/** A text part whose box is centred at box pixels `cx`, `cy`. */
function textPart(env: BuildEnv, spec: TextSpec, text: string, box: [number, number], [cx, cy]: [number, number], piece: Piece, shadowed = true): Part {
  const { width: _w, height: _h, scale: _s, text: _t, ...look } = spec;
  return {
    type: "callout",
    start: piece.start,
    duration: piece.end - piece.start,
    props: {
      callout: { shape: "text", width: box[0], height: box[1], cornerRadius: 0, text: { ...look, text, valign: "center" } },
      transform: placeAt(env, cx, cy),
    },
    effects: shadowed ? shadow(env) : [],
    animations: [],
  };
}

function boxPart(env: BuildEnv, size: [number, number], [cx, cy]: [number, number], fill: RGBA, radius: number, piece: Pick<Piece, "start" | "end">): Part {
  return {
    type: "callout",
    start: piece.start,
    duration: piece.end - piece.start,
    props: { callout: { shape: "rectangle", width: size[0], height: size[1], cornerRadius: radius, fill }, transform: placeAt(env, cx, cy) },
    effects: [],
    animations: [],
  };
}

/** Fades out over the part's last moments, when it lasts long enough for that. */
function fadeOut(part: Part, after: number) {
  if (part.duration - OUT > after + 0.3) part.animations.push({ end: part.duration, duration: OUT, easing: "easeIn", to: { "transform.opacity": 0 } });
}

/**
 * Comes in at `at` (seconds into the part) as the Look has it, fading in, then fades out at its end: from `distance`
 * box pixels below (rise) or to the left (slide), growing (scale), or wiped in from its left edge (wipe); a moving
 * one blurred along its motion when the Look says so.
 */
function comeIn(part: Part, at: number, distance: number, env: BuildEnv, entrance = env.look.entrance) {
  const t = part.props.transform as { x: number; y: number; scaleX: number; scaleY: number; opacity: number };
  const d = comeInTime(env);
  const { easing } = env.look;
  t.opacity = 0;
  part.animations.push({ end: at + d * 0.7, duration: d * 0.7, easing: "easeOut", to: { "transform.opacity": 1 } });
  if (entrance === "rise") {
    const y = t.y;
    t.y = y - distance;
    part.animations.push({ end: at + d, duration: d, easing, to: { "transform.y": y } });
  } else if (entrance === "slide") {
    const x = t.x;
    t.x = x - distance * 1.5;
    part.animations.push({ end: at + d, duration: d, easing, to: { "transform.x": x } });
  } else if (entrance === "scale") {
    t.scaleX = t.scaleY = 0.7;
    part.animations.push({ end: at + d, duration: d, easing, to: { "transform.scaleX": 1, "transform.scaleY": 1 } });
  } else {
    const c = part.props.callout as { width: number };
    part.props.crop = { left: 0, top: 0, right: c.width, bottom: 0 };
    part.animations.push({ end: at + d, duration: d, easing, to: { "crop.right": 0 } });
  }
  if (env.look.motionBlur > 0 && entrance !== "wipe") part.effects.push({ type: "motion-blur", params: { intensity: env.look.motionBlur } });
  fadeOut(part, at + d);
}

/** Large words coming in one after another, a smaller line under them. */
function title(p: Piece, r: Rect, env: BuildEnv): Part[] {
  const u = unit(r);
  const [x, y, w, h] = r;
  const boxWidth = w * 0.9;
  const sub = p.detail.trim();
  const { spec, laid } = fit(env, textSpec(env, "heading", p.text, 132 * u, boxWidth), 2, h * (sub ? 0.6 : 0.85));
  const under = sub ? fit(env, textSpec(env, "body", sub, spec.size * 0.4, boxWidth), 2, h * 0.25) : undefined;
  const top = laid[0]!.top;
  const titleHeight = laid.at(-1)!.bottom - top;
  const gap = spec.size * 0.2;
  const subHeight = under ? under.laid.at(-1)!.bottom - under.laid[0]!.top : 0;
  const y0 = y + (h - titleHeight - (under ? gap + subHeight : 0)) / 2;
  const left = x + (w - boxWidth) / 2;
  const words = laid.flatMap((line) => wordsOf(p.text, line).map(([s, e]) => ({ line, s, e })));
  const step = Math.min(0.08, STAGGER_MAX / Math.max(1, words.length - 1)) / env.look.speed;
  const pad = spec.size * 0.3;
  const parts = words.map(({ line, s, e }, i) => {
    const [x0, x1] = [line.carets[s - line.start]!, line.carets[e - line.start]!];
    const part = textPart(env, spec, p.text.slice(s, e), [x1 - x0 + 2 * pad, (line.bottom - line.top) * 1.4], [left + (x0 + x1) / 2, y0 + (line.top + line.bottom) / 2 - top], p);
    comeIn(part, i * step, 40 * u, env);
    return part;
  });
  if (under) {
    const color = [...under.spec.color.slice(0, 3), under.spec.color[3] * 0.85] as RGBA;
    const part = textPart(env, { ...under.spec, color }, sub, [boxWidth, subHeight * 1.3], [x + w / 2, y0 + titleHeight + gap + subHeight / 2], p);
    comeIn(part, (words.length - 1) * step + comeInTime(env) * 0.5, 20 * u, env);
    parts.push(part);
  }
  return parts;
}

/** A name and a role on a bar that wipes in from the left, low and to the left of the area. */
function lowerThird(p: Piece, r: Rect, env: BuildEnv): Part[] {
  const [x, y, w, h] = r;
  const u = Math.min(w / 1920, h / 1080) * 1.6;
  const role = p.detail.trim();
  const name = fit(env, textSpec(env, "heading", p.text, 56 * u, w * 0.7, "left"), 1, h * 0.2);
  const sub = role ? fit(env, textSpec(env, "body", role, name.spec.size * 0.6, w * 0.7, "left"), 1, h * 0.12) : undefined;
  const widthOf = (l: TextLine[]) => Math.max(...l.map((line) => line.carets.at(-1)! - line.carets[0]!));
  const lineH = (l: TextLine[]) => l.at(-1)!.bottom - l[0]!.top;
  const pad = 28 * u;
  const stripe = 8 * u;
  const d = comeInTime(env);
  const textW = Math.max(widthOf(name.laid), sub ? widthOf(sub.laid) : 0);
  const [barW, barH] = [textW + 2 * pad + stripe, lineH(name.laid) + (sub ? lineH(sub.laid) + 6 * u : 0) + 2 * pad * 0.7];
  const [bx, by] = [x + w * 0.06, y + h * 0.88 - barH];
  const bar = boxPart(env, [barW, barH], [bx + barW / 2, by + barH / 2], env.look.card, 6 * u, p);
  // The bar wipes in: its crop from the right shrinks to nothing.
  bar.props.crop = { left: 0, top: 0, right: barW, bottom: 0 };
  bar.animations.push({ end: d, duration: d, easing: "easeOut", to: { "crop.right": 0 } });
  fadeOut(bar, d);
  const accent = boxPart(env, [stripe, barH], [bx + stripe / 2, by + barH / 2], env.look.accent, 0, p);
  (accent.props.transform as { opacity: number }).opacity = 0;
  accent.animations.push({ end: 0.15, duration: 0.15, easing: "easeOut", to: { "transform.opacity": 1 } });
  fadeOut(accent, 0.15);
  const tx = bx + stripe + pad;
  const top = by + pad * 0.7;
  // On a bar the name slides (or wipes) in along it, whatever the Look's entrance.
  const along = env.look.entrance === "wipe" ? "wipe" : "slide";
  const namePart = textPart(env, name.spec, p.text, [w * 0.7, lineH(name.laid) * 1.3], [tx + (w * 0.7) / 2, top + lineH(name.laid) / 2], p, false);
  comeIn(namePart, d * 0.5, 20 * u, env, along);
  const parts = [bar, accent, namePart];
  if (sub) {
    const color = [...sub.spec.color.slice(0, 3), sub.spec.color[3] * 0.8] as RGBA;
    const part = textPart(env, { ...sub.spec, color }, role, [w * 0.7, lineH(sub.laid) * 1.3], [tx + (w * 0.7) / 2, top + lineH(name.laid) + 6 * u + lineH(sub.laid) / 2], p, false);
    comeIn(part, d * 0.75, 20 * u, env, along);
    parts.push(part);
  }
  return parts;
}

/** A big number counting up to its value, a label under it. */
function number(p: Piece, r: Rect, env: BuildEnv): Part[] {
  const [x, y, w, h] = r;
  const u = unit(r);
  const label = p.text.trim();
  const decimals = Number.isInteger(p.value) ? 0 : Math.min(2, (String(p.value).split(".")[1] ?? "").length);
  const shown = `${p.prefix}${new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(p.value)}${p.suffix}`;
  const big = fit(env, textSpec(env, "heading", shown, 220 * u, w * 0.9), 1, h * (label ? 0.6 : 0.85));
  const under = label ? fit(env, textSpec(env, "body", label, big.spec.size * 0.26, w * 0.9), 2, h * 0.25) : undefined;
  const lineH = (l: TextLine[]) => l.at(-1)!.bottom - l[0]!.top;
  const gap = big.spec.size * 0.08;
  const total = lineH(big.laid) + (under ? gap + lineH(under.laid) : 0);
  const y0 = y + (h - total) / 2;
  const count = textPart(env, big.spec, `${p.prefix}{n}${p.suffix}`, [w * 0.95, lineH(big.laid) * 1.3], [x + w / 2, y0 + lineH(big.laid) / 2], p);
  (count.props.callout as Record<string, unknown>).count = { from: 0, to: p.value, seconds: Math.min(1.6, Math.max(0.4, (p.end - p.start) * 0.45)) / env.look.speed, decimals };
  // A counting number grows in: a wipe or slide would show its width changing as the digits do.
  comeIn(count, 0, 30 * u, env, env.look.entrance === "rise" ? "rise" : "scale");
  const parts = [count];
  if (under) {
    const part = textPart(env, under.spec, label, [w * 0.9, lineH(under.laid) * 1.3], [x + w / 2, y0 + lineH(big.laid) + gap + lineH(under.laid) / 2], p);
    comeIn(part, comeInTime(env) * 0.6, 20 * u, env);
    parts.push(part);
  }
  return parts;
}

/** Items one under another, each with a dot, coming in after the one before. */
function list(p: Piece, r: Rect, env: BuildEnv): Part[] {
  const [x, y, w, h] = r;
  const items = p.items.map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!items.length) return [];
  const u = unit(r);
  const textW = w * 0.8;
  let size = 64 * u;
  const heightAt = (s: number) => items.length * s * 1.6;
  while (heightAt(size) > h * 0.9 && size > 8) size *= 0.9;
  const fitted = items.map((it) => fit(env, textSpec(env, "body", it, size, textW, "left", 500), 1, size * 1.6));
  size = Math.min(...fitted.map((f) => f.spec.size));
  const row = size * 1.6;
  const y0 = y + (h - items.length * row) / 2;
  const dot = size * 0.32;
  // The list is centred on its widest item, not on the text boxes (as wide as the area allows).
  const widest = Math.max(...items.map((it) => Math.max(...env.layout(textSpec(env, "body", it, size, textW, "left", 500)).map((l) => l.carets.at(-1)! - l.carets[0]!))));
  const left = x + (w - widest - dot * 3) / 2;
  const step = Math.min(0.3, Math.max(0.12, (p.end - p.start - comeInTime(env) - 0.5) / Math.max(1, items.length))) / env.look.speed;
  return items.flatMap((it, i) => {
    const cy = y0 + row * (i + 0.5);
    const d = boxPart(env, [dot, dot], [left + dot / 2, cy], env.look.accent, dot / 2, p);
    comeIn(d, i * step, 16 * u, env, "slide");
    const t = textPart(env, { ...fitted[i]!.spec, size }, it, [textW, row], [left + dot * 3 + textW / 2, cy], p);
    comeIn(t, i * step + 0.06, 16 * u, env, env.look.entrance === "rise" ? "slide" : env.look.entrance);
    return [d, t];
  });
}

function text(p: Piece, r: Rect, env: BuildEnv): Part[] {
  const [x, y, w, h] = r;
  const u = unit(r);
  const { spec, laid } = fit(env, textSpec(env, "body", p.text, 72 * u, w * 0.9, "center", 600), 2, h * 0.8);
  const part = textPart(env, spec, p.text, [w * 0.9, (laid.at(-1)!.bottom - laid[0]!.top) * 1.3], [x + w / 2, y + h / 2], p);
  comeIn(part, 0, 24 * u, env);
  return [part];
}

const BUILDERS: Record<Kind, (p: Piece, r: Rect, env: BuildEnv) => Part[]> = { title, lowerThird, number, list, text };

/** A piece made usable: inside the clip, at least half a second long, with what its kind needs. */
export function tidy(p: Piece, length: number): Piece | undefined {
  const start = Math.min(Math.max(0, p.start), Math.max(0, length - 0.5));
  const end = Math.min(length, Math.max(start + 0.5, p.end));
  const piece = { ...p, start, end, text: p.text.trim(), detail: p.detail.trim() };
  const needs = p.kind === "list" ? piece.items.some((s) => s.trim()) : p.kind === "number" ? Number.isFinite(p.value) : !!piece.text;
  return needs && end - start >= 0.5 - 1e-6 ? piece : undefined;
}

/** What goes behind the pieces, over the whole clip: fading in and out with them. */
function backdrop(env: BuildEnv): Part[] {
  if (env.background === "none") return [];
  const whole = { start: 0, end: env.length };
  const { width: w, height: h } = env;
  const inset = Math.min(w, h) * 0.06;
  const part = env.background === "dim" ? boxPart(env, [w, h], [w / 2, h / 2], [0, 0, 0, 0.5], 0, whole) : boxPart(env, [w - 2 * inset, h - 2 * inset], [w / 2, h / 2], env.look.card, Math.min(w, h) * 0.04, whole);
  const t = part.props.transform as { opacity: number };
  t.opacity = 0;
  part.animations.push({ end: 0.3, duration: 0.3, easing: "easeOut", to: { "transform.opacity": 1 } });
  fadeOut(part, 0.3);
  return [part];
}

/** A composition's pieces as parts, each on its own track (bottom → top), in the box, in its Look. */
export function build(pieces: Piece[], env: BuildEnv): Part[] {
  const parts = pieces.flatMap((raw) => {
    const p = tidy(raw, env.length);
    return p ? BUILDERS[p.kind](p, areaRect(p.area, env.width, env.height), env) : [];
  });
  return parts.length ? [...backdrop(env), ...parts] : [];
}
