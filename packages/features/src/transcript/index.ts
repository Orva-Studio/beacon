import { z } from "zod";
import { transcribe, type Transcriber, type Transcription } from "@beacon/media";
import {
  defineAction,
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
  type Session,
  type SessionCommandDef,
} from "@beacon/model";
import { clipStream, mediaInfo, sourceOf } from "../media";
import { rippleDeleteRanges } from "../timeline";
import type { CursorData } from "../cursor";

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
/** The ranges `cut` removes: out to whole frames, without leaving slivers of clips. */
function cutRanges(doc: Project, ranges: { start: number; end: number }[]) {
  const { fps } = doc.settings;
  return withoutSlivers(
    doc,
    ranges.map((r) => [snapSeconds(r.start, fps, "floor"), snapSeconds(r.end, fps, "ceil")] as [number, number]).filter(([a, b]) => b > a),
  ).map(([a, b]) => ({ start: ticksToSeconds(a), end: ticksToSeconds(b) }));
}

function cut(doc: Project, ctx: CommandContext, ranges: { start: number; end: number }[]) {
  const outward = cutRanges(doc, ranges);
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

/** What Remove Silences cuts: each silence over `min` seconds, less `keep` seconds of it (half each side; all of it before the first word, none after the last), outside `except`. */
function pauseCuts(doc: Project, registry: FeatureRegistry, data: Data, o: { min: number; keep: number; from?: number; to?: number; except: { start: number; end: number }[] }) {
  const words = timelineWords(doc, registry, data);
  if (!words.length) return undefined;
  return pauses(doc, registry, data, words)
    .filter((p) => p.end - p.start > o.min && (o.from === undefined || p.start >= o.from) && (o.to === undefined || p.end <= o.to))
    .flatMap((p) =>
      subtract(
        {
          start: p.after === undefined ? 0 : p.start + o.keep / 2,
          end: p.end >= ticksToSeconds(projectDuration(doc)) - 1e-6 && p.after !== undefined ? p.end : p.end - o.keep / 2,
        },
        o.except,
      ),
    );
}

/**
 * Whether a recording's cursor moved or clicked between two timeline times, on any screen clip shown then: a
 * silence that is screen action (clicking through something, dragging) rather than a pause. Typing alone
 * isn't seen.
 */
function screenActive(project: Project, data: Data, start: number, end: number): boolean {
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const cursor = clip.assetId ? data<CursorData>(clip.assetId, "cursor") : undefined;
      if (!cursor) continue;
      const at = ticksToSeconds(clip.start);
      const [a, b] = [Math.max(start, at), Math.min(end, at + ticksToSeconds(clip.duration))];
      if (b <= a) continue;
      const speed = clipSpeed(clip);
      const src = (t: number) => ticksToSeconds(clip.mediaStart ?? 0) + (t - at) * speed;
      const [sa, sb] = [src(a), src(b)];
      if (cursor.buttons.t.some((t) => t >= sa && t <= sb)) return true;
      // Positions are logged only when they change, so the first inside the silence is measured from where the
      // cursor was before it.
      let from = -1;
      for (let i = 0; i < cursor.t.length; i++) {
        const t = cursor.t[i]!;
        if (t > sb) break;
        if (t < sa || from < 0) {
          from = i;
          if (t < sa) continue;
        }
        if (Math.hypot(cursor.x[i]! - cursor.x[from]!, cursor.y[i]! - cursor.y[from]!) > 24) return true;
      }
    }
  }
  return false;
}

/** Media heard on the timeline whose transcript isn't made yet. */
function untranscribed(project: Project, registry: FeatureRegistry, data: Data): string[] {
  const clips = project.tracks.filter((t) => !t.muted).flatMap((t) => t.clips);
  return [...new Set(clips.filter((c) => c.assetId && registry.hasTrait(c.type, "audio") && !data<TranscriptData>(c.assetId, "transcript")?.streams[clipStream(c)]).map((c) => c.assetId!))];
}

/** Refuses a cut from the transcript while media heard on the timeline has none yet: it may speak in what would go. */
function refuseUntranscribed(project: Project, registry: FeatureRegistry, data: Data) {
  const waiting = untranscribed(project, registry, data);
  if (waiting.length) throw new Error(`still transcribing ${waiting.map((id) => project.assets[id]?.name ?? id).join(", ")}: nothing is cut until every audio heard has a transcript`);
}

/** Remove Silences' settings, and in review (`session.features.transcript.silences`) the silences flipped by hand. */
export interface SilenceReview {
  min: number;
  keep: number;
  keepActive: boolean;
  /** Times inside silences whose cut-or-keep was flipped: an odd number in a silence flips it. */
  flipped: number[];
}

