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
} from "@beacon/model";
import { clipStream, mediaInfo, sourceOf } from "../media";
import { rippleDeleteRanges } from "../timeline";
import type { CursorData } from "../cursor";
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
      if (!clip.assetId || !registry.hasTrait(clip.type, "audio")) continue;
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
  let out: [number, number][] = ranges.map((r) => [...r]);
  for (let changed = true; changed; ) {
    changed = false;
    const merged = mergeSpans(out, sliver);
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
  const outward = cutRanges(doc, ranges);
  rippleDeleteRanges(doc, outward, ctx);
  return outward.map((r) => ({ start: roundSeconds(r.start), end: roundSeconds(r.end) }));
}

/** What Remove Silences cuts: each silence over `min` seconds, less `keep` seconds of it (half each side; all of it before the first word, none after the last), outside `except`. */
function pauseCuts(doc: Project, registry: FeatureRegistry, data: Data, o: { min: number; keep: number; from?: number; to?: number; except: { start: number; end: number }[] }) {
  const words = timelineWords(doc, registry, data);
  if (!words.length) return undefined;
  return pauses(doc, registry, data, words)
    .filter((p) => p.end - p.start > o.min && (o.from === undefined || p.start >= o.from) && (o.to === undefined || p.end <= o.to))
    .flatMap((p) =>
      subtractSpans(
        [p.after === undefined ? 0 : p.start + o.keep / 2, p.end >= ticksToSeconds(projectDuration(doc)) - 1e-6 && p.after !== undefined ? p.end : p.end - o.keep / 2],
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
  /** Going through them one at a time: a time in the silence being looked at, or just before it. */
  current?: number;
}

const SILENCE_DEFAULTS: SilenceReview = { min: 0.6, keep: 0.3, keepActive: true, flipped: [] };

const silenceReview = (s: Session) => (s.features.transcript as { silences?: SilenceReview } | undefined)?.silences;

/**
 * What Remove Silences does with `o`: each silence over `min`, whether it is screen action and whether it is cut
 * (screen action is kept with `keepActive`, and a flip turns either way round), and the ranges removed.
 */
function silencePlan(project: Project, registry: FeatureRegistry, data: Data, o: SilenceReview) {
  const waiting = untranscribed(project, registry, data);
  const words = timelineWords(project, registry, data);
  if (!words.length) return { waiting, words: 0, silences: [], ranges: [], current: undefined };
  const silences = pauses(project, registry, data, words)
    .filter((p) => p.end - p.start > o.min)
    .map((p) => {
      const active = screenActive(project, data, p.start, p.end);
      const flips = o.flipped.filter((t) => t >= p.start - 1e-3 && t <= p.end).length;
      return { start: p.start, end: p.end, active, cut: !(o.keepActive && active) !== (flips % 2 === 1) };
    });
  const except = silences.filter((p) => !p.cut).map(({ start, end }) => ({ start, end }));
  const ranges = pauseCuts(project, registry, data, { min: o.min, keep: o.keep, except }) ?? [];
  return { waiting, words: words.length, silences, ranges, current: currentOf(silences, o.current) };
}

const SilenceSettings = {
  min: z.number().positive().max(10).describe("Silences longer than this many seconds are cut"),
  keep: z.number().nonnegative().max(2).describe("Seconds of each cut silence left in, half each side"),
  keepActive: z.boolean().describe("Keep silences where the recording's cursor moves or clicks (screen action)"),
};

type ReviewKey = "silences" | "fillers" | "retakes";
type Reviews = { silences?: SilenceReview; fillers?: FillerReview; retakes?: RetakeReview };

/** A review's flip, focus and close: the reviews differ only in what they name. Remove Retakes keeps a take rather than flipping one. */
function reviewSteps(key: ReviewKey, title: string, item: string): SessionCommandDef[] {
  const open = (s: Session) => {
    const r = (s.features.transcript as Reviews | undefined)?.[key];
    if (!r) throw new Error(`${title}' review isn't open: ${key}.review opens it`);
    return r;
  };
  const At = z.strictObject({ at: z.number().nonnegative() });
  const flip: SessionCommandDef =
    key === "retakes"
      ? {
          id: "retakes.keep",
          description:
            "In Remove Retakes' review, keep this take of its group instead of the one picked, cutting the group's others (clicking it on the timeline does): `at`, a time inside the take, e.g. its start from transcript_retakes",
          args: At,
          apply: (s, { at }: { at: number }) => {
            const r = open(s) as RetakeReview;
            r.kept.push(at);
            if (r.cutAll) r.cutAll = r.cutAll.filter((g) => at < g.start - 1e-3 || at > g.end + 1e-3);
          },
        }
      : {
          id: `${key}.flip`,
          description: `In ${title}' review, keep a ${item} it would cut, or cut one it would keep (clicking it on the timeline does): \`at\`, a time inside it, e.g. its start from transcript_${key}`,
          args: At,
          apply: (s, { at }: { at: number }) => void (open(s) as SilenceReview | FillerReview).flipped.push(at),
        };
  return [
    flip,
    {
      id: `${key}.focus`,
      description: `In ${title}' review, go to one ${item} to look at it on its own (the review's ‹ › buttons, or ⌥-clicking it on the timeline): \`at\`, a time inside it, e.g. its start from transcript_${key}. ${key}.apply with \`one\` then cuts only that one`,
      args: At,
      apply: (s, { at }: { at: number }) => void (open(s).current = at),
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
      "Open Remove Silences' review (the AI panel's tile does): the timeline marks each silence to cut or keep and the properties panel shows these settings, until silences.apply or silences.close; with settings, change them. The user sees it, so an agent can prepare the cuts for them to look over",
    args: z.strictObject({ min: SilenceSettings.min.optional(), keep: SilenceSettings.keep.optional(), keepActive: SilenceSettings.keepActive.optional() }),
    apply: (s, a: Partial<SilenceReview>) => {
      const r = { ...(silenceReview(s) ?? SILENCE_DEFAULTS), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) } as SilenceReview;
      openReview(s, "silences", { ...r, keep: Math.min(r.keep, r.min) });
    },
  },
  ...reviewSteps("silences", "Remove Silences", "silence"),
];

/** Remove Filler Words' review (`session.features.transcript.fillers`): the fillers flipped by hand. */
export interface FillerReview {
  /** Times inside fillers whose cut-or-keep was flipped: an odd number in one flips it. */
  flipped: number[];
  /** Going through them one at a time: a time in the filler being looked at, or just before it. */
  current?: number;
}

const fillerReview = (s: Session) => (s.features.transcript as { fillers?: FillerReview } | undefined)?.fillers;

/**
 * The time cut for filler words `first`..`last`: them and the shorter of the pauses either side, so the pause
 * left is the longer one ("so, um, the" becomes "so, the"; a long pause stays for Remove Silences, which knows
 * screen action). An edge touching a kept word goes to the nearest frame: `cut` rounds outward, which would
 * take up to a frame of that word.
 */
function fillerCut(project: Project, words: TimelineWord[], first: TimelineWord, last: TimelineWord) {
  const [prev, next] = [words[first.i - 1], words[last.i + 1]];
  const pause = Math.min(prev ? first.start - prev.end : Infinity, next ? next.start - last.end : Infinity);
  const end = last.end + (Number.isFinite(pause) ? Math.max(0, pause) : 0);
  const frame = (t: number) => ticksToSeconds(snapSeconds(t, project.settings.fps));
  return { start: prev && first.start - prev.end < 1e-3 ? frame(first.start) : first.start, end: next && next.start - end < 1e-3 ? frame(end) : end };
}

/**
 * What Remove Filler Words does: each run of filler words in the transcript ("Uh, uh, uh"), the time it cuts
 * (`fillerCut`) and whether it is cut (all are, but a flip keeps one), and the ranges removed.
 */
function fillerPlan(project: Project, registry: FeatureRegistry, data: Data, o: FillerReview) {
  const waiting = untranscribed(project, registry, data);
  const words = timelineWords(project, registry, data);
  const runs: [TimelineWord, TimelineWord][] = [];
  for (const w of words) {
    if (!isFiller(w.text)) continue;
    const last = runs.at(-1);
    if (last && last[1].i === w.i - 1) last[1] = w;
    else runs.push([w, w]);
  }
  const found = runs.map(([first, last]) => {
    const r = fillerCut(project, words, first, last);
    const flips = o.flipped.filter((t) => t >= r.start - 1e-3 && t <= r.end).length;
    return { ...r, text: words.slice(first.i, last.i + 1).map((w) => w.text).join(" "), cut: flips % 2 === 0 };
  });
  return {
    waiting,
    words: words.length,
    fillers: found.map((f) => ({ ...f, start: roundSeconds(f.start), end: roundSeconds(f.end) })),
    // Unrounded: a frame time rounded to the millisecond can sit just short of its frame.
    ranges: found.filter((f) => f.cut).map(({ start, end }) => ({ start, end })),
    all: found.map(({ start, end }) => ({ start, end })),
    current: currentOf(found, o.current),
  };
}

/** Opening one review closes the others: the properties panel and the timeline's marks show one at a time. */
function openReview(s: Session, key: ReviewKey, review: SilenceReview | FillerReview | RetakeReview) {
  const t = { ...(s.features.transcript as object | undefined) } as Reviews;
  delete t.silences;
  delete t.fillers;
  delete t.retakes;
  s.features.transcript = { ...t, [key]: review };
}

const fillerSessionCommands: SessionCommandDef[] = [
  {
    id: "fillers.review",
    description:
      "Open Remove Filler Words' review (the AI panel's tile does): the timeline marks each filler (\"um\", \"uh\", \"er\", \"hmm\" in the transcript) to cut or keep and the properties panel sums it up, until fillers.apply or fillers.close. The user sees it, so an agent can prepare the cuts for them to look over",
    args: z.strictObject({}),
    apply: (s) => openReview(s, "fillers", fillerReview(s) ?? { flipped: [] }),
  },
  ...reviewSteps("fillers", "Remove Filler Words", "filler"),
];

/** Remove Retakes' settings, and in review (`session.features.transcript.retakes`) the takes chosen by hand. */
export interface RetakeReview extends RetakeOptions {
  /** Times inside takes chosen to keep: the last inside a group decides it. */
  kept: number[];
  /** Groups (their spans) to cut every take of, keeping none; keeping one of its takes takes it off. */
  cutAll?: { start: number; end: number }[];
  /** Going through the groups one at a time: a time in the group being looked at, or just before it. */
  current?: number;
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
    const none = (o.cutAll ?? []).some((g) => g.start < end - 1e-3 && g.end > start + 1e-3);
    let best = none ? -1 : chosen === undefined ? -1 : Math.max(0, spans.findLastIndex((s) => chosen >= s.start - 1e-3));
    let by: "you" | "openai" | "beacon" = "you";
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
    if (best < 0 && !none) [best, by] = [bestTake(words, takes), "beacon"];
    return {
      start: roundSeconds(start),
      end: roundSeconds(end),
      takes: spans.map((s, k) => ({ start: roundSeconds(s.start), end: roundSeconds(s.end), text: takeText(words, takes[k]!) })),
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

const retakeSessionCommands: SessionCommandDef[] = [
  {
    id: "retakes.review",
    description:
      "Open Remove Retakes' review (the AI panel's tile does): the timeline marks each line said more than once, the take kept green and the others red, and the properties panel lists each group's takes, until retakes.apply or retakes.close; with settings, change them. The user sees it, so an agent can prepare the cuts for them to look over",
    args: z.strictObject({ minWords: RetakeSettings.minWords.optional(), within: RetakeSettings.within.optional() }),
    apply: (s, a: Partial<RetakeOptions>) => {
      const r = retakeReview(s) ?? { ...RETAKE_DEFAULTS, kept: [] };
      openReview(s, "retakes", { ...r, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) });
    },
  },
  ...reviewSteps("retakes", "Remove Retakes", "group of takes"),
  {
    id: "retakes.cutAll",
    description:
      "In Remove Retakes' review, cut every take of a group, keeping none (or with `on` false, keep one again, the one picked): `start` and `end`, the group's span from transcript_retakes. retakes.keep on one of its takes keeps that one instead",
    args: z.strictObject({ start: z.number().nonnegative(), end: z.number().nonnegative(), on: z.boolean().default(true) }),
    apply: (s, { start, end, on }: { start: number; end: number; on: boolean }) => {
      const r = retakeReview(s);
      if (!r) throw new Error("Remove Retakes' review isn't open: retakes.review opens it");
      const others = (r.cutAll ?? []).filter((g) => g.end <= start + 1e-3 || g.start >= end - 1e-3);
      r.cutAll = on ? [...others, { start, end }] : others;
      if (!on) r.kept = r.kept.filter((t) => t < start - 1e-3 || t > end + 1e-3);
    },
  },
];

/** After one item is cut from an open review, its flips and its place move with the timeline. */
const reviewShift: SessionCommandDef = {
  id: "reviews.shift",
  description: "Move the open review's flipped (or kept) times and the one it is on to match ranges just cut (timeline seconds, read before the cut); silences.apply, fillers.apply and retakes.apply with `one` run it",
  args: z.strictObject({ ranges: z.array(z.strictObject({ start: z.number(), end: z.number() })) }),
  apply: (s, { ranges }: { ranges: { start: number; end: number }[] }) => {
    for (const r of [silenceReview(s), fillerReview(s)]) {
      if (!r) continue;
      r.flipped = r.flipped.map((t) => afterCut(t, ranges));
      if (r.current !== undefined) r.current = afterCut(r.current, ranges);
    }
    const r = retakeReview(s);
    if (r) {
      // A take kept in a group just cut is gone with it.
      r.kept = r.kept.filter((t) => !ranges.some((x) => t >= x.start && t < x.end)).map((t) => afterCut(t, ranges));
      if (r.cutAll) r.cutAll = r.cutAll.filter((g) => !ranges.some((x) => g.start >= x.start - 1e-3 && g.end <= x.end + 1e-3)).map((g) => ({ start: afterCut(g.start, ranges), end: afterCut(g.end, ranges) }));
      if (r.current !== undefined) r.current = afterCut(r.current, ranges);
    }
  },
};

const CutAll = z.array(z.strictObject({ start: z.number(), end: z.number() })).describe("Groups (their spans) to cut every take of, as retakes.cutAll sets");

const Only = z.number().nonnegative().optional().describe("Cut only the one holding this time, or else the next after it, whether or not it is marked to cut");

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
        { id: "openai", title: "Whisper through OpenAI", description: "OpenAI's Whisper over its API with your own API key: the audio is uploaded to OpenAI to be transcribed, and OpenAI charges your account for it", secret: "openai-api-key", online: true },
      ],
      default: "whisper",
    },
    {
      id: JUDGE,
      title: "Best take",
      description: "Who picks the take to keep of a line said more than once (Remove Retakes)",
      options: [
        { id: "beacon", title: "Beacon's own scoring", description: "On this Mac: the last take that says the whole line, unless an earlier one has noticeably fewer fillers and stumbles" },
        { id: "openai", title: "OpenAI", description: "OpenAI's API with your own API key reads each line's takes and picks one: their words are sent to OpenAI (not the audio), and OpenAI charges your account for it", secret: "openai-api-key", online: true },
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
        if (!apiKey) throw new Error("no OpenAI API key: add one in Settings › Transcripts");
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
        current: z.number().optional().describe("A time in the silence being looked at, as silences.focus sets: `current` answers its index"),
      }),
      run(args, { project, registry, data }) {
        const o = { ...SILENCE_DEFAULTS, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) } as SilenceReview;
        const plan = silencePlan(project, registry, data, o);
        const removed = cutRanges(project, plan.ranges);
        return { waiting: plan.waiting, silences: plan.silences, cuts: removed.length, saved: roundSeconds(removed.reduce((n, c) => n + c.end - c.start, 0)), ...(plan.current === undefined ? {} : { current: plan.current }) };
      },
    }),
    defineQuery({
      id: "transcript.fillers",
      description:
        "What Remove Filler Words would cut: each filler (\"um\", \"uh\", \"er\", \"hmm\"; a run like \"uh, uh, uh\" is one) the transcript has, its text, the time cut (it and the shorter of the pauses either side, timeline seconds) and whether it is cut, with the seconds saved. Only what the transcriber wrote down is found: Whisper on this Mac and Apple's transcriber keep most fillers. `waiting`: media heard on the timeline with no transcript yet",
      args: z.strictObject({
        flipped: z.array(z.number()).optional().describe("Times inside fillers to flip, as fillers.flip does"),
        current: z.number().optional().describe("A time in the filler being looked at, as fillers.focus sets: `current` answers its index"),
      }),
      run({ flipped, current }, { project, registry, data }) {
        const plan = fillerPlan(project, registry, data, { flipped: flipped ?? [], ...(current === undefined ? {} : { current }) });
        const removed = cutRanges(project, plan.ranges);
        return { waiting: plan.waiting, fillers: plan.fillers, cuts: removed.length, saved: roundSeconds(removed.reduce((n, c) => n + c.end - c.start, 0)), ...(plan.current === undefined ? {} : { current: plan.current }) };
      },
    }),
    defineQuery({
      id: "transcript.retakes",
      description:
        "What Remove Retakes would cut: each line said more than once (a restart, a sentence said again after a stumble) as a group of takes, each take's times (timeline seconds) and words, the take kept (`best`, from 0; -1 when every take is cut, by retakes.cutAll) and who picked it (`by`: you, OpenAI or Beacon's own scoring), and the seconds saved. Of the takes after the kept one only what repeats the line is cut, so what the last goes on to say stays. `waiting`: media with no transcript yet; `judging`: media OpenAI hasn't judged yet (when Best take is OpenAI: the analyze tool with `retakes` asks)",
      args: z.strictObject({
        minWords: RetakeSettings.minWords.optional(),
        within: RetakeSettings.within.optional(),
        kept: z.array(z.number()).optional().describe("Times inside takes to keep instead, as retakes.keep sets"),
        cutAll: CutAll.optional(),
        current: z.number().optional().describe("A time in the group being looked at, as retakes.focus sets: `current` answers its index"),
      }),
      run({ minWords, within, kept, cutAll, current }, { project, registry, data, pref }) {
        const plan = retakePlan(project, registry, data, pref, { minWords: minWords ?? RETAKE_DEFAULTS.minWords, within: within ?? RETAKE_DEFAULTS.within, kept: kept ?? [], cutAll: cutAll ?? [], ...(current === undefined ? {} : { current }) });
        const removed = cutRanges(project, plan.ranges);
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
  sessionCommands: [...silenceSessionCommands, ...fillerSessionCommands, ...retakeSessionCommands, reviewShift],
  actions: [
    defineAction({
      id: "retakes.apply",
      description:
        "Cut what Remove Retakes' open review marks to cut (its Apply All button): of each group the takes not kept, one undo step, and close the review. With `one`, cut only the group retakes.focus is on (Cut This One) and stay open on the next",
      args: z.strictObject({ one: z.boolean().default(false) }),
      resolve: ({ one }, { project, registry, session, data, pref }) => {
        const r = retakeReview(session);
        if (!r) throw new Error("Remove Retakes' review isn't open: retakes.review opens it");
        // The takes as the review shows them, OpenAI's picks included, named by a time inside each.
        const plan = retakePlan(project, registry, data, pref, r);
        const kept = plan.groups.flatMap((g) => (g.best < 0 ? [] : [(g.takes[g.best]!.start + g.takes[g.best]!.end) / 2]));
        const cutAll = plan.groups.filter((g) => g.best < 0).map((g) => ({ start: g.start, end: g.end }));
        const args = { minWords: r.minWords, within: r.within, kept, cutAll };
        if (!one) return { label: "Remove Retakes", steps: [{ command: "transcript.removeRetakes", args }], after: () => [{ command: "retakes.close" }] };
        if (r.current === undefined) throw new Error("no retake to cut: retakes.focus goes to one");
        return { label: "Remove Retake", steps: [{ command: "transcript.removeRetakes", args: { ...args, only: r.current } }], after: ([cut]) => [{ command: "reviews.shift", args: { ranges: cut } }] };
      },
    }),
    defineAction({
      id: "silences.apply",
      description:
        "Cut what Remove Silences' open review marks to cut (its Apply button), one undo step, and close the review. With `one`, cut only the silence silences.focus is on (Cut This One), cut or kept, and stay open on the next",
      args: z.strictObject({ one: z.boolean().default(false) }),
      resolve: ({ one }, { session }) => {
        const r = silenceReview(session);
        if (!r) throw new Error("Remove Silences' review isn't open: silences.review opens it");
        const { current, ...settings } = r;
        if (!one) return { label: "Remove Silences", steps: [{ command: "transcript.removeSilences", args: settings }], after: () => [{ command: "silences.close" }] };
        if (current === undefined) throw new Error("no silence to cut: silences.focus goes to one");
        return { label: "Remove Silence", steps: [{ command: "transcript.removeSilences", args: { ...settings, only: current } }], after: ([cut]) => [{ command: "reviews.shift", args: { ranges: cut } }] };
      },
    }),
    defineAction({
      id: "fillers.apply",
      description:
        "Cut what Remove Filler Words' open review marks to cut (its Apply button), one undo step, and close the review. With `one`, cut only the filler fillers.focus is on (Cut This One), cut or kept, and stay open on the next",
      args: z.strictObject({ one: z.boolean().default(false) }),
      resolve: ({ one }, { session }) => {
        const r = fillerReview(session);
        if (!r) throw new Error("Remove Filler Words' review isn't open: fillers.review opens it");
        if (!one) return { label: "Remove Filler Words", steps: [{ command: "transcript.removeFillers", args: { flipped: r.flipped } }], after: () => [{ command: "fillers.close" }] };
        if (r.current === undefined) throw new Error("no filler to cut: fillers.focus goes to one");
        return { label: "Remove Filler Word", steps: [{ command: "transcript.removeFillers", args: { flipped: r.flipped, only: r.current } }], after: ([cut]) => [{ command: "reviews.shift", args: { ranges: cut } }] };
      },
    }),
  ],
  commands: [
    defineCommand({
      id: "transcript.removeRetakes",
      description:
        "Remove Retakes: of each line said more than once, keep one take and cut the others (of those after it only what repeats the line), as transcript_retakes shows; one undo step. The take kept is the one `kept` names, else Beacon's own pick; groups `cutAll` names lose every take; retakes.apply runs it from the open review with OpenAI's picks too",
      args: z.strictObject({ ...RetakeSettings, kept: z.array(z.number()).default([]), cutAll: CutAll.default([]), only: Only }),
      apply(doc, { only, ...o }, ctx) {
        const plan = retakePlan(doc, ctx.registry, ctx.data, () => "beacon", { ...o, ...(only === undefined ? {} : { current: only }) });
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        if (only === undefined) return cut(doc, ctx, plan.ranges);
        if (plan.current === undefined) throw new Error(`no retake at or after ${only} s`);
        return cut(doc, ctx, plan.all[plan.current]!);
      },
    }),
    defineCommand({
      id: "transcript.removeFillers",
      description:
        "Remove Filler Words: cut every filler the transcript has (\"um\", \"uh\", \"er\", \"hmm\") with the shorter of the pauses either side (the longer is left, for Remove Silences), except those `flipped` names, as transcript_fillers shows; one undo step. fillers.apply runs it from the open review",
      args: z.strictObject({ flipped: z.array(z.number()).default([]), only: Only }),
      apply(doc, { flipped, only }, ctx) {
        const plan = fillerPlan(doc, ctx.registry, ctx.data, { flipped, ...(only === undefined ? {} : { current: only }) });
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        if (only === undefined) return cut(doc, ctx, plan.ranges);
        if (plan.current === undefined) throw new Error(`no filler at or after ${only} s`);
        return cut(doc, ctx, [plan.all[plan.current]!]);
      },
    }),
    defineCommand({
      id: "transcript.removeSilences",
      description:
        "Remove Silences: cut every silence over `min` seconds down to `keep`, keeping screen action with `keepActive` and turning round the silences `flipped` names, as transcript_silences shows; one undo step. silences.apply runs it from the open review",
      args: z.strictObject({ ...SilenceSettings, flipped: z.array(z.number()).default([]), only: Only }),
      apply(doc, { only, ...o }, ctx) {
        const plan = silencePlan(doc, ctx.registry, ctx.data, { ...o, ...(only === undefined ? {} : { current: only }) });
        if (!plan.words) throw new Error("no transcript on the timeline yet");
        refuseUntranscribed(doc, ctx.registry, ctx.data);
        if (only === undefined) return cut(doc, ctx, plan.ranges);
        const one = plan.current === undefined ? undefined : plan.silences[plan.current];
        if (!one) throw new Error(`no silence at or after ${only} s`);
        // Cut even when marked to keep: it was asked for by name.
        const all = silencePlan(doc, ctx.registry, ctx.data, { ...o, keepActive: false, flipped: [] });
        return cut(doc, ctx, all.ranges.filter((r) => r.start >= one.start - 1e-3 && r.end <= one.end + 1e-3));
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
