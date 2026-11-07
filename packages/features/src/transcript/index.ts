import { z } from "zod";
import { jobSignal, transcribe, type Transcriber, type Transcription } from "@beacon/media";
import {
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  projectDuration,
  clipSpeed,
  roundSeconds,
  secondsToTicks,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type CommandContext,
  type FeatureRegistry,
  type Project,
  type Preferences,
  type Session,
  type SessionCommandDef,
  mergeSpans,
  subtractSpans,
  mediaWindow,
  type Clip,
  type DecisionInput,
  type HabitInfo,
  type Memory,
  NO_MEMORY,
  projectFormat,
  assetName,
} from "@beacon/model";
import { clipStream, mediaInfo, sourceOf, type WaveformData } from "../media";
import { rangesCut, rippleDeleteRanges } from "../timeline";
import type { CursorData } from "../cursor";
import { retakeTake, silenceMin, where, type Habit } from "./habits";
import { RETAKE_DEFAULTS, bestTake, findRetakes, isFiller, judgeTakes, retakeCuts, takeKey, takeText, type Judgment, type RetakeOptions, type Take, type Word } from "./retakes";

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
      if (!clip.assetId || !registry.hasTrait(clip.type, "audio") || (clip.props.audio as { muted?: boolean } | undefined)?.muted) continue;
      const stream = clipStream(clip);
      const t = data<TranscriptData>(clip.assetId, "transcript")?.streams[stream];
      if (!t) continue;
      const speed = clipSpeed(clip);
      const [from, to] = mediaWindow(clip).map(ticksToSeconds) as [number, number];
      const at = ticksToSeconds(clip.start);
      yield { clip, t, from, to, map: (m: number) => roundSeconds(at + (Math.min(Math.max(m, from), to) - from) / speed) };
    }
  }
}

/** Where speech is heard on the timeline (timeline seconds, merged), from every audio clip's transcript. */
export function speechSpans(project: Project, registry: FeatureRegistry, data: Data): [number, number][] {
  const speech: [number, number][] = [];
  for (const { t, from, to, map } of audioClips(project, registry, data)) for (const [a, b] of t.speech) if (b > from && a < to) speech.push([map(a), map(b)]);
  return mergeSpans(speech.sort((x, y) => x[0] - y[0]));
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

/** Seconds of sound kept each side of a cut that follows the sound (`quiet`): against a click, not to keep noise. */
const QUIET_GUARD = 0.04;
/** Quiet runs shorter than this inside the sound don't split it (the gap between two syllables). */
const QUIET_JOIN = 0.1;

const voiceLevels = new WeakMap<number[], number>();
/** A stream's voice, as a waveform peak (0–255): its 90th percentile, counting only where there is sound. */
function voiceOf(peaks: number[]): number {
  let v = voiceLevels.get(peaks);
  if (v === undefined) {
    const heard = peaks.filter((p) => p > 0).sort((a, b) => a - b);
    v = heard[Math.floor(heard.length * 0.9)] ?? 0;
    voiceLevels.set(peaks, v);
  }
  return v;
}

/**
 * Where each audio clip's sound is within `under` dB of its voice (timeline seconds, merged), from its waveform
 * (peaks per 10 ms, 0–255 as the square root of the peak). A clip whose waveform isn't made yet counts as sound
 * throughout, so nothing more is cut from it.
 */
function soundSpans(project: Project, registry: FeatureRegistry, data: Data, under: number): [number, number][] {
  const out: [number, number][] = [];
  for (const { clip, from, to, map } of audioClips(project, registry, data)) {
    const peaks = data<WaveformData>(clip.assetId!, "waveform")?.streams[clipStream(clip)];
    if (!peaks?.length) {
      out.push([map(from), map(to)]);
      continue;
    }
    // A peak's waveform value is 255·√peak, so `under` dB lower is 10^(−under/40) of it.
    const threshold = voiceOf(peaks) * 10 ** (-under / 40);
    let run: [number, number] | undefined;
    for (let i = Math.max(0, Math.floor(from * 100)); i < Math.min(peaks.length, Math.ceil(to * 100)); i++) {
      if (peaks[i]! < threshold) continue;
      const [a, b] = [i / 100, (i + 1) / 100];
      if (run && a - run[1] < QUIET_JOIN) run[1] = b;
      else {
        if (run) out.push([map(run[0]), map(run[1])]);
        run = [a, b];
      }
    }
    if (run) out.push([map(run[0]), map(run[1])]);
  }
  return mergeSpans(out.sort((x, y) => x[0] - y[0]));
}

/**
 * Silences on the timeline: where no audio clip has detected speech. Based
 * on the audio rather than gaps between words, so speech whisper missed is
 * never treated as silence. What was put there to be seen isn't silence
 * either: a picture where no audio plays (a card after the talk), and an
 * image, held frame or group lying wholly inside a pause. A video running
 * across the talk (its camera, from the same take or another file) is cut
 * with its silences. `after` is the index of the last word before.
 */
export function pauses(project: Project, registry: FeatureRegistry, data: Data, words: TimelineWord[], under = 0): { start: number; end: number; after?: number }[] {
  let speech: [number, number][] = [];
  const heard: [number, number][] = [];
  for (const { clip, t, from, to, map } of audioClips(project, registry, data)) {
    heard.push([ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)]);
    for (const [a, b] of t.speech) if (b > from && a < to) speech.push([map(a), map(b)]);
  }
  speech.sort((x, y) => x[0] - y[0]);
  // `under`: speech is only where it is also heard within `under` dB of the voice, so low noise kept inside a
  // speech region (a breath, the room after a word) is silence too.
  if (under > 0) {
    const sound = soundSpans(project, registry, data, under);
    speech = mergeSpans(speech).flatMap(([a, b]) => sound.filter(([x, y]) => y > a && x < b).map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as [number, number]));
  }
  const end = ticksToSeconds(projectDuration(project));
  const quiet: [number, number][] = [];
  let at = 0;
  for (const [a, b] of speech) {
    if (a > at) quiet.push([at, a]);
    at = Math.max(at, b);
  }
  if (end > at) quiet.push([at, end]);

  const shown = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips);
  const span = (c: (typeof shown)[number]) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)] as [number, number];
  const unheard = mergeSpans(shown.filter((c) => registry.hasTrait(c.type, "visual")).map(span)).flatMap((s) => subtractSpans(s, mergeSpans(heard)));
  const placed = shown
    .filter((c) => registry.hasTrait(c.type, "group") || (registry.hasTrait(c.type, "picture") && !registry.hasTrait(c.type, "video")))
    .map(span)
    .filter(([a, b]) => quiet.some(([q0, q1]) => a >= q0 - 1e-6 && b <= q1 + 1e-6));
  const kept = mergeSpans([...unheard, ...placed]);

  const out: { start: number; end: number; after?: number }[] = [];
  for (const q of quiet) {
    for (const [a, b] of subtractSpans(q, kept)) {
      const before = words.filter((w) => w.end <= a + 1e-6).at(-1);
      out.push({ start: a, end: b, ...(before ? { after: before.i } : {}) });
    }
  }
  return out;
}

