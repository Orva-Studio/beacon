import { z } from "zod";
import {
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  RgbaSchema,
  roundSeconds,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type Clip,
  type EvalContext,
  type ClipEval,
  type Project,
  type RGBA,
  type TextSpec,
  type VisualLayer,
} from "@beacon/model";
import { textLayout, type TextLine } from "@beacon/media";
import { timelineWords, type TimelineWord } from "../transcript";

const WordSchema = z.strictObject({ text: z.string().min(1), start: z.number(), end: z.number() });
type CaptionWord = z.infer<typeof WordSchema>;

/** What a caption says: its words, timed in its own media seconds (`mediaStart` onwards), so trims and cuts keep them in step. */
const captionSchema = z.strictObject({ words: z.array(WordSchema) });

const styleSchema = z.strictObject({
  font: z.string(),
  weight: z.number(),
  /** Canvas pixels. */
  size: z.number().positive(),
  color: RgbaSchema,
  /** The box behind the text; transparent for none. */
  background: RgbaSchema,
  cornerRadius: z.number().nonnegative(),
  position: z.enum(["bottom", "middle", "top"]),
  /** Canvas pixels from the top or bottom edge. */
  margin: z.number().nonnegative(),
  /** The word being spoken; transparent for none. */
  highlight: RgbaSchema,
  /** Widest a line runs, as a fraction of the canvas width. */
  maxWidth: z.number().min(0.2).max(1),
  uppercase: z.boolean(),
});
export type CaptionStyle = z.infer<typeof styleSchema>;

/** Sized for a canvas `height` pixels tall. */
export function defaultStyle(height = 1080): CaptionStyle {
  const k = height / 1080;
  return {
    font: "Helvetica Neue",
    weight: 700,
    size: Math.round(54 * k),
    color: [1, 1, 1, 1],
    background: [0, 0, 0, 0.75],
    cornerRadius: Math.round(12 * k),
    position: "bottom",
    margin: Math.round(80 * k),
    highlight: [1, 0.84, 0.2, 1],
    maxWidth: 0.8,
    uppercase: false,
  };
}

