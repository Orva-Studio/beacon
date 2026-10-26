import { z } from "zod";
import type { Easing, TextSpec } from "@beacon/model";
import type { TextLine } from "@beacon/media";

/** An animation block of a part, in seconds from the part's start. */
export interface PartAnimation {
  end: number;
  duration: number;
  easing: Easing;
  to: Record<string, unknown>;
}

/** A clip a block makes, in seconds from the block's start; ids are given when it is placed. */
export interface Part {
  type: string;
  start: number;
  duration: number;
  props: Record<string, unknown>;
  effects: { type: string; params: Record<string, unknown> }[];
  animations: PartAnimation[];
}

export interface BlockEnv {
  /** The canvas, in pixels: the block's group is drawn on one this size. */
  width: number;
  height: number;
  /** Seconds the block lasts. */
  length: number;
  /** The Text annotation's look (font, colour, its drop shadow), which blocks start from. */
  text: { spec: Omit<TextSpec, "width" | "height" | "scale">; effects: Part["effects"] };
  layout: (spec: TextSpec) => TextLine[];
}

export interface BlockDef<F = any> {
  id: string;
  title: string;
  description: string;
  fields: z.ZodType<F>;
  /** Seconds it lasts when not given. */
  seconds: number;
  /** Tracks of parts, bottom → top. */
  build: (fields: F, env: BlockEnv) => Part[][];
}

const defineBlock = <F>(b: BlockDef<F>) => b;

/** Seconds a word takes to come in; the next starts a little after. */
const WORD_IN = 0.6;
/** The longest the words take to start, however many there are. */
const STAGGER_MAX = 0.8;
const OUT = 0.35;

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

/** Shrinks the text until it fits in `lines` lines across `width`. */
function fit(env: BlockEnv, base: TextSpec, lines: number): { spec: TextSpec; laid: TextLine[] } {
  let spec = base;
  let laid = env.layout(spec);
  for (let n = 0; n < 8 && laid.length > lines; n++) {
    spec = { ...spec, size: spec.size * 0.88 };
    laid = env.layout(spec);
  }
  return { spec, laid };
}

/** A text callout part whose box is centred at canvas pixels `cx`, `cy` (from the top left). */
function textPart(env: BlockEnv, spec: TextSpec, text: string, box: [number, number], centre: [number, number], start: number, length: number): Part {
  const { width: _w, height: _h, scale: _s, ...look } = spec;
  return {
    type: "callout",
    start,
    duration: length,
    props: {
      callout: { shape: "text", width: box[0], height: box[1], cornerRadius: 0, text: { ...look, text, align: "center", valign: "center" } },
      transform: { x: centre[0] - env.width / 2, y: env.height / 2 - centre[1], scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 },
    },
    effects: env.text.effects.map((fx) => ({ ...fx, params: { ...fx.params } })),
    animations: [],
  };
}

/** Comes in from `rise` pixels below, fading in, starting at `at`; fades out at the end when there is time. */
function inAndOut(part: Part, at: number, rise: number, length: number) {
  const t = part.props.transform as { y: number; opacity: number };
  const y = t.y;
  t.y = y - rise;
  t.opacity = 0;
  part.animations.push({ end: at + WORD_IN * 0.7, duration: WORD_IN * 0.7, easing: "easeOut", to: { "transform.opacity": 1 } });
  part.animations.push({ end: at + WORD_IN, duration: WORD_IN, easing: "backOut", to: { "transform.y": y } });
  if (length - OUT > at + WORD_IN + 0.3) part.animations.push({ end: length, duration: OUT, easing: "easeIn", to: { "transform.opacity": 0 } });
}

export const title = defineBlock({
  id: "title",
  title: "Title",
  description: "Large words coming in one after another, with an optional line under them",
  fields: z.strictObject({
    text: z.string().trim().min(1).max(80).describe("The title: a few words"),
    subtitle: z.string().trim().max(120).optional().describe("A smaller line under it"),
  }),
  seconds: 4,
  build({ text, subtitle }, env) {
    const k = env.height / 1080;
    const boxWidth = env.width * 0.8;
    const base: TextSpec = { ...env.text.spec, text, weight: 700, size: 132 * k, width: boxWidth, height: env.height, align: "center", valign: "top", scale: 1 };
    const { spec, laid } = fit(env, base, 2);
    const sub = subtitle ? { ...spec, text: subtitle, weight: 400, size: spec.size * 0.4, height: env.height, color: [...spec.color.slice(0, 3), spec.color[3] * 0.85] as TextSpec["color"] } : undefined;
    const subLines = sub ? fit(env, sub, 2) : undefined;
    const top = laid[0]!.top;
    const titleHeight = laid.at(-1)!.bottom - top;
    const gap = 24 * k;
    const subHeight = subLines ? subLines.laid.at(-1)!.bottom - subLines.laid[0]!.top : 0;
    // The title and its line are centred on the canvas together.
    const y0 = (env.height - titleHeight - (subLines ? gap + subHeight : 0)) / 2;
    const left = (env.width - boxWidth) / 2;
    const words = laid.flatMap((line) => wordsOf(text, line).map(([s, e]) => ({ line, s, e })));
    const step = Math.min(0.08, STAGGER_MAX / Math.max(1, words.length - 1));
    const pad = spec.size * 0.3;
    const parts = words.map(({ line, s, e }, i) => {
      const [x0, x1] = [line.carets[s - line.start]!, line.carets[e - line.start]!];
      const h = (line.bottom - line.top) * 1.4;
      const part = textPart(env, spec, text.slice(s, e), [x1 - x0 + 2 * pad, h], [left + (x0 + x1) / 2, y0 + (line.top + line.bottom) / 2 - top], 0, env.length);
      inAndOut(part, i * step, 40 * k, env.length);
      return part;
    });
    if (subLines) {
      const lines = subLines.laid;
      const h = lines.at(-1)!.bottom - lines[0]!.top;
      const part = textPart(env, subLines.spec, subtitle!, [boxWidth, h * 1.3], [env.width / 2, y0 + titleHeight + gap + h / 2], 0, env.length);
      inAndOut(part, (words.length - 1) * step + WORD_IN * 0.5, 20 * k, env.length);
      parts.push(part);
    }
    // Each on its own track: they all last the whole block.
    return parts.map((p) => [p]);
  },
});

export const BLOCKS: BlockDef[] = [title];

export function blockOf(id: string): BlockDef {
  const b = BLOCKS.find((x) => x.id === id);
  if (!b) throw new Error(`no motion graphics block "${id}"; there are: ${BLOCKS.map((x) => x.id).join(", ")}`);
  return b;
}