/** Words grouped into lines at sentence ends and pauses of `gap` seconds or more. */
const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Each run of words saying `phrase`, in order. */
function phrasePlaces(words: TimelineWord[], phrase: string): TimelineWord[][] {
  const want = phrase.split(/\s+/).map(bare).filter(Boolean);
  const said = words.map((w) => bare(w.text));
  const out: TimelineWord[][] = [];
  for (let k = 0; want.length && k + want.length <= words.length; k++) {
    if (want.every((x, j) => said[k + j] === x)) out.push(words.slice(k, k + want.length));
  }
  return out;
}

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

/** The ranges `cut` removes: out to whole frames, so a cut never leaves the edge of a word it removes, nor a sliver of a clip. */
function cutRanges(doc: Project, registry: FeatureRegistry, data: Data, ranges: { start: number; end: number }[]) {
  const { fps } = doc.settings;
  const framed = ranges
    .map((r) => [snapSeconds(r.start, fps, "floor"), snapSeconds(r.end, fps, "ceil")] as [number, number])
    .filter(([a, b]) => b > a)
    .map(([a, b]) => ({ start: ticksToSeconds(a), end: ticksToSeconds(b) }));
  return rangesCut(doc, framed, registry, data);
}

/**
 * The time words `a`..`b` take: from the first's start to just before the next word, so the pause after them goes
 * too, keeping `lead` seconds of it before the next word when there is a real pause.
 */
function wordSpan(words: Word[], a: number, b: number, lead = 0.1) {
  const [first, last, next] = [words[a]!, words[b]!, words[b + 1]];
  const end = !next ? last.end : next.start - last.end > 2 * lead ? next.start - lead : Math.max(last.end, next.start - (next.start - last.end) / 4);
  return { start: first.start, end };
}

function cut(doc: Project, ctx: CommandContext, ranges: { start: number; end: number }[]) {
  const outward = cutRanges(doc, ctx.registry, ctx.data, ranges);
  rippleDeleteRanges(doc, outward, ctx);
  return outward.map((r) => ({ start: roundSeconds(r.start), end: roundSeconds(r.end) }));
}

/**
 * What Remove Silences cuts: each silence over `min` seconds, less `keep` seconds of it (half each side; all of it
 * before the first word, none after the last), outside `except`. With `quiet` (dB under the voice) the cut follows
 * the sound: low noise counts as silence and `keep` is at most a few hundredths each side, so none of it is kept.
 */
