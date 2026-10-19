import { z } from "zod";
import {
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  eachRawClip,
  eachRawTrack,
  original,
  RgbaSchema,
  roundSeconds,
  secondsToTicks,
  snapSeconds,
  solidLayer,
  ticksPerFrame,
  ticksToSeconds,
  wordsInWindow,
  type Clip,
  type ClipEval,
  type EvalContext,
  type Project,
  type TextSpec,
  type Track,
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
  /** The edge or middle the box keeps to, up and down: two-line captions grow away from it. */
  anchorY: z.enum(["top", "middle", "bottom"]),
  /** Canvas pixels in from that edge (from the middle, down). */
  offsetY: z.number(),
  /** The edge or centre the box keeps to across; the lines align to it too. */
  anchorX: z.enum(["left", "center", "right"]),
  /** Canvas pixels in from that edge (from the centre, right). */
  offsetX: z.number(),
  /** The word being spoken; transparent for none. */
  highlight: RgbaSchema,
  /** Widest a line runs, as a fraction of the canvas width. */
  maxWidth: z.number().min(0.2).max(1),
  uppercase: z.boolean(),
});
export type CaptionStyle = z.infer<typeof styleSchema>;

/** A caption placed on its own, over its track's shared place: every field, so later changes to the shared one leave it be. */
const placeSchema = styleSchema.pick({ anchorX: true, offsetX: true, anchorY: true, offsetY: true }).partial();
type CaptionPlace = z.infer<typeof placeSchema>;

/** Sized for a canvas `height` pixels tall. */
function defaultStyle(height = 1080): CaptionStyle {
  const k = height / 1080;
  return {
    font: "Helvetica Neue",
    weight: 700,
    size: Math.round(54 * k),
    color: [1, 1, 1, 1],
    background: [0, 0, 0, 0.75],
    cornerRadius: Math.round(12 * k),
    anchorY: "bottom",
    offsetY: Math.round(80 * k),
    anchorX: "center",
    offsetX: 0,
    highlight: [1, 0.84, 0.2, 1],
    maxWidth: 0.8,
    uppercase: false,
  };
}

/** The captions' style on `track`: kept there once for all its captions. */
function trackStyle(track: Track | undefined, height: number): CaptionStyle {
  return { ...defaultStyle(height), ...(track?.props?.captionStyle as Partial<CaptionStyle> | undefined) };
}

/** How `clip` looks on `track`: the track's style, with the clip's own place if it has one. */
function clipStyle(clip: Clip, track: Track | undefined, height: number): CaptionStyle {
  return { ...trackStyle(track, height), ...(clip.props.captionPlace as CaptionPlace | undefined) };
}

/** The words a caption clip shows: those whose middle is inside its window on its media. */
function shownWords(clip: Clip): CaptionWord[] {
  return wordsInWindow(clip, (clip.props.caption as { words?: CaptionWord[] } | undefined)?.words ?? []);
}

/** Each word as shown: in capitals, a word can get longer ("Straße" is "STRASSE"), so offsets come from these. */
const shownTexts = (words: CaptionWord[], style: CaptionStyle) => words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));

const captionText = (words: CaptionWord[], style: CaptionStyle) => shownTexts(words, style).join(" ");

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

