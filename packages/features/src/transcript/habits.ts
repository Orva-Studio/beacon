import type { Decision, Format } from "@beacon/model";

/**
 * The user's habits in Remove Silences, Filler Words and Retakes, read from their decisions as simple counts per rule
 * (PLAN Phase 12): a habit needs at least `MIN_DECISIONS` over `MIN_PROJECTS` projects, about `AGREE` of them one way
 * once a Beta(1, 1) prior is added (so one or two choices never tip it), recent ones counting more. Each format has its
 * own; one with too few decisions yet falls back to every format's.
 */
const MIN_DECISIONS = 5;
const MIN_PROJECTS = 2;
const AGREE = 0.8;
const HALF_LIFE_DAYS = 90;

/** A habit and why: shown where a review uses it, and to agents. */
export interface Habit<T> {
  value: T;
  /** Decisions agreeing, of all of them, by count (not weight). */
  agree: number;
  of: number;
  /** "short" or "long" when learned from that format alone; undefined from every format. */
  format?: Format;
}

const FORMAT_NAME: Record<Format, string> = { short: "Shorts", long: "long videos" };

/** "in Shorts" or "": where a habit was learned. */
export const where = (h: Habit<unknown>) => (h.format ? ` in ${FORMAT_NAME[h.format]}` : "");

const weight = (d: Decision, now: number) => 0.5 ** ((now - d.at) / (HALF_LIFE_DAYS * 86_400_000));

const enough = (ds: Decision[]) => ds.length >= MIN_DECISIONS && new Set(ds.map((d) => d.project)).size >= MIN_PROJECTS;

/** The decisions to learn from: the format's own when there are enough, else every format's. */
function scoped(all: Decision[], format: Format, keep: (d: Decision) => boolean): { ds: Decision[]; format?: Format } | undefined {
  const own = all.filter((d) => keep(d) && d.format === format);
  if (enough(own)) return { ds: own, format };
  const every = all.filter(keep);
  return enough(every) ? { ds: every } : undefined;
}

/** The choice most of `ds` made, when it is `AGREE` of their weight with the prior. */
function usual(ds: Decision[], now: number): { choice: string; agree: number } | undefined {
  const by = new Map<string, number>();
  let total = 0;
  for (const d of ds) {
    const w = weight(d, now);
    by.set(d.choice, (by.get(d.choice) ?? 0) + w);
    total += w;
  }
  const [choice, w] = [...by].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (choice === undefined || (w! + 1) / (total + 2) < AGREE) return undefined;
  return { choice, agree: ds.filter((d) => d.choice === choice).length };
}

/** "um", "uhh", "Umm," all count as "um": a filler's rule. */
export function fillerRule(text: string): string {
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  const word = /^u+h*m+$/.test(t) ? "um" : /^u+h+$/.test(t) ? "uh" : /^e+r+m+$/.test(t) ? "erm" : /^e+r+$/.test(t) ? "er" : /^h+m+$/.test(t) ? "hmm" : /^m+$/.test(t) ? "mm" : /^a+h+m+$/.test(t) ? "ahm" : t;
  return `filler:${word}`;
}

/** Fillers the user usually keeps (Remove Filler Words cuts every filler otherwise), by their rule's word. */
export function keptFillers(all: Decision[], format: Format, now = Date.now()): Map<string, Habit<"keep">> {
  const out = new Map<string, Habit<"keep">>();
  for (const rule of new Set(all.filter((d) => d.rule.startsWith("filler:")).map((d) => d.rule))) {
    const s = scoped(all, format, (d) => d.rule === rule);
    const u = s && usual(s.ds, now);
    if (s && u?.choice === "keep") out.set(rule.slice(7), { value: "keep", agree: u.agree, of: s.ds.length, ...(s.format ? { format: s.format } : {}) });
  }
  return out;
}

/**
 * The shortest silence the user cuts: where their kept and cut silences divide by length (the length that the fewest
 * of them, by weight, fall on the wrong side of), when about `AGREE` of them agree with it. Only cuts, or only keeps,
 * say nothing of where.
 */
export function silenceMin(all: Decision[], format: Format, now = Date.now()): Habit<number> | undefined {
  const s = scoped(all, format, (d) => d.rule === "silence" && d.value !== undefined);
  if (!s || !s.ds.some((d) => d.choice === "keep") || !s.ds.some((d) => d.choice === "cut")) return undefined;
  const lengths = [...new Set(s.ds.map((d) => d.value!))].sort((a, b) => a - b);
  const total = s.ds.reduce((n, d) => n + weight(d, now), 0);
  let best: { at: number; wrong: number } | undefined;
  for (const [i, v] of lengths.entries()) {
    // Between this length and the next: silences up to it are kept, longer ones cut.
    const at = i + 1 < lengths.length ? (v + lengths[i + 1]!) / 2 : v;
    const wrong = s.ds.reduce((n, d) => n + ((d.choice === "keep") === d.value! > at ? weight(d, now) : 0), 0);
    if (!best || wrong < best.wrong) best = { at, wrong };
  }
  // Below the shortest: every silence cut.
  const none = s.ds.reduce((n, d) => n + (d.choice === "keep" ? weight(d, now) : 0), 0);
  if (none < best!.wrong) best = { at: lengths[0]! - 0.05, wrong: none };
  if ((total - best!.wrong + 1) / (total + 2) < AGREE) return undefined;
  // In tenths, as the review's slider moves.
  const at = Math.round(Math.min(5, Math.max(0.2, best!.at)) * 10) / 10;
  const agree = s.ds.filter((d) => (d.choice === "cut") === d.value! > at).length;
  return { value: at, agree, of: s.ds.length, ...(s.format ? { format: s.format } : {}) };
}

/** Which take of a line the user usually keeps: the first or the last said, when they mostly keep one. */
export function retakeTake(all: Decision[], format: Format, now = Date.now()): Habit<"first" | "last"> | undefined {
  const s = scoped(all, format, (d) => d.rule === "retake");
  const u = s && usual(s.ds, now);
  if (!u || (u.choice !== "first" && u.choice !== "last")) return undefined;
  return { value: u.choice, agree: u.agree, of: s!.ds.length, ...(s!.format ? { format: s!.format } : {}) };
}