function pauseCuts(doc: Project, registry: FeatureRegistry, data: Data, o: { min: number; keep: number; quiet?: number; from?: number; to?: number; except: { start: number; end: number }[] }) {
  const words = timelineWords(doc, registry, data);
  if (!words.length) return undefined;
  const side = o.quiet ? Math.min(o.keep / 2, QUIET_GUARD) : o.keep / 2;
  return pauses(doc, registry, data, words, o.quiet)
    .filter((p) => p.end - p.start > o.min && (o.from === undefined || p.start >= o.from) && (o.to === undefined || p.end <= o.to))
    .flatMap((p) =>
      subtractSpans(
        [p.after === undefined ? p.start : p.start + side, p.end >= ticksToSeconds(projectDuration(doc)) - 1e-6 && p.after !== undefined ? p.end : p.end - side],
        o.except.map((x) => [x.start, x.end]),
      ).map(([start, end]) => ({ start, end })),
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

/** The item one at a time is on: the one holding `at`, or else the next after it (the one before was just cut). */
function currentOf(items: { start: number; end: number }[], at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  const i = items.findIndex((x) => x.end > at + 1e-3);
  return i < 0 ? undefined : i;
}

/** A time before a cut of `ranges` (timeline seconds, read before it), after it: inside one goes to where it was. */
function afterCut(t: number, ranges: { start: number; end: number }[]): number {
  let out = t;
  for (const r of ranges) if (r.start < t) out -= Math.min(t, r.end) - r.start;
  return roundSeconds(out);
}

/** Media heard on the timeline whose transcript isn't made yet. */
function untranscribed(project: Project, registry: FeatureRegistry, data: Data): string[] {
  const clips = project.tracks.filter((t) => !t.muted).flatMap((t) => t.clips);
  const heard = clips.filter((c) => c.assetId && registry.hasTrait(c.type, "audio") && !(c.props.audio as { muted?: boolean } | undefined)?.muted);
  return [...new Set(heard.filter((c) => !data<TranscriptData>(c.assetId!, "transcript")?.streams[clipStream(c)]).map((c) => c.assetId!))];
}

/** Refuses a cut from the transcript while media heard on the timeline has none yet: it may speak in what would go. */
function refuseUntranscribed(project: Project, registry: FeatureRegistry, data: Data) {
  const waiting = untranscribed(project, registry, data);
  if (waiting.length) throw new Error(`still transcribing ${waiting.map((id) => project.assets[id]?.name ?? id).join(", ")}: nothing is cut until every audio heard has a transcript`);
}

/** Remove Silences' settings, and in review (`session.features.transcript.silences`) the silences the user picked to cut. */
export interface SilenceReview {
  min: number;
  keep: number;
  /** dB under the voice counted as silence too, the cut following the sound; 0 for detected speech alone. */
  quiet: number;
  /** A time inside each silence picked on the timeline (a click, ⇧-click for more): Apply cuts those. */
  selected: number[];
  /** The habits it opened with, said in the panel ("Longer than 0.45 s: …"). */
  learned?: string[];
  /** How far through the timeline silences have been cut from it: those before, not cut, were kept. */
  reach?: number;
}

const SILENCE_DEFAULTS: SilenceReview = { min: 0.6, keep: 0.3, quiet: 30, selected: [] };

/** A review's settings as the user last left them (its sliders), else the defaults. */
const silenceSettings = (pref: Preferences): SilenceReview => ({ min: Number(pref("silenceMin")), keep: Number(pref("silenceKeep")), quiet: Number(pref("silenceQuiet")), selected: [] });
const retakeSettings = (pref: Preferences): RetakeOptions => ({ minWords: Number(pref("retakeMinWords")), within: Number(pref("retakeWithin")) });

const silenceReview = (s: Session) => (s.features.transcript as { silences?: SilenceReview } | undefined)?.silences;

/**
 * Where two audio clips heard together both have speech: Remove Silences can't tell whose pause is whose. A take's
 * system audio, with nothing said in it, plays under its microphone without counting.
 */
function stackedSpeech(project: Project, registry: FeatureRegistry, data: Data): string | undefined {
  const clips = [...audioClips(project, registry, data)].map(({ clip, t, from, to, map }) => ({
    clip,
    speech: t.speech.filter(([a, b]) => b > from && a < to).map(([a, b]) => [map(a), map(b)] as [number, number]),
  }));
  for (const [i, a] of clips.entries()) {
    for (const b of clips.slice(i + 1)) {
      const [from, to] = [Math.max(a.clip.start, b.clip.start), Math.min(a.clip.start + a.clip.duration, b.clip.start + b.clip.duration)].map(ticksToSeconds) as [number, number];
      if (to <= from) continue;
      const said = (x: typeof a) => x.speech.filter(([s0, e0]) => e0 > from && s0 < to);
      const [sa, sb] = [said(a), said(b)];
      if (!sa.length || !sb.length) continue;
      const name = (c: Clip) => (c.assetId && project.assets[c.assetId] ? assetName(project.assets[c.assetId]!) : c.id);
      const at = Math.max(sa[0]![0], sb[0]![0], from);
      return `Remove Silences works on one voice at a time: "${name(a.clip)}" and "${name(b.clip)}" both have speech at ${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}. Mute one (its audio tab › Mute) or move it apart first`;
    }
  }
  return undefined;
}

/**
 * Remove Silences with `o`: each silence over `min`, whether it is screen action and whether it is picked, the
 * ranges cutting all of them would remove and those cutting only the picked ones would, and whether two voices overlap.
 */
function silencePlan(project: Project, registry: FeatureRegistry, data: Data, o: { min: number; keep: number; quiet?: number; selected?: number[] }) {
  const waiting = untranscribed(project, registry, data);
  const stacked = stackedSpeech(project, registry, data);
  const words = timelineWords(project, registry, data);
  if (!words.length) return { waiting, stacked, words: 0, silences: [], all: [], chosen: [] };
  const picked = o.selected ?? [];
  const silences = pauses(project, registry, data, words, o.quiet)
    .filter((p) => p.end - p.start > o.min)
    .map((p) => ({ start: p.start, end: p.end, active: screenActive(project, data, p.start, p.end), selected: picked.some((t) => t >= p.start - 1e-3 && t <= p.end + 1e-3) }));
  const all = pauseCuts(project, registry, data, { min: o.min, keep: o.keep, quiet: o.quiet ?? 0, except: [] }) ?? [];
  const chosen = pauseCuts(project, registry, data, { min: o.min, keep: o.keep, quiet: o.quiet ?? 0, except: silences.filter((p) => !p.selected).map(({ start, end }) => ({ start, end })) }) ?? [];
  return { waiting, stacked, words: words.length, silences: silences.map((p) => ({ ...p, start: roundSeconds(p.start), end: roundSeconds(p.end) })), all, chosen };
}

const SilenceSettings = {
  min: z.number().positive().max(10).describe("Silences longer than this many seconds are found"),
  keep: z.number().nonnegative().max(2).describe("Seconds of each cut silence left in, half each side"),
  quiet: z.number().min(0).max(60).describe("Sound this many dB under the voice counts as silence too (low noise, a breath, the room after a word), and the cut follows the sound: `keep` is then at most 0.04 s each side. 0: only where no speech was detected"),
};

type ReviewKey = "silences" | "retakes";
type Reviews = { silences?: SilenceReview; retakes?: RetakeReview };

/** A review's focus and close (and Remove Retakes' keep): the reviews differ only in what they name. */
function reviewSteps(key: ReviewKey, title: string, item: string): SessionCommandDef[] {
  const open = (s: Session) => {
    const r = (s.features.transcript as Reviews | undefined)?.[key];
    if (!r) throw new Error(`${title}' review isn't open: ${key}.review opens it`);
    return r;
  };
  const At = z.strictObject({ at: z.number().nonnegative() });
  const keep: SessionCommandDef = {
    id: "retakes.keep",
    description:
      "In Remove Retakes' review, keep this take of its group instead of the one picked, cutting the group's others (clicking it on the timeline does): `at`, a time inside the take, e.g. its start from transcript_retakes",
    args: At,
    apply: (s, { at }: { at: number }) => {
      const r = open(s) as RetakeReview;
      r.kept.push(at);
      if (r.cutAll) r.cutAll = r.cutAll.filter((g) => at < g.start - 1e-3 || at > g.end + 1e-3);
    },
  };
  return [
    ...(key === "retakes" ? [keep] : []),
    {
      id: `${key}.focus`,
      description: `In ${title}' review, go to one ${item} to look at it on its own (the review's ‹ › buttons, or ⌥-clicking it on the timeline): \`at\`, a time inside it, e.g. its start from transcript_${key}. ${key}.apply with \`one\` then cuts only that one`,
      args: At,
      apply: (s, { at }: { at: number }) => void ((open(s) as { current?: number }).current = at),
    },
    {
      id: `${key}.close`,
      description: `Close ${title}' review without cutting anything`,
      args: z.strictObject({}),
      apply: (s) => {
        const t = s.features.transcript as Reviews | undefined;
        if (t?.[key]) delete t[key];
      },
    },
  ];
}

const silenceSessionCommands: SessionCommandDef[] = [
  {
    id: "silences.review",
    description:
      "Open Remove Silences' review (the AI panel's tile does): the timeline marks each silence and the properties panel shows these settings, until silences.apply or silences.close; nothing is cut until the user picks silences (silences.select) and cuts them, or cuts all. With settings, change them. An agent can pick silences for the user to look over",
    args: z.strictObject({ min: SilenceSettings.min.optional(), keep: SilenceSettings.keep.optional(), quiet: SilenceSettings.quiet.optional() }),
    apply: (s, a: Partial<SilenceReview>, { pref, project, memory }) => {
      const r = { ...(silenceReview(s) ?? learnedSilences(silenceSettings(pref), memory, project)), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) } as SilenceReview;
      // Moved from the habit, it no longer says why.
      if (a.min !== undefined) delete r.learned;
      openReview(s, "silences", { ...r, keep: Math.min(r.keep, r.min) });
    },
  },
  {
    id: "silences.select",
    description:
      "In Remove Silences' review, pick a silence to cut (a click on it on the timeline): `at`, a time inside it, e.g. its start from transcript_silences, replacing the picked ones; with `add`, picked or unpicked alongside them (⌘-click); with `through`, it and every silence back to the one picked last, alongside them (⇧-click). Without `at`, none picked",
    args: z.strictObject({ at: z.number().nonnegative().optional(), add: z.boolean().default(false), through: z.boolean().default(false) }),
    apply: (s, { at, add, through }: { at?: number; add: boolean; through: boolean }, { project, registry, data }) => {
      const r = silenceReview(s);
      if (!r) throw new Error("Remove Silences' review isn't open: silences.review opens it");
      if (at === undefined) return void (r.selected = []);
      const anchor = r.selected.at(-1);
      if (through && anchor !== undefined) {
        // The one picked last stays last, so the next ⇧-click runs from it too, as in Finder.
        const [lo, hi] = [Math.min(anchor, at), Math.max(anchor, at)];
        const all = silencePlan(project, registry, data, r).silences;
        const picked = (x: { start: number; end: number }) => r.selected.some((t) => t >= x.start - 1e-3 && t <= x.end + 1e-3);
        const run = all.filter((x) => x.end >= lo - 1e-3 && x.start <= hi + 1e-3 && !picked(x)).map((x) => (x.start + x.end) / 2);
        r.selected = [...r.selected.slice(0, -1), ...run, anchor];
        return;
      }
      if (!add) return void (r.selected = [at]);
      // Any time in a silence picks it, so any time in the same one unpicks it.
      const hit = silencePlan(project, registry, data, r).silences.find((x) => at >= x.start && at <= x.end);
      const same = r.selected.filter((t) => (hit ? t >= hit.start && t <= hit.end : Math.abs(t - at) < 0.05));
      r.selected = same.length ? r.selected.filter((t) => !same.includes(t)) : [...r.selected, at];
    },
  },
  {
    ...reviewSteps("silences", "Remove Silences", "silence").find((c) => c.id === "silences.close")!,
    apply: (s, _: object, { project, registry, data, memory }) => {
      const r = silenceReview(s);
      if (!r) return;
      // Silences left before the last one cut were looked at and kept; those after it, maybe never seen.
      if (r.reach !== undefined) {
        const kept = silencePlan(project, registry, data, { ...r, selected: [] }).silences.filter((x) => x.end <= r.reach! + 1e-3);
        memory.record(kept.map((x) => ({ rule: "silence", choice: "keep", flipped: false, value: roundSeconds(x.end - x.start) })));
      }
      delete (s.features.transcript as Reviews).silences;
    },
  },
];

/** Remove Silences' settings with the user's habit for this project's format, said in the panel. */
function learnedSilences(r: SilenceReview, memory: Memory, project: Project): SilenceReview {
  const min = silenceMin(memory.decisions(), projectFormat(project.settings));
  if (!min) return r;
  return { ...r, min: min.value, learned: [`Longer than ${min.value} s: you cut pauses longer than this and keep shorter ones${where(min)} (${min.agree} of ${min.of})`] };
}

/** Opening one review closes the others: the properties panel and the timeline's marks show one at a time. */
function openReview(s: Session, key: ReviewKey, review: SilenceReview | RetakeReview) {
  const t = { ...(s.features.transcript as object | undefined) } as Reviews;
  delete t.silences;
  delete (t as { fillers?: unknown }).fillers;
  delete t.retakes;
  s.features.transcript = { ...t, [key]: review };
}

/** A group to cut every take of: its span on the timeline, and its takes' words (transcript_retakes' `key`). */
interface CutAllGroup {
  start: number;
  end: number;
  key?: string;
}

/** Remove Retakes' settings, and in review (`session.features.transcript.retakes`) the takes chosen by hand. */
export interface RetakeReview extends RetakeOptions {
  /** Times inside takes chosen to keep: the last inside a group decides it. */
  kept: number[];
  /** Groups (their spans) to cut every take of, keeping none; keeping one of its takes takes it off. */
  cutAll?: CutAllGroup[];
  /** Going through the groups one at a time: a time in the group being looked at, or just before it. */
  current?: number;
  /** The take kept where none is chosen and OpenAI hasn't judged: the user's habit, else Beacon's pick. */
  prefer?: "first" | "last";
  /** The habits it opened with, said in the panel. */
  learned?: string[];
}

const retakeReview = (s: Session) => (s.features.transcript as Reviews | undefined)?.retakes;

/** `Asset.derived.retakes`: what OpenAI picked for each group of takes found in the asset's transcript. */
export interface RetakeJudgments {
  groups: Judgment[];
}

/** Who picks the take to keep: the preference's id and its options. */
const JUDGE = "retake-judge";
const judgedByOpenAI = (pref: Preferences) => pref(JUDGE) === "openai";

/** Settings the judge asks about: the defaults and the loosest the review allows, so most groups the review finds were judged. */
const JUDGED: RetakeOptions[] = [RETAKE_DEFAULTS, { minWords: 2, within: 120 }];

/** The words that follow a group, for the judge to tell whether a take leads on. */
const after = (words: Word[], takes: Take[]) =>
  words
    .slice(takes.at(-1)!.last + 1, takes.at(-1)!.last + 9)
    .map((w) => w.text)
    .join(" ");

/**
 * What Remove Retakes does with `o`: each group of takes of one line (`findRetakes`) on the timeline, the take kept
 * (chosen by hand, else OpenAI's pick when it is the judge and has judged it, else `bestTake`), and the ranges cut:
 * the other takes, of those after the kept one only what repeats the line.
 */
function retakePlan(project: Project, registry: FeatureRegistry, data: Data, pref: Preferences, o: RetakeReview) {
  const waiting = untranscribed(project, registry, data);
  const words = timelineWords(project, registry, data);
  const assetOf = new Map(project.tracks.flatMap((t) => t.clips).map((c) => [c.id, c.assetId]));
  const openai = judgedByOpenAI(pref);
  const judging = new Set<string>();
  const groups = findRetakes(words, o).map((takes) => {
    const spans = takes.map((t, k) => ({ start: words[t.first]!.start, end: k + 1 < takes.length ? words[takes[k + 1]!.first]!.start : words[t.last]!.end }));
    const [start, end] = [spans[0]!.start, spans.at(-1)!.end];
    const chosen = o.kept.filter((t) => t >= start - 1e-3 && t <= end + 1e-3).at(-1);
    const key = takes.map((t) => takeKey(words, t)).join(" / ");
    // By its words as well as where it is: a span shifted by a cut that was then undone can't land on another line.
    const none = (o.cutAll ?? []).some((g) => g.start < end - 1e-3 && g.end > start + 1e-3 && (g.key === undefined || g.key === key));
    let best = none ? -1 : chosen === undefined ? -1 : Math.max(0, spans.findLastIndex((s) => chosen >= s.start - 1e-3));
    let by: "you" | "openai" | "beacon" | "habit" = "you";
    let reason: string | undefined;
    if (best < 0 && !none && openai) {
      const asset = assetOf.get(words[takes[0]!.first]!.clip);
      const judged = asset ? data<RetakeJudgments>(asset, "retakes") : undefined;
      if (asset && !judged) judging.add(asset);
      // Matched by the takes' words, in order (takes said alike are told apart by where they are): the group judged,
      // or one it is part of whose pick is among these takes.
      const keys = takes.map((t) => takeKey(words, t));
      for (const g of judged?.groups ?? []) {
        const at = g.takes.findIndex((_, o) => keys.every((k, n) => g.takes[o + n] === k));
        if (at >= 0 && g.best >= at && g.best < at + keys.length) {
          [best, by, reason] = [g.best - at, "openai", g.reason];
          break;
        }
      }
    }
    if (best < 0 && !none && o.prefer) [best, by] = [o.prefer === "first" ? 0 : takes.length - 1, "habit"];
    if (best < 0 && !none) [best, by] = [bestTake(words, takes), "beacon"];
    return {
      start: roundSeconds(start),
      end: roundSeconds(end),
      takes: spans.map((s, k) => ({ start: roundSeconds(s.start), end: roundSeconds(s.end), text: takeText(words, takes[k]!) })),
      key,
      best,
      by,
      ...(reason ? { reason } : {}),
      cuts: (none ? ([[takes[0]!.first, takes.at(-1)!.last]] as [number, number][]) : retakeCuts(takes, best)).map(([a, b]) => wordSpan(words, a, b)),
    };
  });
  return {
    waiting,
    judging: [...judging],
    words: words.length,
    groups: groups.map(({ cuts: _, ...g }) => g),
    ranges: groups.flatMap((g) => g.cuts),
    all: groups.map((g) => g.cuts),
    current: currentOf(groups, o.current),
  };
}

const RetakeSettings = {
  minWords: z.int().min(2).max(8).describe("Words in a row a take must repeat from the one before to count as a retake of it"),
  within: z.number().positive().max(120).describe("Seconds between the starts of two takes, at most"),
};

/** Remove Retakes opened with the take the user usually keeps in this project's format. */
function learnedRetakes(memory: Memory, project: Project): Pick<RetakeReview, "prefer" | "learned"> {
  const take = retakeTake(memory.decisions(), projectFormat(project.settings));
  return take ? { prefer: take.value, learned: [`Keeps the ${take.value} take: you usually keep the ${take.value} one said${where(take)} (${take.agree} of ${take.of})`] } : {};
}

const retakeSessionCommands: SessionCommandDef[] = [
  {
    id: "retakes.review",
    description:
      "Open Remove Retakes' review (the AI panel's tile does): the timeline marks each line said more than once, the take kept green and the others red, and the properties panel lists each group's takes, until retakes.apply or retakes.close; with settings, change them. The user sees it, so an agent can prepare the cuts for them to look over",
    args: z.strictObject({ minWords: RetakeSettings.minWords.optional(), within: RetakeSettings.within.optional() }),
    apply: (s, a: Partial<RetakeOptions>, { pref, project, memory }) => {
      const r = retakeReview(s) ?? { ...retakeSettings(pref), kept: [], ...learnedRetakes(memory, project) };
      openReview(s, "retakes", { ...r, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) });
    },
  },
  ...reviewSteps("retakes", "Remove Retakes", "group of takes"),
  {
    id: "retakes.cutAll",
    description:
      "In Remove Retakes' review, cut every take of a group, keeping none (or with `on` false, keep one again, the one picked): `start` and `end`, the group's span from transcript_retakes. retakes.keep on one of its takes keeps that one instead",
    args: z.strictObject({ start: z.number().nonnegative(), end: z.number().nonnegative(), key: z.string().optional().describe("The group's `key` from transcript_retakes"), on: z.boolean().default(true) }),
    apply: (s, { start, end, key, on }: CutAllGroup & { on: boolean }) => {
      const r = retakeReview(s);
      if (!r) throw new Error("Remove Retakes' review isn't open: retakes.review opens it");
      const others = (r.cutAll ?? []).filter((g) => g.end <= start + 1e-3 || g.start >= end - 1e-3);
      r.cutAll = on ? [...others, { start, end, ...(key === undefined ? {} : { key }) }] : others;
    },
  },
];