/** Where a caption's box and text sit on a `width` × `height` canvas: the box, the text's origin and lines, the text. */
function captionGeometry(words: CaptionWord[], style: CaptionStyle, canvas: { width: number; height: number }) {
  if (!words.length) return undefined;
  const text = captionText(words, style);
  const width = Math.max(1, Math.round(canvas.width * style.maxWidth));
  const spec: TextSpec = { text, font: style.font, weight: style.weight, italic: false, size: style.size, color: style.color, tracking: 0, lineSpacing: 0, align: style.anchorX, valign: "top", width, height: canvas.height, scale: 1 };
  const lines = layout(spec);
  if (!lines.length) return undefined;
  const left = Math.min(...lines.map((l) => l.carets[0]!));
  const right = Math.max(...lines.map((l) => l.carets.at(-1)!));
  const top = lines[0]!.top;
  const bottom = lines.at(-1)!.bottom;
  const pad: [number, number] = [style.size * 0.45, style.size * 0.2];
  const size: [number, number] = [right - left + 2 * pad[0], bottom - top + 2 * pad[1]];
  const x = style.anchorX === "left" ? style.offsetX : style.anchorX === "right" ? canvas.width - style.offsetX - size[0] : (canvas.width - size[0]) / 2 + style.offsetX;
  const y = style.anchorY === "top" ? style.offsetY : style.anchorY === "bottom" ? canvas.height - style.offsetY - size[1] : (canvas.height - size[1]) / 2 + style.offsetY;
  // The text's own box is `width` wide: its lines sit at their carets inside it.
  return { text, spec, lines, box: { x, y, width: size[0], height: size[1] }, origin: [x + pad[0] - left, y + pad[1] - top] as [number, number], height: Math.ceil(bottom) + 2 };
}