const SILENCE_DEFAULTS: SilenceReview = { min: 0.6, keep: 0.3, keepActive: true, flipped: [] };

export const silenceReview = (s: Session) => (s.features.transcript as { silences?: SilenceReview } | undefined)?.silences;

/**
 * What Remove Silences does with `o`: each silence over `min`, whether it is screen action and whether it is cut
 * (screen action is kept with `keepActive`, and a flip turns either way round), and the ranges removed.
 */
function silencePlan(project: Project, registry: FeatureRegistry, data: Data, o: SilenceReview) {
  const waiting = untranscribed(project, registry, data);
  const words = timelineWords(project, registry, data);
  if (!words.length) return { waiting, words: 0, silences: [], ranges: [] };
  const silences = pauses(project, registry, data, words)
    .filter((p) => p.end - p.start > o.min)
    .map((p) => {
      const active = screenActive(project, data, p.start, p.end);
      const flips = o.flipped.filter((t) => t >= p.start - 1e-3 && t <= p.end).length;
      return { start: p.start, end: p.end, active, cut: !(o.keepActive && active) !== (flips % 2 === 1) };
    });
  const except = silences.filter((p) => !p.cut).map(({ start, end }) => ({ start, end }));
  const ranges = pauseCuts(project, registry, data, { min: o.min, keep: o.keep, except }) ?? [];
  return { waiting, words: words.length, silences, ranges };
}

const SilenceSettings = {
  min: z.number().positive().max(10).describe("Silences longer than this many seconds are cut"),
  keep: z.number().nonnegative().max(2).describe("Seconds of each cut silence left in, half each side"),
  keepActive: z.boolean().describe("Keep silences where the recording's cursor moves or clicks (screen action)"),
};

const silenceSessionCommands: SessionCommandDef[] = [
  {
    id: "silences.review",
    description:
      "Open Remove Silences' review (the AI panel's tile does): the timeline marks each silence to cut or keep and the properties panel shows these settings, until silences.apply or silences.close; with settings, change them. The user sees it, so an agent can prepare the cuts for them to look over",
    args: z.strictObject({ min: SilenceSettings.min.optional(), keep: SilenceSettings.keep.optional(), keepActive: SilenceSettings.keepActive.optional() }),
    apply: (s, a: Partial<SilenceReview>) => {
      const r = { ...(silenceReview(s) ?? SILENCE_DEFAULTS), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) } as SilenceReview;
      s.features.transcript = { ...(s.features.transcript as object | undefined), silences: { ...r, keep: Math.min(r.keep, r.min) } };
    },
  },
  {
    id: "silences.flip",
    description: "In Remove Silences' review, keep a silence it would cut, or cut one it would keep (clicking it on the timeline does): `at`, a time inside it, e.g. its start from transcript_silences",
    args: z.strictObject({ at: z.number().nonnegative() }),
    apply: (s, { at }: { at: number }) => {
      const r = silenceReview(s);
      if (!r) throw new Error("Remove Silences' review isn't open: silences.review opens it");
      r.flipped.push(at);
    },
  },
  {
    id: "silences.close",
    description: "Close Remove Silences' review without cutting anything",
    args: z.strictObject({}),
    apply: (s) => {
      const t = s.features.transcript as { silences?: SilenceReview } | undefined;
      if (t?.silences) delete t.silences;
    },
  },
];

const Range = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

const TRANSCRIBERS = ["whisper", "apple", "openai"] as const satisfies readonly Transcriber[];
const transcriber = (pref: (id: string) => string): Transcriber => (TRANSCRIBERS as readonly string[]).includes(pref("transcriber")) ? (pref("transcriber") as Transcriber) : "whisper";