/** After one item is cut from an open review, its flips and its place move with the timeline. */
const reviewShift: SessionCommandDef = {
  id: "reviews.shift",
  description: "Move the open review's flipped (or kept) times and the one it is on to match ranges just cut (timeline seconds, read before the cut); silences.apply and retakes.apply with `one` run it",
  args: z.strictObject({ ranges: z.array(z.strictObject({ start: z.number(), end: z.number() })) }),
  apply: (s, { ranges }: { ranges: { start: number; end: number }[] }) => {
    const silences = silenceReview(s);
    if (silences) {
      silences.selected = silences.selected.filter((t) => !ranges.some((x) => t >= x.start - 1e-3 && t <= x.end + 1e-3)).map((t) => afterCut(t, ranges));
      if (ranges.length) silences.reach = Math.max(...[...ranges.map((x) => x.end), ...(silences.reach === undefined ? [] : [silences.reach])].map((t) => afterCut(t, ranges)));
    }
    const r = retakeReview(s);
    if (r) {
      // A take kept in a group just cut is gone with it.
      r.kept = r.kept.filter((t) => !ranges.some((x) => t >= x.start && t < x.end)).map((t) => afterCut(t, ranges));
      if (r.cutAll) r.cutAll = r.cutAll.filter((g) => !ranges.some((x) => g.start >= x.start - 1e-3 && g.end <= x.end + 1e-3)).map((g) => ({ ...g, start: afterCut(g.start, ranges), end: afterCut(g.end, ranges) }));
      if (r.current !== undefined) r.current = afterCut(r.current, ranges);
    }
  },
};