function evaluateCaption(e: ClipEval, ctx: EvalContext) {
  const words = shownWords(e.clip);
  const style = clipStyle(e.clip, e.track, ctx.canvas.height);
  const g = captionGeometry(words, style, ctx.canvas);
  if (!g) return;
  const { box, origin, lines, spec } = g;
  if (style.background[3] > 0) e.layers.push(solidLayer(style.background, [box.width, box.height], Math.min(style.cornerRadius, box.height / 2), [box.x, box.y]));
  const main: VisualLayer = {
    kind: "visual",
    content: { type: "source", source: ctx.source({ kind: "text", ...spec, height: g.height }) },
    size: [spec.width, g.height],
    transform: [1, 0, 0, 1, ...origin],
  };
  e.layers.push(main);
  e.main = main;
  if (style.highlight[3] <= 0) return;
  const t = ticksToSeconds(e.mediaTime);
  const k = words.findLastIndex((w) => w.start <= t);
  if (k < 0) return;
  const shown = shownTexts(words, style);
  const offset = shown.slice(0, k).reduce((n, w) => n + w.length + 1, 0);
  const word = shown[k]!;
  const line = lines.find((l) => offset >= l.start && offset < l.end);
  if (!line) return;
  const x0 = line.carets[offset - line.start]!;
  const x1 = line.carets[Math.min(offset + word.length, line.end) - line.start]!;
  const one: TextSpec = { ...spec, text: word, color: style.highlight, align: "left", width: Math.ceil(x1 - x0 + style.size), height: Math.ceil(line.bottom - line.top) + 2 };
  e.layers.push({
    kind: "visual",
    content: { type: "source", source: ctx.source({ kind: "text", ...one }) },
    size: [one.width, one.height],
    transform: [1, 0, 0, 1, origin[0] + x0, origin[1] + line.top],
  });
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * `tokens` timed from the words they replace: words kept (matched in order, ignoring case and punctuation) keep
 * their times; each run of new or changed words shares the time of the old words between the kept ones around it,
 * or the gap there, by length. Typing a caption a key at a time so keeps its timing.
 */
function retime(old: CaptionWord[], tokens: string[], from: number, to: number): CaptionWord[] {
  const [n, m] = [old.length, tokens.length];
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = norm(old[i]!.text) === norm(tokens[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const match = new Array<number | undefined>(m);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (norm(old[i]!.text) === norm(tokens[j]!)) match[j++] = i++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  const out: CaptionWord[] = [];
  for (let j = 0; j < m; ) {
    const i = match[j];
    if (i !== undefined) {
      out.push({ ...old[i]!, text: tokens[j]! });
      j++;
      continue;
    }
    let k = j;
    while (k < m && match[k] === undefined) k++;
    const before = j > 0 ? match[j - 1] : undefined;
    const after = k < m ? match[k] : undefined;
    const replaced = old.slice(before === undefined ? 0 : before + 1, after === undefined ? n : after);
    const a = replaced[0]?.start ?? (before === undefined ? from : old[before]!.end);
    const b = replaced.at(-1)?.end ?? (after === undefined ? to : old[after]!.start);
    const run = tokens.slice(j, k);
    const total = run.reduce((t, w) => t + w.length, 0) || 1;
    let at = a;
    for (const t of run) {
      const end = at + ((b - a) * t.length) / total;
      out.push({ text: t, start: roundSeconds(at), end: roundSeconds(Math.max(end, at)) });
      at = end;
    }
    j = k;
  }
  return out;
}

/** v2: a vertical `position` and `margin` became anchors with offsets on both axes. */
function anchors(doc: unknown): unknown {
  eachRawClip(doc, (c) => {
    const s = c.props?.captionStyle;
    if (s && "position" in s) {
      const { position, margin, ...rest } = s;
      c.props.captionStyle = { ...rest, anchorY: position, offsetY: position === "middle" ? 0 : margin, anchorX: "center", offsetX: 0 };
    }
  });
  return doc;
}

/** v3: the style every caption carried went on their track, once. */
function styleOnTrack(doc: unknown): unknown {
  eachRawTrack(doc, (t) => {
    const clips = t.clips as { props?: Record<string, unknown> }[];
    const style = clips.find((c) => c.props?.captionStyle)?.props?.captionStyle;
    for (const c of clips) if (c.props) delete c.props.captionStyle;
    if (style) t.props = { ...t.props, captionStyle: style };
  });
  return doc;
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
    const style = trackStyle(track, project.settings.height);
    for (const clip of track.clips.filter(isCaption)) {
      const words = shownWords(clip);
      const start = Math.max(from, ticksToSeconds(clip.start));
      const end = Math.min(to, ticksToSeconds(clip.start + clip.duration));
      if (words.length && end > start) out.push({ start: start - from, end: end - from, text: captionText(words, style) });
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
  version: 3,
  migrations: [
    { version: 2, migrate: anchors },
    { version: 3, migrate: styleOnTrack },
  ],
  clipTypes: [{ id: "caption", description: "A caption: words from the transcript, shown with the captions' style while they are spoken", traits: ["caption"] }],
  props: [
    { id: "caption", description: "The caption's words, timed in its media seconds", traits: ["caption"], schema: captionSchema, defaults: () => ({ words: [] }), identity: true },
    { id: "captionPlace", description: "Where this caption sits when placed on its own (caption.place), instead of where its track's captions all sit", traits: ["caption"], schema: placeSchema, defaults: () => ({}) },
    {
      id: "captionStyle",
      description: "How the captions on a track look: font, size, colour, the box behind them, where they sit and the spoken word's highlight",
      traits: ["caption"],
      schema: styleSchema,
      defaults: () => defaultStyle(),
      track: true,
    },
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
        const previous = old >= 0 ? (doc.tracks[old]!.props?.captionStyle as Partial<CaptionStyle> | undefined) : undefined;
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
            props: { caption: { words: g.map((w) => ({ text: w.text, start: w.start, end: w.end })) } },
            effects: [],
            animations: [],
          });
        }
        const live = clips.filter((c) => c.duration > 0);
        if (old >= 0) Object.assign(doc.tracks[old]!, { clips: live, props: { ...doc.tracks[old]!.props, captionStyle: look } });
        else doc.tracks.push({ id: ctx.newId("track"), name: "Captions", clips: live, props: { captionStyle: look } });
        return live.map((c) => c.id);
      },
    }),
    defineCommand({
      id: "captions.style",
      description:
        "Change how every caption looks, one undo step: font, weight, size in canvas pixels, colours, background box, highlight of the spoken word, max width, uppercase, and where the box sits: `anchorY` top/middle/bottom with `offsetY` canvas pixels in from it (down from the middle), `anchorX` left/center/right with `offsetX` in from it (right of the centre). Transparent colours turn the box or the highlight off",
      args: z.strictObject({ style: StyleArgs }),
      apply(doc, { style }) {
        // One change per Captions track, however many captions it holds: a drag's step stays small.
        const tracks = original(doc)!.tracks.flatMap((t, i) => (t.clips.some(isCaption) ? [i] : []));
        if (!tracks.length) throw new Error("no captions: captions.create makes them from the transcript");
        for (const i of tracks) {
          const track = doc.tracks[i]!;
          track.props = { ...track.props, captionStyle: { ...trackStyle(original(doc)!.tracks[i], doc.settings.height), ...style } };
        }
        return tracks.length;
      },
    }),
    defineCommand({
      id: "caption.place",
      description:
        "Place a caption on its own, where the shared place doesn't suit it (a face in the way): `place` is anchors and offsets as in captions.style, over where it sits now; with `onward`, the captions after it on its track take the same place. `place: null` puts them back in the shared place",
      args: z.strictObject({ clip: z.string(), place: placeSchema.nullable(), onward: z.boolean().default(false) }),
      apply(doc, { clip: id, place, onward }) {
        const tracks = original(doc)!.tracks;
        const ti = tracks.findIndex((t) => t.clips.some((c) => c.id === id));
        const from = ti < 0 ? undefined : tracks[ti]!.clips.find((c) => c.id === id);
        if (!from || !isCaption(from)) throw new Error(`clip "${id}" is not a caption`);
        const shared = trackStyle(tracks[ti], doc.settings.height);
        const now = clipStyle(from, tracks[ti], doc.settings.height);
        const target = { anchorX: now.anchorX, offsetX: now.offsetX, anchorY: now.anchorY, offsetY: now.offsetY, ...place };
        let n = 0;
        for (const [ci, c] of tracks[ti]!.clips.entries()) {
          if (!isCaption(c) || (c.id !== id && !(onward && c.start > from.start))) continue;
          const clip = doc.tracks[ti]!.clips[ci]!;
          const same = target.anchorX === shared.anchorX && target.offsetX === shared.offsetX && target.anchorY === shared.anchorY && target.offsetY === shared.offsetY;
          if (place === null || same) delete clip.props.captionPlace;
          else clip.props.captionPlace = target;
          n++;
        }
        return n;
      },
    }),
    defineCommand({
      id: "caption.setText",
      description: "Correct what a caption says: its words become `text`'s. Words kept keep their times; new or changed ones share the time of the words they replace (or the gap they go in), by length",
      args: z.strictObject({ clip: z.string(), text: z.string() }),
      apply(doc, { clip: id, text }) {
        // Found in the original: walking the draft would make a draft of every clip.
        const ti = original(doc)!.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
        const clip = ti < 0 ? undefined : doc.tracks[ti]!.clips[original(doc)!.tracks[ti]!.clips.findIndex((c) => c.id === id)];
        if (!clip || !isCaption(clip)) throw new Error(`clip "${id}" is not a caption`);
        const old = shownWords(clip);
        const from = old[0]?.start ?? ticksToSeconds(clip.mediaStart ?? 0);
        const to = old.at(-1)?.end ?? from + ticksToSeconds(clip.duration);
        const words = retime(old, text.split(/\s+/).filter(Boolean), from, to);
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
      id: "captions.layout",
      description: "Where a caption sits on the canvas (canvas pixels, y down): its box, its text and the text's lines with their caret positions from `origin`, and `own` when it is placed on its own (caption.place). The caption `clip`, or the one showing at timeline second `time`; null if none. For moving and typing captions on the canvas",
      args: z.strictObject({ clip: z.string().optional(), time: z.number().nonnegative().optional() }),
      run({ clip: id, time }, { project }) {
        const at = time === undefined ? undefined : secondsToTicks(time);
        const shows = (c: Clip) => isCaption(c) && (id ? c.id === id : at !== undefined && c.start <= at && at < c.start + c.duration);
        const track = [...project.tracks].reverse().find((t) => !t.hidden && t.clips.some(shows));
        const clip = track?.clips.find(shows);
        if (!clip) return null;
        const g = captionGeometry(shownWords(clip), clipStyle(clip, track, project.settings.height), project.settings);
        return g ? { clip: clip.id, box: g.box, origin: g.origin, lines: g.lines, text: g.text, own: !!clip.props.captionPlace } : null;
      },
    }),
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
