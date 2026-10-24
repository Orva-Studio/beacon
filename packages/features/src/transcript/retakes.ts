/** A word with its times, in whatever seconds the caller uses (timeline or source). */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** How close two runs of words must be to count as takes of one line. */
export interface RetakeOptions {
  /** Words in a row that must repeat at the start of a take. */
  minWords: number;
  /** Seconds between the starts of two takes, at most. */
  within: number;
}

export const RETAKE_DEFAULTS: RetakeOptions = { minWords: 3, within: 30 };

/** One take, as indices into the words (inclusive). The last take of a group ends where it stops repeating the one before. */
export interface Take {
  first: number;
  last: number;
}

/**
 * Hesitation sounds as transcribers write them ("Um...", "uh,", "Hmmm", "Er"), not words that can be meant ("ah",
 * "oh": "Ah crap") nor "mm-hmm"/"uh-huh", which answer something.
 */
const FILLER = /^(u+h*m+|u+h+|e+r+m*|h+m+|m{2,}|a+h+m+)$/;
export const isFiller = (text: string) => FILLER.test(text.toLowerCase().replace(/[^a-z-]/g, ""));

const token = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A take's words as compared: lower case, no punctuation or fillers. Judgments are matched to takes by it. */
export const takeKey = (words: Word[], take: Take) =>
  words
    .slice(take.first, take.last + 1)
    .filter((w) => !isFiller(w.text))
    .map((w) => token(w.text))
    .filter(Boolean)
    .join(" ");

export const takeText = (words: Word[], take: Take) =>
  words
    .slice(take.first, take.last + 1)
    .map((w) => w.text)
    .join(" ");

/**
 * The longest common subsequence of `a` and `b`: its length, and the index in `b` of its last word, as early as
 * it can be ("click on save" in "click on save then save" ends at the first "save", not the second).
 */
function common(a: string[], b: string[]): { n: number; last: number } {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let x = 1; x <= a.length; x++) for (let y = 1; y <= b.length; y++) dp[x]![y] = a[x - 1] === b[y - 1] ? dp[x - 1]![y - 1]! + 1 : Math.max(dp[x - 1]![y]!, dp[x]![y - 1]!);
  const n = dp[a.length]![b.length]!;
  return { n, last: n ? dp[a.length]!.findIndex((v) => v === n) - 1 : -1 };
}

/** A take this much of whose words the next take says again (in order) is one take of the same line. */
const COVERAGE = 0.7;
/** Words in a take, at most: a longer stretch said again is a section redone, not a line. */
const MAX_TAKE = 60;

/**
 * Lines said more than once ("so the next step is… so the next step is to open"): a take restarts the one before
 * when its first `minWords` words repeat that take's first words (or all but one of a word more, the first two
 * kept) within `within` seconds, and it says at least 70% of that take's words again in order. Each take runs up
 * to the next restart (the fillers between them too); the last ends at the last word it repeats, so what it goes on to say isn't part of the group.
 * Fillers are left out of the comparison.
 */
export function findRetakes(words: Word[], o: RetakeOptions): Take[][] {
  const tok = words.flatMap((w, i) => (isFiller(w.text) || !token(w.text) ? [] : [{ i, t: token(w.text), start: w.start }]));
  const t = tok.map((x) => x.t);
  const m = o.minWords;
  const restarts = (i: number, j: number) => {
    let miss = 0;
    for (let k = 0; k < m; k++) if (t[i + k] !== t[j + k]) miss++;
    if (!miss) return true;
    // One word changed: only once the line has begun the same, and only with a word more to make up for it.
    if (m < 3 || j - i < m + 1 || t[i] !== t[j] || t[i + 1] !== t[j + 1]) return false;
    return miss + (t[i + m] === t[j + m] ? 0 : 1) <= 1;
  };
  const groups: { starts: number[]; end: number }[] = [];
  for (let j = 1; j < t.length; j++) {
    const g = groups.at(-1);
    const lastStart = g?.starts.at(-1) ?? -1;
    for (let i = j - m; i >= 0 && tok[j]!.start - tok[i]!.start <= o.within && j - i <= MAX_TAKE; i--) {
      if (g && i < lastStart) break;
      // Only the last take of the group before can be restarted; otherwise a new group starts after it.
      if (g && i !== lastStart && i <= g.end) continue;
      if (!restarts(i, j)) continue;
      const said = common(t.slice(i, j), t.slice(j, j + (j - i) + 2));
      if (said.n / (j - i) < COVERAGE) continue;
      if (g && i === lastStart) {
        g.starts.push(j);
        g.end = j + said.last;
      } else groups.push({ starts: [i, j], end: j + said.last });
      break;
    }
  }
  return groups.map((g) => g.starts.map((s, k) => ({ first: tok[s]!.i, last: k + 1 < g.starts.length ? tok[g.starts[k + 1]!]!.i - 1 : tok[g.end]!.i })));
}

/** Long enough between two words of one take to be a stumble. */
const HESITATION = 1;