/** Transcripts of recordings and audio (Whisper on this Mac, Apple's transcriber or OpenAI's API), and editing by transcript. */
export const transcript = defineFeature({
  id: "transcript",
  version: 1,
  preferences: [
    {
      id: "transcriber",
      title: "Transcriber",
      description: "Who makes transcripts (Remove Silences, cutting by transcript, captions). Transcripts already made by one are kept for when it is chosen again",
      options: [
        { id: "whisper", title: "Whisper on this Mac", description: "OpenAI's Whisper, run on this Mac, offline. Needs its speech model (about 575 MB, downloaded once). Best on technical words" },
        { id: "apple", title: "Apple's transcriber", description: "macOS's own on-device transcriber: offline, no download and about 5× faster, but weaker on technical words and on exact word times" },
        { id: "openai", title: "Whisper through OpenAI", description: "OpenAI's Whisper over its API with your own API key: the audio is uploaded to OpenAI to be transcribed, and OpenAI charges your account for it", secret: "openai-api-key" },
      ],
      default: "whisper",
    },
  ],
  secrets: [{ id: "openai-api-key", title: "OpenAI API key" }],
  resources: [
    {
      id: "whisper-model",
      title: "Whisper large-v3-turbo speech model",
      description: "Transcripts are made on this Mac, offline, with OpenAI's Whisper. Without the model, everything but transcripts (and Remove Silences, which reads them) still works.",
      // Pinned to a commit of the repo, checked against the hash Hugging Face publishes for it.
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
      sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      bytes: 574_041_195,
      folder: "models",
      file: "ggml-large-v3-turbo-q5_0.bin",
    },
  ],
  jobAnalyzers: [
    {
      id: "transcript",
      description: "Word-timed transcript of every audio stream (by the chosen transcriber, clipped to detected speech)",
      version: 7,
      needs: (pref) => (transcriber(pref) === "whisper" ? "whisper-model" : undefined),
      // Local Whisper's results keep the cache entries made before there was a choice.
      variant: (pref) => (transcriber(pref) === "whisper" ? undefined : transcriber(pref)),
      applies: (asset) => !!asset.derived.media && mediaInfo(asset).streams.some((s) => s.kind === "audio"),
      async analyze(asset, progress, env) {
        const audio = mediaInfo(asset).streams.filter((s) => s.kind === "audio");
        const streams: TranscriptData["streams"] = {};
        const who = transcriber(env.pref);
        const model = who === "whisper" ? env.resource("whisper-model") : undefined;
        const apiKey = who === "openai" ? await env.secret("openai-api-key") : undefined;
        for (const i of audio.keys()) {
          const src = sourceOf(asset, "audio", i);
          streams[i] = await transcribe(src.path, { stream: src.stream, transcriber: who, ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}), onProgress: (f) => progress((i + f) / audio.length) });
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
      id: "transcript.silences",
      description:
        "What Remove Silences would cut: each silence over `min` seconds (timeline seconds), whether it is screen action (the recording's cursor moved or clicked) and whether it is cut, with the seconds saved. Settings not given are the defaults (the open review's are in ui_state). `waiting`: media heard on the timeline with no transcript yet (the analyze tool with `transcript` makes one)",
      args: z.strictObject({
        min: SilenceSettings.min.optional(),
        keep: SilenceSettings.keep.optional(),
        keepActive: SilenceSettings.keepActive.optional(),
        flipped: z.array(z.number()).optional().describe("Times inside silences to flip, as silences.flip does"),
      }),
      run(args, { project, registry, data }) {
        const o = { ...SILENCE_DEFAULTS, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) } as SilenceReview;
        const plan = silencePlan(project, registry, data, o);
        const removed = cutRanges(project, plan.ranges);
        return { waiting: plan.waiting, silences: plan.silences, cuts: removed.length, saved: roundSeconds(removed.reduce((n, c) => n + c.end - c.start, 0)) };
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
  sessionCommands: silenceSessionCommands,
  actions: [
    defineAction({
      id: "silences.apply",
      description: "Cut what Remove Silences' open review marks to cut (its Apply button), one undo step, and close the review",
      args: z.strictObject({}),
      resolve: (_, { session }) => {
        const r = silenceReview(session);
        if (!r) throw new Error("Remove Silences' review isn't open: silences.review opens it");
        return { label: "Remove Silences", steps: [{ command: "transcript.removeSilences", args: r }], after: () => [{ command: "silences.close" }] };
      },
    }),
  ],
  commands: [
    defineCommand({
      id: "transcript.removeSilences",
      description:
        "Remove Silences: cut every silence over `min` seconds down to `keep`, keeping screen action with `keepActive` and turning round the silences `flipped` names, as transcript_silences shows; one undo step. silences.apply runs it from the open review",
      args: z.strictObject({ ...SilenceSettings, flipped: z.array(z.number()).default([]) }),
      apply(doc, o, ctx) {
        const plan = silencePlan(doc, ctx.registry, ctx.data, o);
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        return cut(doc, ctx, plan.ranges);
      },
    }),
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
        const ranges = pauseCuts(doc, ctx.registry, ctx.data, { min, keep, from, to, except });
        if (!ranges) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        return cut(doc, ctx, ranges);
      },
    }),
  ],
});