/** The words a caption clip shows: those whose middle is inside its window on its media. */
export function shownWords(clip: Clip): CaptionWord[] {
  const words = (clip.props.caption as { words?: CaptionWord[] } | undefined)?.words ?? [];
  const from = ticksToSeconds(clip.mediaStart ?? 0);
  const to = from + ticksToSeconds(clip.duration);
  return words.filter((w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to);
}

const captionText = (words: CaptionWord[], style: CaptionStyle) => {
  const text = words.map((w) => w.text).join(" ");
  return style.uppercase ? text.toUpperCase() : text;
};

/** Laid out once per text and style: evaluated every frame, the same caption shows for seconds. */
const layouts = new Map<string, TextLine[]>();
function layout(spec: TextSpec): TextLine[] {
  const key = JSON.stringify(spec);
  let lines = layouts.get(key);
  if (!lines) {
    if (layouts.size > 500) layouts.clear();
    lines = textLayout(spec);
    layouts.set(key, lines);
  }
  return lines;
}

function solid(color: RGBA, size: [number, number], at: [number, number], radius: number): VisualLayer {
  return { kind: "visual", content: { type: "solid", color }, size, transform: [1, 0, 0, 1, at[0], at[1]], radius: [radius, radius, radius, radius] };
}

function evaluateCaption(e: ClipEval, ctx: EvalContext) {
  const words = shownWords(e.clip);
  if (!words.length) return;
  const style = e.props.captionStyle as CaptionStyle;
  const text = captionText(words, style);
  const width = Math.max(1, Math.round(ctx.canvas.width * style.maxWidth));
  const base: TextSpec = { text, font: style.font, weight: style.weight, italic: false, size: style.size, color: style.color, tracking: 0, lineSpacing: 0, align: "center", valign: "top", width, height: ctx.canvas.height, scale: 1 };
  const lines = layout(base);
  if (!lines.length) return;
  const left = Math.min(...lines.map((l) => l.carets[0]!));
  const right = Math.max(...lines.map((l) => l.carets.at(-1)!));
  const top = lines[0]!.top;
  const bottom = lines.at(-1)!.bottom;
  const pad: [number, number] = [style.size * 0.45, style.size * 0.2];
  const box: [number, number] = [right - left + 2 * pad[0], bottom - top + 2 * pad[1]];
  const boxX = (ctx.canvas.width - box[0]) / 2;
  const boxY = style.position === "top" ? style.margin : style.position === "middle" ? (ctx.canvas.height - box[1]) / 2 : ctx.canvas.height - style.margin - box[1];
  // The text's own box is `width` wide, centred: its lines sit at their carets inside it.
  const textX = boxX + pad[0] - left;
  const textY = boxY + pad[1] - top;
  const textHeight = Math.ceil(bottom) + 2;
  if (style.background[3] > 0) e.layers.push(solid(style.background, box, [boxX, boxY], Math.min(style.cornerRadius, box[1] / 2)));
  const main: VisualLayer = {
    kind: "visual",
    content: { type: "source", source: ctx.source({ kind: "text", ...base, height: textHeight }) },
    size: [width, textHeight],
    transform: [1, 0, 0, 1, textX, textY],
  };
  e.layers.push(main);
  e.main = main;
  if (style.highlight[3] <= 0) return;
  const t = ticksToSeconds(e.mediaTime);
  const k = words.findLastIndex((w) => w.start <= t);
  if (k < 0) return;
  const offset = words.slice(0, k).reduce((n, w) => n + w.text.length + 1, 0);
  const word = text.slice(offset, offset + words[k]!.text.length);
  const line = lines.find((l) => offset >= l.start && offset < l.end);
  if (!line) return;
  const x0 = line.carets[offset - line.start]!;
  const x1 = line.carets[Math.min(offset + word.length, line.end) - line.start]!;
  const spec: TextSpec = { ...base, text: word, color: style.highlight, align: "left", width: Math.ceil(x1 - x0 + style.size), height: Math.ceil(line.bottom - line.top) + 2 };
  e.layers.push({
    kind: "visual",
    content: { type: "source", source: ctx.source({ kind: "text", ...spec }) },
    size: [spec.width, spec.height],
    transform: [1, 0, 0, 1, textX + x0, textY + line.top],
  });
}

/** Captions from the transcript's words: a new caption at a sentence end, a pause, or `maxWords` / `maxChars`. */
function phrases(words: TimelineWord[], maxWords: number, maxChars: number, gap: number): TimelineWord[][] {
  const out: TimelineWord[][] = [];
  let cur: TimelineWord[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || w.start - prev.end >= gap || /[.!?]$/.test(prev.text))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A caption stays up this long after its last word, unless the next one starts first. */
const HOLD = 0.6;

const isCaption = (c: Clip) => c.type === "caption";

/** Caption clips on the timeline's shown tracks with their text, in timeline seconds within [from, to), from `from`. */
function captionEntries(project: Project, from: number, to: number) {
  const out: { start: number; end: number; text: string }[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips.filter(isCaption)) {
      const words = shownWords(clip);
      const start = Math.max(from, ticksToSeconds(clip.start));
      const end = Math.min(to, ticksToSeconds(clip.start + clip.duration));
      if (words.length && end > start) out.push({ start: start - from, end: end - from, text: captionText(words, { ...defaultStyle(), ...(clip.props.captionStyle as Partial<CaptionStyle>) }) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const srtTime = (s: number) => {
  const ms = Math.round(s * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, "0")}`;
};

/** Long captions over two lines, as players expect. */
function srtLines(text: string): string {
  if (text.length <= 42) return text;
  const words = text.split(" ");
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const d = (n: number) => Math.abs(words.slice(0, n).join(" ").length - words.slice(n).join(" ").length);
    if (d(i) < d(best)) best = i;
  }
  return `${words.slice(0, best).join(" ")}\n${words.slice(best).join(" ")}`;
}

export function srt(project: Project, from = 0, to = Infinity): string {
  return captionEntries(project, from, to)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${srtLines(c.text)}\n`)
    .join("\n");
}

const StyleArgs = styleSchema.partial();

/** Captions: phrases from the transcript as caption clips on their own track, burned into the export with an `.srt` beside it. */
export const captions = defineFeature({
  id: "captions",
  version: 1,
  clipTypes: [{ id: "caption", description: "A caption: words from the transcript, shown with the captions' style while they are spoken", traits: ["caption"] }],
  props: [
    { id: "caption", description: "The caption's words, timed in its media seconds", traits: ["caption"], schema: captionSchema, defaults: () => ({ words: [] }), identity: true },
    { id: "captionStyle", description: "How captions look: font, size, colour, the box behind them, where they sit and the spoken word's highlight", traits: ["caption"], schema: styleSchema, defaults: () => defaultStyle() },
  ],
  commands: [
    defineCommand({
      id: "captions.create",
      description:
        "Captions from the transcript: each phrase (up to `maxWords` words, a new one at sentence ends and pauses) becomes a caption clip on a Captions track at the top, replacing captions made before; burned into exports, with an .srt beside them. Returns the caption clip ids. Use 2-4 words for short phrase captions, or about 12 for a line at a time",
      args: z.strictObject({
        maxWords: z.int().min(1).max(20).default(3),
        maxChars: z.int().min(8).max(80).optional().describe("Longest caption in characters; by default about 9 per word, at most 42"),
        style: StyleArgs.optional(),
      }),
      apply(doc, { maxWords, maxChars, style }, ctx) {
        const words = timelineWords(doc, ctx.registry, ctx.data);
        if (!words.length) throw new Error("no transcript on the timeline yet: captions are made from it");
        const old = doc.tracks.findIndex((t) => t.clips.length > 0 && t.clips.every(isCaption));
        const previous = old >= 0 ? (doc.tracks[old]!.clips[0]!.props.captionStyle as Partial<CaptionStyle> | undefined) : undefined;
        const look = { ...defaultStyle(doc.settings.height), ...previous, ...style };
        const groups = phrases(words, maxWords, maxChars ?? Math.min(42, maxWords * 9), 0.5);
        const { fps } = doc.settings;
        const clips: Clip[] = [];
        for (const [i, g] of groups.entries()) {
          const start = snapSeconds(g[0]!.start, fps, "floor");
          const next = groups[i + 1]?.[0]?.start;
          let end = g.at(-1)!.end + HOLD;
          // Back to back when the next is close: a caption blinking off for a moment is distracting.
          if (next !== undefined && (end > next || next - end < 0.3)) end = next;
          const stop = Math.max(start + ticksPerFrame(fps), snapSeconds(end, fps, "floor"));
          if (clips.length && clips.at(-1)!.start + clips.at(-1)!.duration > start) clips.at(-1)!.duration = start - clips.at(-1)!.start;
          clips.push({
            id: ctx.newId("clip"),
            type: "caption",
            start,
            duration: stop - start,
            mediaStart: start,
            props: { caption: { words: g.map((w) => ({ text: w.text, start: w.start, end: w.end })) }, captionStyle: look },
            effects: [],
            animations: [],
          });
        }
        const live = clips.filter((c) => c.duration > 0);
        if (old >= 0) doc.tracks[old]!.clips = live;
        else doc.tracks.push({ id: ctx.newId("track"), name: "Captions", clips: live });
        return live.map((c) => c.id);
      },
    }),
    defineCommand({
      id: "captions.style",
      description: "Change how every caption looks (font, weight, size in canvas pixels, colours, background box, position, margin, highlight of the spoken word, max width, uppercase), one undo step. Transparent colours turn the box or the highlight off",
      args: z.strictObject({ style: StyleArgs }),
      apply(doc, { style }) {
        let n = 0;
        for (const clip of doc.tracks.flatMap((t) => t.clips).filter(isCaption)) {
          clip.props.captionStyle = { ...defaultStyle(doc.settings.height), ...(clip.props.captionStyle as Partial<CaptionStyle>), ...style };
          n++;
        }
        if (!n) throw new Error("no captions: captions.create makes them from the transcript");
        return n;
      },
    }),
    defineCommand({
      id: "caption.setText",
      description: "Correct what a caption says: its words become `text`'s, keeping their times when the count is the same, else spread over the caption's spoken span by length",
      args: z.strictObject({ clip: z.string(), text: z.string() }),
      apply(doc, { clip: id, text }) {
        const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
        if (!clip || !isCaption(clip)) throw new Error(`clip "${id}" is not a caption`);
        const old = shownWords(clip);
        const tokens = text.split(/\s+/).filter(Boolean);
        const from = old[0]?.start ?? ticksToSeconds(clip.mediaStart ?? 0);
        const to = old.at(-1)?.end ?? from + ticksToSeconds(clip.duration);
        let words: CaptionWord[];
        if (tokens.length === old.length) words = old.map((w, i) => ({ ...w, text: tokens[i]! }));
        else {
          const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
          let at = from;
          words = tokens.map((t) => {
            const w = { text: t, start: roundSeconds(at), end: roundSeconds(at + ((to - from) * t.length) / total) };
            at = w.end;
            return w;
          });
        }
        clip.props.caption = { words };
      },
    }),
  ],
  actions: [
    defineAction({
      id: "captions.add",
      description: "Make captions from the transcript (the AI panel's Captions tile does), then select the first and show its properties",
      args: z.strictObject({ maxWords: z.int().min(1).max(20).optional() }),
      resolve: ({ maxWords }) => ({
        label: "Captions",
        steps: [{ command: "captions.create", args: maxWords ? { maxWords } : {} }],
        after: ([ids]) => {
          const first = (ids as string[])[0];
          return first ? [{ command: "selection.set", args: { clips: [first] } }, { command: "inspector.tab", args: { tab: "caption" } }] : [];
        },
      }),
    }),
  ],
  queries: [
    defineQuery({
      id: "captions.srt",
      description: "The captions as an .srt (SubRip) file, in timeline seconds, or those within [from, to) counted from `from`, as an export writes it",
      args: z.strictObject({ from: z.number().nonnegative().default(0), to: z.number().positive().optional() }),
      run: ({ from, to }, { project }) => srt(project, from, to),
    }),
  ],
  exportFiles: [
    {
      id: "captions",
      extension: ".srt",
      description: "The captions as SubRip subtitles",
      write: ({ from, to }, { project }) => (project.tracks.some((t) => !t.hidden && t.clips.some(isCaption)) ? srt(project, from, to) : undefined),
    },
  ],
  evaluate: {
    clip(e, ctx) {
      if (isCaption(e.clip)) evaluateCaption(e, ctx);
    },
  },
});