/** What counts against a take: fillers, a word said twice in a row, a long pause mid-line, a word cut off ("mission--"). */
export function takeProblems(words: Word[], take: Take): number {
  let n = 0;
  const said = words.slice(take.first, take.last + 1);
  for (const [k, w] of said.entries()) {
    if (isFiller(w.text)) n++;
    else if (/(-|—|–)$/.test(w.text.trim())) n++;
    const prev = said.slice(0, k).findLast((x) => !isFiller(x.text));
    if (prev && token(prev.text) && token(prev.text) === token(w.text)) n++;
    if (k && w.start - said[k - 1]!.end > HESITATION) n++;
  }
  return n;
}

/** A take before the last says the whole line: it ends a sentence and is about as long as the take after it repeats. */
export function takeComplete(words: Word[], takes: Take[], k: number): boolean {
  if (k === takes.length - 1) return true;
  const said = (take: Take) => takeKey(words, take).split(" ").filter(Boolean).length;
  const end = words.slice(takes[k]!.first, takes[k]!.last + 1).findLast((w) => !isFiller(w.text));
  return !!end && /[.!?]["')\]]*$/.test(end.text.trim()) && !/\.\.\.$|…$/.test(end.text.trim()) && said(takes[k]!) >= 0.8 * said(takes[k + 1]!);
}

/** Fewer problems than the last take by this many makes an earlier complete take the better one. */
const NOTICEABLY = 2;

/**
 * The take to keep: the last (people redo a line until it is right), unless an earlier complete take has
 * noticeably fewer problems, in which case the latest of those with the fewest.
 */
export function bestTake(words: Word[], takes: Take[]): number {
  const problems = takes.map((t) => takeProblems(words, t));
  const last = takes.length - 1;
  let best = last;
  for (let k = 0; k < last; k++) {
    if (takeComplete(words, takes, k) && problems[k]! <= problems[last]! - NOTICEABLY && problems[k]! <= problems[best]!) best = k;
  }
  return best;
}

/**
 * The words cut to keep take `keep` of a group, as inclusive index ranges: every take before it whole, and of
 * those after it only what repeats the line, so what the last one goes on to say follows the kept take.
 */
export function retakeCuts(takes: Take[], keep: number): [number, number][] {
  const out: [number, number][] = [];
  if (keep > 0) out.push([takes[0]!.first, takes[keep]!.first - 1]);
  if (keep < takes.length - 1) out.push([takes[keep + 1]!.first, takes.at(-1)!.last]);
  return out;
}

/** What OpenAI decided for one group: the take to keep (from 0) and why, matched later by the takes' words. */
export interface Judgment {
  takes: string[];
  best: number;
  reason: string;
}

/** The model judging takes; small and cheap, as each request is a few short lines. */
const JUDGE_MODEL = "gpt-5-mini";
const BATCH = 25;

/**
 * Asks OpenAI's API, with the user's key, which take of each group to keep. `groups` are each group's takes as
 * said (fillers kept) and a few words that follow, for whether a take leads on.
 */
export async function judgeTakes(groups: { takes: string[]; then: string }[], apiKey: string, progress: (f: number) => void, signal?: AbortSignal): Promise<{ best: number; reason: string }[]> {
  const out: { best: number; reason: string }[] = [];
  for (let at = 0; at < groups.length; at += BATCH) {
    signal?.throwIfAborted();
    const batch = groups.slice(at, at + BATCH);
    const listing = batch.map((g, n) => [`Group ${n + 1}:`, ...g.takes.map((t, k) => `  Take ${k + 1}: ${t}`), ...(g.then ? [`  (then: ${g.then})`] : [])].join("\n")).join("\n\n");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        reasoning_effort: "medium",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You help edit a recorded narration (a screen recording or talking head). Each group lists takes of one line: the speaker said it more than once, restarting or redoing it. For each group pick the one take to keep in the edit: the one that says the whole line, fluently, without stumbles, fillers, self-corrections or a word cut off. When takes are about as good, prefer the later one (speakers redo a line until it is right). Reply with JSON only: {\"picks\": [{\"group\": 1, \"best\": 2, \"reason\": \"says it fully, no stumble\"}]}, `best` the take's number, `reason` under 10 words.",
          },
          { role: "user", content: listing },
        ],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = (() => {
        try {
          return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
        } catch {
          return undefined;
        }
      })();
      throw new Error(`OpenAI couldn't judge the takes (${res.status}${message ? `: ${message}` : ""})`);
    }
    const reply = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let picks: { group?: number; best?: number; reason?: string }[] = [];
    try {
      picks = (JSON.parse(reply.choices?.[0]?.message?.content ?? "{}") as { picks?: typeof picks }).picks ?? [];
    } catch {
      throw new Error("OpenAI's answer about the takes wasn't JSON");
    }
    for (const [n, g] of batch.entries()) {
      const p = picks.find((x) => x.group === n + 1);
      const best = p && Number.isInteger(p.best) && p.best! >= 1 && p.best! <= g.takes.length ? p.best! - 1 : -1;
      out.push({ best, reason: best < 0 ? "" : String(p?.reason ?? "").slice(0, 120) });
    }
    progress(Math.min(1, (at + batch.length) / groups.length));
  }
  return out;
}