const CutAll = z.array(z.strictObject({ start: z.number(), end: z.number(), key: z.string().optional() })).describe("Groups (their spans, and `key`s) to cut every take of, as retakes.cutAll sets");

/** What an open review says it learned, and how far it got: in ui_state with its settings, so taken and not used. */
const ReviewOwn = {
  learned: z.array(z.string()).optional().describe("The open review's own (as ui_state has it): not used"),
  reach: z.number().optional().describe("The open review's own (as ui_state has it): not used"),
};

const Only = z.number().nonnegative().optional().describe("Cut only the one holding this time, or else the next after it, whether or not it is marked to cut");

const Range = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

const TRANSCRIBERS = ["whisper", "apple", "openai"] as const satisfies readonly Transcriber[];
const transcriber = (pref: (id: string) => string): Transcriber => (TRANSCRIBERS as readonly string[]).includes(pref("transcriber")) ? (pref("transcriber") as Transcriber) : "whisper";

const retakesApply = defineAction({
  id: "retakes.apply",
  description:
    "Cut what Remove Retakes' open review marks to cut (its Apply button, ↩): of each group the takes not kept, one undo step, and close the review. With `one`, cut only the group retakes.focus is on (Cut This One) and stay open on the next",
  args: z.strictObject({ one: z.boolean().default(false) }),
  resolve: ({ one }, { project, registry, session, data, pref }) => {
    const r = retakeReview(session);
    if (!r) throw new Error("Remove Retakes' review isn't open: retakes.review opens it");
    // The takes as the review shows them, OpenAI's picks included, named by a time inside each.
    const plan = retakePlan(project, registry, data, pref, r);
    const kept = plan.groups.flatMap((g) => (g.best < 0 ? [] : [(g.takes[g.best]!.start + g.takes[g.best]!.end) / 2]));
    const cutAll = plan.groups.filter((g) => g.best < 0).map((g) => ({ start: g.start, end: g.end, key: g.key }));
    const args = { minWords: r.minWords, within: r.within, kept, cutAll };
    const decided = (g: (typeof plan.groups)[number]): DecisionInput => ({ rule: "retake", choice: g.best < 0 ? "none" : g.best === 0 ? "first" : g.best === g.takes.length - 1 ? "last" : "middle", flipped: g.by === "you" });
    if (!one) return { label: "Remove Retakes", steps: [{ command: "transcript.removeRetakes", args }], after: () => [{ command: "retakes.close" }], decisions: plan.groups.map(decided) };
    if (r.current === undefined) throw new Error("no retake to cut: retakes.focus goes to one");
    const group = plan.current === undefined ? undefined : plan.groups[plan.current];
    return { label: "Remove Retake", steps: [{ command: "transcript.removeRetakes", args: { ...args, only: r.current } }], after: ([cut]) => [{ command: "reviews.shift", args: { ranges: cut } }], decisions: group ? [decided(group)] : [] };
  },
});

