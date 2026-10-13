import { z } from "zod";
import { transcribe, type Transcription } from "@beacon/media";
import {
  defineCommand,
  defineFeature,
  defineQuery,
  projectDuration,
  clipSpeed,
  roundSeconds,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type CommandContext,
  type FeatureRegistry,
  type Project,
} from "@beacon/model";
import { clipStream, mediaInfo, sourceOf } from "../media";
import { rippleDeleteRanges } from "../timeline";

/** `Asset.derived.transcript` / the `transcript` analyzer: one transcription per audio stream index. */
export interface TranscriptData {
  streams: Record<number, Transcription>;
}

export interface TimelineWord {
  /** Position in this transcript; changes after edits, so re-read after cutting. */
  i: number;
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  clip: string;
}

type Data = <T>(assetId: string, key: string) => T | undefined;

/** An audio clip's window into its source's transcript, mapped to timeline seconds. */
function* audioClips(project: Project, registry: FeatureRegistry, data: Data) {
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (!clip.assetId || !registry.hasTrait(clip.type, "audio")) continue;
      const stream = clipStream(clip);
      const t = data<TranscriptData>(clip.assetId, "transcript")?.streams[stream];
      if (!t) continue;
      const speed = clipSpeed(clip);
      const from = ticksToSeconds(clip.mediaStart ?? 0);
      const to = from + ticksToSeconds(clip.duration) * speed;
      const at = ticksToSeconds(clip.start);
      yield { clip, t, from, to, map: (m: number) => roundSeconds(at + (Math.min(Math.max(m, from), to) - from) / speed) };
    }
  }
}

/**
 * The words audible on the timeline: every audio clip on an unmuted track,
 * through its window into its source, in timeline seconds.
 */
export function timelineWords(project: Project, registry: FeatureRegistry, data: Data): TimelineWord[] {
  const words: Omit<TimelineWord, "i">[] = [];
  for (const { clip, t, from, to, map } of audioClips(project, registry, data)) {
    for (const w of t.words) {
      const mid = (w.start + w.end) / 2;
      if (mid >= from && mid < to) words.push({ text: w.text, start: map(w.start), end: map(w.end), clip: clip.id });
    }
  }
  return words.sort((a, b) => a.start - b.start).map((w, i) => ({ i, ...w }));
}

/**
 * Silences on the timeline: where no audio clip has detected speech. Based
 * on the audio rather than gaps between words, so speech whisper missed is
 * never treated as silence. `after` is the index of the last word before.
 */
export function pauses(project: Project, registry: FeatureRegistry, data: Data, words: TimelineWord[]): { start: number; end: number; after?: number }[] {
  const speech: [number, number][] = [];
  for (const { t, from, to, map } of audioClips(project, registry, data)) {
    for (const [a, b] of t.speech) if (b > from && a < to) speech.push([map(a), map(b)]);
  }
  speech.sort((x, y) => x[0] - y[0]);
  const end = ticksToSeconds(projectDuration(project));
  const out: { start: number; end: number; after?: number }[] = [];
  let at = 0;
  const push = (start: number, stop: number) => {
    const before = words.filter((w) => w.end <= start + 1e-6).at(-1);
    out.push({ start: roundSeconds(start), end: roundSeconds(stop), ...(before ? { after: before.i } : {}) });
  };
  for (const [a, b] of speech) {
    if (a > at) push(at, a);
    at = Math.max(at, b);
  }
  if (end > at) push(at, end);
  return out;
}

