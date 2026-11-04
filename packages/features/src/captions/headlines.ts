import type { TimelineWord } from "../transcript";
import { author, onDevice, type Meter } from "../motion/compose";

/** A sentence that could be a headline: its words' span (timeline seconds), its text, and the keyword in it. */
export interface HeadlineIdea {
  from: number;
  to: number;
  text: string;
  keyword: string;
  /** Left out by the user in the review. */
  off?: boolean;
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Sentences (ends and pauses of half a second), of 3 to 14 words: longer ones are split at their longest pause. */
export function sentences(words: TimelineWord[]): TimelineWord[][] {
  const out: TimelineWord[][] = [];
  let cur: TimelineWord[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (/[.!?]$/.test(prev.text) || w.start - prev.end >= 0.5)) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  const split = (s: TimelineWord[]): TimelineWord[][] => {
    if (s.length <= 14) return [s];
    let at = 7;
    for (let i = 4; i < s.length - 3; i++) if (s[i]!.start - s[i - 1]!.end > s[at]!.start - s[at - 1]!.end) at = i;
    return [...split(s.slice(0, at)), ...split(s.slice(at))];
  };
  return out.flatMap(split).filter((s) => s.length >= 3);
}

/**
 * The keyword as the sentence says it (1 to 3 words in a row), or undefined when none of it is there. Words given
 * in another order ("revenue grew" for "grew revenue") are taken where the sentence has them side by side; else its
 * longest word that is there.
 */
export function keywordIn(sentence: string[], keyword: string): string | undefined {
  const want = keyword.split(/\s+/).map(norm).filter(Boolean).slice(0, 3);
  if (!want.length) return undefined;
  const words = sentence.map(norm);
  const i = words.findIndex((_, k) => want.every((w, j) => words[k + j] === w));
  if (i >= 0) return sentence.slice(i, i + want.length).join(" ");
  const at = [...new Set(want.map((w) => words.indexOf(w)).filter((k) => k >= 0))].sort((a, b) => a - b);
  if (!at.length) return undefined;
  if (at.at(-1)! - at[0]! === at.length - 1) return sentence.slice(at[0]!, at.at(-1)! + 1).join(" ");
  const longest = at.reduce((a, b) => (words[b]!.length > words[a]!.length ? b : a));
  return sentence[longest];
}

/** About one headline every 12 seconds of talk, at least one. */
export const headlineCount = (seconds: number) => Math.max(1, Math.round(seconds / 12));

const SYSTEM = (count: number) =>
  [
    "You pick the headlines for a short vertical video's captions: a few sentences shown big beside the speaker, each with one keyword drawn large.",
    `Pick about ${count} of the numbered sentences: strong claims, surprising facts, numbers, turns in the story; never greetings, filler or half thoughts. Spread them out.`,
    "For each, its keyword: 1 to 3 words copied exactly, in order, from that sentence, the ones that carry its meaning.",
  ].join("\n");

const SYSTEM_ONE = "You rate one sentence from a short video as an on-screen headline, and pick its keyword.";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headlines"],
  properties: { headlines: { type: "array", items: { type: "object", additionalProperties: false, required: ["sentence", "keyword"], properties: { sentence: { type: "integer" }, keyword: { type: "string" } } } } },
};

/**
 * The headlines for `words`, by `planner` (Settings › AI: openai, claude, or apple on this Mac). Apple's small model
 * scores one sentence at a time and the best are kept, in order; the others pick from them all at once.
 */
export async function planHeadlines(words: TimelineWord[], planner: string, key: () => Promise<string>, progress: (p: number) => void, meter?: Meter): Promise<HeadlineIdea[]> {
  const all = sentences(words);
  if (!all.length) return [];
  const seconds = words.at(-1)!.end - words[0]!.start;
  const count = Math.min(all.length, headlineCount(seconds));
  const idea = (s: TimelineWord[], keyword: string): HeadlineIdea | undefined => {
    const texts = s.map((w) => w.text);
    const k = keywordIn(texts, keyword);
    return k ? { from: s[0]!.start, to: s.at(-1)!.end, text: texts.join(" "), keyword: k } : undefined;
  };
  if (planner === "apple") {
    const scored: { i: number; score: number; idea: HeadlineIdea }[] = [];
    for (const [i, s] of all.entries()) {
      progress(i / all.length);
      let out: { score: number; keyword: string };
      try {
        out = await onDevice<{ score: number; keyword: string }>("headline", SYSTEM_ONE, s.map((w) => w.text).join(" "));
      } catch (e) {
        // A sentence the model declines is left out; the rest still count.
        if (/declined|refused/i.test((e as Error).message)) continue;
        throw e;
      }
      const h = idea(s, out.keyword ?? "");
      if (h) scored.push({ i, score: Number(out.score) || 0, idea: h });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .sort((a, b) => a.i - b.i)
      .map((s) => s.idea);
  }
  progress(0.1);
  const text = all.map((s, i) => `${i + 1}. ${s.map((w) => w.text).join(" ")}`).join("\n");
  const out = await author(planner, await key(), meter)<{ headlines: { sentence: number; keyword: string }[] }>("caption_headlines", SCHEMA, SYSTEM(count), text, [], "low");
  const seen = new Set<number>();
  return (out.headlines ?? [])
    .filter((h) => Number.isInteger(h.sentence) && h.sentence >= 1 && h.sentence <= all.length && !seen.has(h.sentence) && seen.add(h.sentence))
    .sort((a, b) => a.sentence - b.sentence)
    .flatMap((h) => idea(all[h.sentence - 1]!, h.keyword) ?? []);
}