const silencesApply = defineAction({
  id: "silences.apply",
  description:
    "Cut the silences picked in Remove Silences' open review (Apply, ↩ or ⌫), one undo step, staying open on the rest; with `all`, every silence it found (Apply All, ⇧↩), and close the review",
  args: z.strictObject({ all: z.boolean().default(false) }),
  resolve: ({ all }, { session, project, registry, data }) => {
    const r = silenceReview(session);
    if (!r) throw new Error("Remove Silences' review isn't open: silences.review opens it");
    const { min, keep, selected } = r;
    const quiet = r.quiet ?? 0;
    const cut = silencePlan(project, registry, data, r).silences.filter((x) => all || x.selected);
    const decisions = cut.map((x): DecisionInput => ({ rule: "silence", choice: "cut", flipped: false, value: roundSeconds(x.end - x.start) }));
    if (all) return { label: "Remove Silences", steps: [{ command: "transcript.removeSilences", args: { min, keep, quiet } }], after: () => [{ command: "silences.close" }], decisions };
    if (!selected.length) throw new Error("no silences picked: click one on the timeline (⇧-click for more), or Apply All");
    return { label: selected.length === 1 ? "Remove Silence" : "Remove Silences", steps: [{ command: "transcript.removeSilences", args: { min, keep, quiet, at: selected } }], after: ([cut]) => [{ command: "reviews.shift", args: { ranges: cut } }], decisions };
  },
});

/** Which review is open, if any: one at a time. */
const openReviewKey = (s: Session): ReviewKey | undefined => (["silences", "retakes"] as const).find((k) => (s.features.transcript as Reviews | undefined)?.[k]);