/** Words grouped into lines at sentence ends and pauses of `gap` seconds or more. */
function lines(words: TimelineWord[], gap: number): string {
  const out: string[] = [];
  let line: TimelineWord[] = [];
  const flush = () => {
    if (!line.length) return;
    const a = line[0]!;
    const b = line.at(-1)!;
    out.push(`[${a.i}-${b.i}] ${a.start.toFixed(2)}-${b.end.toFixed(2)}  ${line.map((w) => w.text).join(" ")}`);
    line = [];
  };
  for (const [k, w] of words.entries()) {
    const prev = words[k - 1];
    if (prev && w.start - prev.end >= gap) {
      flush();
      out.push(`   (pause ${(w.start - prev.end).toFixed(2)}s)`);
    }
    line.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  return out.join("\n");
}

/** Pieces of clips this short or shorter that a cut would leave are cut too: a flash of a frame or two between cuts. */
const SLIVER_FRAMES = 2;

/**
 * Ranges in ticks, merged and widened so no clip on an unlocked track is left
 * with only a sliver between two cuts or between a cut and its own edge.
 */
function withoutSlivers(doc: Project, ranges: [number, number][]): [number, number][] {
  const sliver = SLIVER_FRAMES * ticksPerFrame(doc.settings.fps);
  const clips = doc.tracks.filter((t) => !t.locked).flatMap((t) => t.clips);
  let out = ranges.map((r) => [...r] as [number, number]).sort((a, b) => a[0] - b[0]);
  for (let changed = true; changed; ) {
    changed = false;
    const merged: [number, number][] = [];
    for (const r of out) {
      const last = merged.at(-1);
      if (last && r[0] - last[1] <= sliver) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
    for (const r of merged) {
      for (const c of clips) {
        const end = c.start + c.duration;
        if (c.start < r[0] && end > r[0] && r[0] - c.start <= sliver) [r[0], changed] = [c.start, true];
        if (end > r[1] && c.start < r[1] && end - r[1] <= sliver) [r[1], changed] = [end, true];
      }
    }
    out = merged;
  }
  return out;
}

/** Rounded out to whole frames, so a cut never leaves the edge of a word it removes, nor a sliver of a clip. */
function cut(doc: Project, ctx: CommandContext, ranges: { start: number; end: number }[]) {
  const { fps } = doc.settings;
  const outward = withoutSlivers(
    doc,
    ranges.map((r) => [snapSeconds(r.start, fps, "floor"), snapSeconds(r.end, fps, "ceil")] as [number, number]).filter(([a, b]) => b > a),
  ).map(([a, b]) => ({ start: ticksToSeconds(a), end: ticksToSeconds(b) }));
  rippleDeleteRanges(doc, outward, ctx);
  return outward.map((r) => ({ start: roundSeconds(r.start), end: roundSeconds(r.end) }));
}

/** `r` minus every range in `holes`. */
function subtract(r: { start: number; end: number }, holes: { start: number; end: number }[]): { start: number; end: number }[] {
  let parts = [r];
  for (const h of holes) {
    parts = parts.flatMap((p) => (h.end <= p.start || h.start >= p.end ? [p] : [{ start: p.start, end: h.start }, { start: h.end, end: p.end }].filter((x) => x.end > x.start)));
  }
  return parts;
}

const Range = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

/** Transcripts of recordings and audio (whisper.cpp, local), and editing by transcript. */
export const transcript = defineFeature({
  id: "transcript",
  version: 1,
  jobAnalyzers: [
    {
      id: "transcript",
      description: "Word-timed transcript of every audio stream (whisper.cpp large-v3-turbo, clipped to detected speech)",
      version: 7,
      applies: (asset) => !!asset.derived.media && mediaInfo(asset).streams.some((s) => s.kind === "audio"),
      async analyze(asset, progress) {
        const audio = mediaInfo(asset).streams.filter((s) => s.kind === "audio");
        const streams: TranscriptData["streams"] = {};
        for (const i of audio.keys()) {
          const src = sourceOf(asset, "audio", i);
          streams[i] = await transcribe(src.path, { stream: src.stream, onProgress: (f) => progress((i + f) / audio.length) });
        }
        return { streams } satisfies TranscriptData;
      },
    },
  ],
  queries: [
    defineQuery({
      id: "transcript.get",
      description:
        "What is said on the timeline, in timeline seconds. `text`: lines as `[first-last word index] start-end  words`, with pauses; `words`: every word with its times. Indices change after any edit, so re-read before cutting again. Empty until the transcript job for the media has finished",
      args: z.strictObject({
        format: z.enum(["text", "words"]).default("text"),
        from: z.number().nonnegative().optional(),
        to: z.number().nonnegative().optional(),
        pause: z.number().positive().default(0.5).describe("Seconds of silence that start a new line (text format)"),
      }),
      resource: { uri: "beacon://project/transcript", name: "Transcript", mimeType: "text/plain" },
      run({ format, from, to, pause }, { project, registry, data }) {
        const words = timelineWords(project, registry, data).filter((w) => (from === undefined || w.end > from) && (to === undefined || w.start < to));
        if (format === "words") return words;
        return words.length ? lines(words, pause) : "(no transcript yet: check the transcript job, or the media has no speech)";
      },
    }),
    defineQuery({
      id: "transcript.pauses",
      description: "Silences on the timeline (no detected speech in any audio clip, including before the first and after the last word) at least `min` seconds long, in timeline seconds; `after` is the index of the word before",
      args: z.strictObject({ min: z.number().nonnegative().default(0.5) }),
      run({ min }, { project, registry, data }) {
        return pauses(project, registry, data, timelineWords(project, registry, data)).filter((p) => p.end - p.start >= min);
      },
    }),
    defineQuery({
      id: "transcript.joins",
      description:
        "Every point where an audio clip starts or ends, in timeline seconds, flagged `chopped` when it falls inside a word, or inside speech the transcript has no words for, in its source: an audible skip. Joins between two words of continuous speech are fine. Check after any cut made by hand with timeline_rippleDelete",
      args: z.strictObject({ chopped: z.boolean().default(false).describe("Only the joins that cut through speech") }),
      run({ chopped }, { project, registry, data }) {
        const out: { time: number; edge: "in" | "out"; clip: string; chopped: boolean; word?: string }[] = [];
        for (const { clip, t, from, to, map } of audioClips(project, registry, data)) {
          for (const [edge, m] of [["in", from], ["out", to]] as const) {
            const region = t.speech.find(([a, b]) => m > a + 0.005 && m < b - 0.005);
            const word = region && t.words.find((w) => m > w.start + 0.005 && m < w.end - 0.005);
            // Between two words in continuous speech is a clean cut; a long stretch of sound with no words is speech whisper missed.
            const before = region && t.words.filter((w) => w.end <= m && w.end > region[0]).at(-1);
            const after = region && t.words.find((w) => w.start >= m && w.start < region[1]);
            const unheard = !!region && !word && (after?.start ?? region[1]) - (before?.end ?? region[0]) > 0.3;
            out.push({ time: map(m), edge, clip: clip.id, chopped: !!word || unheard, ...(word ? { word: word.text } : {}) });
          }
        }
        return out.filter((j) => !chopped || j.chopped).sort((a, b) => a.time - b.time);
      },
    }),
  ],
  commands: [
    defineCommand({
      id: "transcript.cut",
      description:
        "Delete spoken words by their indices from transcript.get (inclusive ranges, e.g. [[12, 30]] for a retake), closing the gaps on every track. Each cut runs from the first word's start to just before the next kept word, so the pause after the cut words goes too. Pass every range at once: indices refer to the transcript before this command",
      args: z.strictObject({ words: z.array(Range).min(1), lead: z.number().nonnegative().default(0.1).describe("Seconds kept before the next word") }),
      apply(doc, { words: ranges, lead }, ctx) {
        const words = timelineWords(doc, ctx.registry, ctx.data);
        if (!words.length) throw new Error("no transcript on the timeline yet");
        return cut(
          doc,
          ctx,
          ranges.map(([a, b]) => {
            const first = words[Math.min(a, b)];
            const last = words[Math.max(a, b)];
            if (!first || !last) throw new Error(`word range [${a}, ${b}] is outside 0-${words.length - 1}`);
            const next = words[last.i + 1];
            // `lead` is silence kept before the next word; without a real pause, cut right up to it.
            const end = !next ? last.end : next.start - last.end > 2 * lead ? next.start - lead : Math.max(last.end, next.start - (next.start - last.end) / 4);
            return { start: first.start, end };
          }),
        );
      },
    }),
    defineCommand({
      id: "transcript.removePauses",
      description:
        "Shorten every silence (no detected speech) longer than `min` seconds to `keep` seconds (half each side), including before the first word and after the last, optionally only within [from, to). Silences can be screen action (typing, clicking) worth keeping: check with frames, and keep those stretches with `except` (only the excepted part of a silence is kept; the rest is still shortened)",
      args: z.strictObject({
        min: z.number().positive().default(0.6),
        keep: z.number().nonnegative().default(0.3),
        from: z.number().nonnegative().optional(),
        to: z.number().nonnegative().optional(),
        except: z.array(z.strictObject({ start: z.number(), end: z.number() })).default([]),
      }),
      apply(doc, { min, keep, from, to, except }, ctx) {
        const words = timelineWords(doc, ctx.registry, ctx.data);
        if (!words.length) throw new Error("no transcript on the timeline yet");
        const ranges = pauses(doc, ctx.registry, ctx.data, words)
          .filter((p) => p.end - p.start > min && (from === undefined || p.start >= from) && (to === undefined || p.end <= to))
          .flatMap((p) =>
            subtract(
              {
                start: p.after === undefined ? 0 : p.start + keep / 2,
                end: p.end >= ticksToSeconds(projectDuration(doc)) - 1e-6 && p.after !== undefined ? p.end : p.end - keep / 2,
              },
              except,
            ),
          );
        return cut(doc, ctx, ranges);
      },
    }),
  ],
});