/** Transcripts of recordings and audio (Whisper on this Mac, Apple's transcriber or OpenAI's API), and editing by transcript. */
export const transcript = defineFeature({
  id: "transcript",
  version: 1,
  keepWhole: (doc, registry, data) => timelineWords(doc, registry, data).map((w) => [secondsToTicks(w.start), secondsToTicks(w.end)]),
  panels: [
    { open: (s: Session) => openReviewKey(s) === "silences", cancel: "silences.close", apply: { action: "silences.apply" }, applyAll: { action: "silences.apply", args: { all: true } } },
    ...(["retakes"] as const).map((key) => ({ open: (s: Session) => openReviewKey(s) === key, cancel: `${key}.close`, apply: { action: `${key}.apply` } })),
  ],
  preferences: [
    ...(
      [
        ["silenceMin", "Remove Silences: longer than", "Silences longer than this many seconds are found", SILENCE_DEFAULTS.min, { min: 0.2, max: 5 }],
        ["silenceKeep", "Remove Silences: leave", "Seconds of each cut silence left in, half each side", SILENCE_DEFAULTS.keep, { min: 0, max: 2 }],
        ["silenceQuiet", "Remove Silences: trim quiet", "Sound this many dB under the voice counts as silence too, the cut following the sound; 0 for off", SILENCE_DEFAULTS.quiet, { min: 0, max: 60 }],
        ["retakeMinWords", "Remove Retakes: repeats", "Words in a row a take must say again to count as a retake", RETAKE_DEFAULTS.minWords, { min: 2, max: 8 }],
        ["retakeWithin", "Remove Retakes: within", "Seconds between the starts of two takes, at most", RETAKE_DEFAULTS.within, { min: 5, max: 120 }],
      ] as const
    ).map(([id, title, description, value, range]) => ({
      id,
      title,
      description: `${description}: where the user last left its slider, which a review opens with`,
      options: [],
      default: String(value),
      range,
    })),
    {
      id: "transcriber",
      title: "Transcriber",
      description: "Who makes transcripts (Remove Silences, cutting by transcript, captions). Transcripts already made by one are kept for when it is chosen again",
      options: [
        { id: "whisper", title: "Whisper on this Mac", description: "Offline, best on technical words. 575 MB download, once" },
        { id: "apple", title: "Apple's transcriber", description: "Offline, no download, 5× faster. Weaker on technical words" },
        { id: "openai", title: "Whisper through OpenAI", description: "Uploads the audio to OpenAI, charged to your key", secret: "openai-api-key", online: true },
      ],
      default: "whisper",
    },
    {
      id: JUDGE,
      title: "Best take",
      description: "Who picks the take to keep of a line said more than once (Remove Retakes)",
      options: [
        { id: "beacon", title: "Beacon's own scoring", description: "Offline. Keeps the last full take, or a cleaner earlier one" },
        { id: "openai", title: "OpenAI", description: "OpenAI reads the takes' words and picks one, charged to your key", secret: "openai-api-key", online: true },
      ],
      default: "beacon",
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
      version: 8,
      needs: (pref) => (transcriber(pref) === "whisper" ? "whisper-model" : undefined),
      // Local Whisper's results keep the cache entries made before there was a choice.
      variant: (pref) => (transcriber(pref) === "whisper" ? undefined : transcriber(pref)),
      // Music and sound effects from a library say nothing to transcribe (a song's lyrics would become captions).
      applies: (asset) => !!asset.derived.media && !asset.derived.library && mediaInfo(asset).streams.some((s) => s.kind === "audio"),
      // Whisper takes the whole GPU: two at once (a project's media, opened) finish no sooner and ran the fans.
      oneAtATime: true,
      async analyze(asset, progress, env) {
        const audio = mediaInfo(asset).streams.filter((s) => s.kind === "audio");
        const streams: TranscriptData["streams"] = {};
        const who = transcriber(env.pref);
        const model = who === "whisper" ? env.resource("whisper-model") : undefined;
        const apiKey = who === "openai" ? await env.secret("openai-api-key") : undefined;
        for (const i of audio.keys()) {
          const src = sourceOf(asset, "audio", i);
          streams[i] = await transcribe(src.path, { stream: src.stream, transcriber: who, ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}), ...(env.quiet ? { quiet: true } : {}), onProgress: (f) => progress((i + f) / audio.length) });
        }
        return { streams } satisfies TranscriptData;
      },
    },
    {
      id: "retakes",
      description: "Which take OpenAI keeps of each line said more than once in the transcript (only when Best take is OpenAI, and only when asked: Remove Retakes' review asks)",
      version: 1,
      // Judged from one transcriber's words: another's are judged again.
      variant: (pref) => (judgedByOpenAI(pref) ? ["openai", transcriber(pref) === "whisper" ? undefined : transcriber(pref)].filter(Boolean).join("-") : undefined),
      applies: (asset) => !!asset.derived.media && mediaInfo(asset).streams.some((s) => s.kind === "audio"),
      when: "asked",
      async analyze(_asset, progress, env) {
        if (!judgedByOpenAI(env.pref)) throw new Error("Best take is Beacon's own scoring: OpenAI isn't asked (Settings › Transcripts › Best Take)");
        const transcript = env.data<TranscriptData>("transcript");
        if (!transcript) throw new Error("no transcript yet: the takes are judged from it");
        const apiKey = await env.secret("openai-api-key");
        if (!apiKey) throw new Error("no OpenAI API key: add one in Settings › AI");
        const found = new Map<string, { takes: string[]; said: string[]; then: string }>();
        for (const t of Object.values(transcript.streams)) {
          for (const o of JUDGED) {
            for (const takes of findRetakes(t.words, o)) {
              const keys = takes.map((x) => takeKey(t.words, x));
              found.set(keys.join("\n"), { takes: keys, said: takes.map((x) => takeText(t.words, x)), then: after(t.words, takes) });
            }
          }
        }
        const groups = [...found.values()];
        const picks = groups.length ? await judgeTakes(groups.map((g) => ({ takes: g.said, then: g.then })), apiKey, progress, jobSignal()) : [];
        return { groups: groups.map((g, k) => ({ takes: g.takes, best: picks[k]!.best, reason: picks[k]!.reason })) } satisfies RetakeJudgments;
      },
    },
  ],
  queries: [
    defineQuery({
      id: "transcript.get",
      description:
        "What is said on the timeline, in timeline seconds. `text`: lines as `[first-last word index] start-end  words`, with pauses; `words`: every word with its times. `from`/`to` narrow it to a stretch; `find` to where a phrase is said (`text`: the lines saying it; `words`: each place's words, ready for transcript_cut). Indices change after any edit, so re-read before cutting again. Empty until the transcript job for the media has finished",
      args: z.strictObject({
        format: z.enum(["text", "words"]).default("text"),
        from: z.number().nonnegative().optional(),
        to: z.number().nonnegative().optional(),
        find: z.string().trim().min(1).optional().describe("A phrase, matched by its words (case and punctuation ignored)"),
        pause: z.number().positive().default(0.5).describe("Seconds of silence that start a new line (text format)"),
      }),
      resource: { uri: "beacon://project/transcript", name: "Transcript", mimeType: "text/plain" },
      run({ format, from, to, find, pause }, { project, registry, data }) {
        const words = timelineWords(project, registry, data).filter((w) => (from === undefined || w.end > from) && (to === undefined || w.start < to));
        if (!words.length) return format === "words" ? [] : "(no transcript yet: check the transcript job, or the media has no speech)";
        if (!find) return format === "words" ? words : lines(words, pause);
        const places = phrasePlaces(words, find);
        if (format === "words") return places.flat();
        const hits = new Set(places.flat().map((w) => w.i));
        const said = lines(words, pause).split("\n").filter((l) => {
          const m = /^\[(\d+)-(\d+)\]/.exec(l);
          return m && [...hits].some((i) => i >= Number(m[1]) && i <= Number(m[2]));
        });
        return said.length ? said.join("\n") : `("${find}" isn't said${from !== undefined || to !== undefined ? " in that stretch" : ""})`;
      },
    }),
    defineQuery({
      id: "transcript.pauses",
      description: "Silences on the timeline (no detected speech in any audio clip, including before the first and after the last word) at least `min` seconds long, in timeline seconds; `after` is the index of the word before",
      args: z.strictObject({ min: z.number().nonnegative().default(0.5) }),
      run({ min }, { project, registry, data }) {
        return pauses(project, registry, data, timelineWords(project, registry, data))
          .filter((p) => p.end - p.start >= min)
          .map((p) => ({ ...p, start: roundSeconds(p.start), end: roundSeconds(p.end) }));
      },
    }),
    defineQuery({
      id: "transcript.silences",
      description:
        "What Remove Silences finds: each silence over `min` seconds (timeline seconds; the `min` and `keep` used are returned, the user's habit when not given: pass them to transcript_removeSilences), whether it is screen action (the recording's cursor moved or clicked) and whether it is picked to cut, with the seconds cutting all of them (`saved`) or the picked ones (`selectedSaved`) saves. Settings not given are the user's last (the open review's are in ui_state). `waiting`: media heard on the timeline with no transcript yet (the analyze tool with `transcript` makes one). `stacked`: why it can't cut (two voices heard at once)",
      args: z.strictObject({
        min: SilenceSettings.min.optional(),
        keep: SilenceSettings.keep.optional(),
        quiet: SilenceSettings.quiet.optional(),
        selected: z.array(z.number()).optional().describe("Times inside the silences picked, as silences.select sets"),
        ...ReviewOwn,
      }),
      run(args, { project, registry, data, pref, memory }) {
        const { learned: _, reach: __, ...given } = args;
        const o = { ...learnedSilences(silenceSettings(pref), memory ?? NO_MEMORY, project), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as SilenceReview;
        const plan = silencePlan(project, registry, data, o);
        const seconds = (ranges: { start: number; end: number }[]) => roundSeconds(cutRanges(project, registry, data, ranges).reduce((n, c) => n + c.end - c.start, 0));
        return { min: o.min, keep: o.keep, quiet: o.quiet, waiting: plan.waiting, silences: plan.silences, saved: seconds(plan.all), selectedSaved: seconds(plan.chosen), ...(plan.stacked ? { stacked: plan.stacked } : {}) };
      },
    }),
    defineQuery({
      id: "transcript.habits",
      description:
        "What Beacon has learned of how the user edits, from their choices in Remove Silences and Retakes (kept on this Mac): per format (`short`, 9:16; `long`), the shortest silence they cut and the take of a line they keep, each with how many of their decisions agree (`agree` of `of`) and `format` when learned from that format alone. The reviews open with these, and so do transcript_silences and _retakes when not given settings. A habit needs at least 5 decisions over 2 projects, about 80% one way. `decisions`: how many are kept",
      args: z.strictObject({}),
      run(_, { memory }) {
        const ds = (memory ?? NO_MEMORY).decisions();
        const habits = (format: "short" | "long") => ({
          silenceMin: silenceMin(ds, format) ?? null,
          retakeTake: retakeTake(ds, format) ?? null,
        });
        return { decisions: ds.length, short: habits("short"), long: habits("long") };
      },
    }),
    defineQuery({
      id: "transcript.retakes",
      description:
        "What Remove Retakes would cut: each line said more than once (a restart, a sentence said again after a stumble, a word or a few said again straight away) as a group of takes, each take's times (timeline seconds) and words, the take kept (`best`, from 0; -1 when every take is cut, by retakes.cutAll), its takes' words as one `key` and who picked it (`by`: you, OpenAI, the user's habit of keeping the first or last take, or Beacon's own scoring), and the seconds saved. Of the takes after the kept one only what repeats the line is cut, so what the last goes on to say stays. `waiting`: media with no transcript yet; `judging`: media OpenAI hasn't judged yet (when Best take is OpenAI: the analyze tool with `retakes` asks)",
      args: z.strictObject({
        minWords: RetakeSettings.minWords.optional(),
        within: RetakeSettings.within.optional(),
        kept: z.array(z.number()).optional().describe("Times inside takes to keep instead, as retakes.keep sets"),
        cutAll: CutAll.optional(),
        current: z.number().optional().describe("A time in the group being looked at, as retakes.focus sets: `current` answers its index"),
        prefer: z.enum(["first", "last"]).optional().describe("The take kept where none is chosen and OpenAI hasn't judged; the user's habit when not given"),
        learned: ReviewOwn.learned,
      }),
      run({ minWords, within, kept, cutAll, current, prefer }, { project, registry, data, pref, memory }) {
        const habit = prefer ? { prefer } : learnedRetakes(memory ?? NO_MEMORY, project);
        const plan = retakePlan(project, registry, data, pref, { ...retakeSettings(pref), ...habit, ...(minWords === undefined ? {} : { minWords }), ...(within === undefined ? {} : { within }), kept: kept ?? [], cutAll: cutAll ?? [], ...(current === undefined ? {} : { current }) });
        const removed = cutRanges(project, registry, data, plan.ranges);
        return {
          waiting: plan.waiting,
          judging: plan.judging,
          judge: judgedByOpenAI(pref) ? "openai" : "beacon",
          groups: plan.groups,
          cuts: removed.length,
          saved: roundSeconds(removed.reduce((n, c) => n + c.end - c.start, 0)),
          ...(plan.current === undefined ? {} : { current: plan.current }),
        };
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
  habits: (decisions, format) => {
    const out: HabitInfo[] = [];
    const info = <T,>(id: string, text: string, h: Habit<T>, rules: string[]): HabitInfo => ({ id, text, agree: h.agree, of: h.of, ...(h.format ? { format: h.format } : {}), rules });
    const min = silenceMin(decisions, format);
    if (min) out.push(info("silence", `Remove Silences finds pauses longer than ${min.value} s: you cut those and keep shorter ones`, min, ["silence"]));
    const take = retakeTake(decisions, format);
    if (take) out.push(info("retake", `Remove Retakes keeps the ${take.value} take of a line said again`, take, ["retake"]));
    return out;
  },
  sessionCommands: [...silenceSessionCommands, ...retakeSessionCommands, reviewShift],
  actions: [retakesApply, silencesApply],
  commands: [
    defineCommand({
      id: "transcript.removeRetakes",
      description:
        "Remove Retakes: of each line said more than once, keep one take and cut the others (of those after it only what repeats the line), as transcript_retakes shows; one undo step. The take kept is the one `kept` names, else the user's habit (`prefer`), else Beacon's own pick; groups `cutAll` names lose every take; retakes.apply runs it from the open review with OpenAI's picks too",
      args: z.strictObject({
        ...RetakeSettings,
        kept: z.array(z.number()).default([]),
        cutAll: CutAll.default([]),
        only: Only,
        prefer: z.enum(["first", "last"]).optional().describe("The take kept where none is chosen; the user's habit when not given, as transcript_retakes shows"),
      }),
      apply(doc, { only, prefer, ...o }, ctx) {
        const habit = prefer ? { prefer } : learnedRetakes(ctx.memory ?? NO_MEMORY, doc);
        const plan = retakePlan(doc, ctx.registry, ctx.data, () => "beacon", { ...o, ...(habit.prefer ? { prefer: habit.prefer } : {}), ...(only === undefined ? {} : { current: only }) });
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        if (only === undefined) return cut(doc, ctx, plan.ranges);
        if (plan.current === undefined) throw new Error(`no retake at or after ${only} s`);
        return cut(doc, ctx, plan.all[plan.current]!);
      },
    }),
    defineCommand({
      id: "transcript.removeSilences",
      description:
        "Remove Silences: cut every silence over `min` seconds down to `keep`, with `quiet` the cut following the sound (pass transcript_silences' `quiet`, the user's setting) (screen action included: check it with frames), or with `at` only the silences holding those times, as transcript_silences shows; one undo step. Refused while two voices are heard at once. silences.apply runs it from the open review",
      args: z.strictObject({ ...SilenceSettings, quiet: SilenceSettings.quiet.default(0), at: z.array(z.number()).min(1).optional().describe("A time inside each silence to cut; without it, all of them") }),
      apply(doc, { at, ...o }, ctx) {
        const plan = silencePlan(doc, ctx.registry, ctx.data, { ...o, ...(at ? { selected: at } : {}) });
        if (plan.stacked) throw new Error(plan.stacked);
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        if (at && !plan.silences.some((p) => p.selected)) throw new Error(`no silence over ${o.min} s at ${at.join(", ")} s`);
        return cut(doc, ctx, at ? plan.chosen : plan.all);
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
            if (!words[Math.min(a, b)] || !words[Math.max(a, b)]) throw new Error(`word range [${a}, ${b}] is outside 0-${words.length - 1}`);
            return wordSpan(words, Math.min(a, b), Math.max(a, b), lead);
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
        quiet: SilenceSettings.quiet.default(0),
        from: z.number().nonnegative().optional(),
        to: z.number().nonnegative().optional(),
        except: z.array(z.strictObject({ start: z.number(), end: z.number() })).default([]),
      }),
      apply(doc, { min, keep, quiet, from, to, except }, ctx) {
        const ranges = pauseCuts(doc, ctx.registry, ctx.data, { min, keep, quiet, from, to, except });
        if (!ranges) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        return cut(doc, ctx, ranges);
      },
    }),
  ],
});
