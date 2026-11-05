import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipEnd, projectDuration, ticksToSeconds, type ActionContext, type ActionPlan, type ActionStep, type Asset, type FeatureRegistry, type Project, type TaskEnv } from "@beacon/model";
import { jobSignal, runTool, tool } from "@beacon/media";
import { mediaInfo } from "../media";
import { speechSpans, timelineWords } from "../transcript";
import { PLAN_MODEL } from "../broll/plan";
import { download, downloadEdit, searchEffects, searchMusic } from "./epidemic";
import { POP_TERMS, type PopKind } from "./pops";
import { duckPoints, EDIT_MAX, FADE, freePath, keyOf, libraryOf, MUSIC_DEFAULTS, type LibraryInfo } from "./shared";

/** A track or sound found for a suggestion, with its preview to listen to. */
export interface SuggestOption {
  id: string;
  title: string;
  ms: number;
  preview: string;
  vocals?: boolean;
}

/** Music under a part of the video (a section, or neighbouring sections of one mood), timeline seconds. */
export interface SuggestedTrack {
  from: number;
  to: number;
  name: string;
  mood: string;
  term: string;
  options: SuggestOption[];
  /** Which of `options` goes in. */
  chosen: number;
  off: boolean;
}

/** A section starting, a moment in the talk, or something coming onto the picture (Pop-ins). */
export type SoundKind = "section" | "moment" | PopKind;

export interface SuggestedSound {
  time: number;
  kind: SoundKind;
  why: string;
  term: string;
  options: SuggestOption[];
  chosen: number;
  off: boolean;
}

/** What Suggest found: the video's kind, its music part by part, and its sounds. */
export interface Suggestion {
  kind: string;
  tracks: SuggestedTrack[];
  sounds: SuggestedSound[];
}

/** Tracks overlap this long where one part's music gives way to the next's. */
export const CROSSFADE = 1;
/** Key moments at least this far apart, and from any other sound. */
const MOMENT_GAP = 30;
const NEAR = 2;
/** The on-device model reads a stretch this long at a time for its moment. */
const CHUNK = 45;
const SECTION_SOUND = "soft whoosh transition";

interface Part {
  from: number;
  to: number;
  name: string;
}

/** The video's parts: its sections, each running on to the next (the first from the start), or the whole video. */
export function partsOf(project: Project): Part[] {
  const end = ticksToSeconds(projectDuration(project));
  const sections = [...project.sections].sort((a, b) => a.start - b.start).filter((s) => ticksToSeconds(s.start) < end);
  if (!sections.length) return end > 0 ? [{ from: 0, to: end, name: "The video" }] : [];
  return sections.map((s, i) => ({ from: i === 0 ? 0 : ticksToSeconds(s.start), to: i + 1 < sections.length ? ticksToSeconds(sections[i + 1]!.start) : end, name: s.name }));
}

/** Neighbouring parts of the same mood as one, keeping the first's search. */
export function mergeMoods<T extends Part & { mood: string }>(parts: T[]): T[] {
  const out: T[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && last.mood === p.mood) out[out.length - 1] = { ...last, to: p.to, name: `${last.name} – ${p.name}` };
    else out.push(p);
  }
  return out;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Where a quote is said in [from, to]: the start of its last word (where a reveal lands), or undefined if it isn't. */
export function locate(words: { text: string; start: number }[], quote: string, from: number, to: number): number | undefined {
  const q = quote.split(/\s+/).map(norm).filter(Boolean);
  const ws = words.filter((w) => w.start >= from - 1e-6 && w.start < to);
  const said = ws.map((w) => norm(w.text));
  if (!q.length) return undefined;
  for (let i = 0; i + q.length <= said.length; i++) if (q.every((t, k) => said[i + k] === t)) return ws[i + q.length - 1]!.start;
  // Numbers written another way ("35" against "thirty-five"): its longest word, found alone.
  const longest = [...q].sort((a, b) => b.length - a.length)[0]!;
  const at = longest.length >= 4 ? said.indexOf(longest) : -1;
  return at >= 0 ? ws[at]!.start : undefined;
}

/** The best moments, MOMENT_GAP apart and clear of the other sounds by NEAR. */
export function pickMoments<T extends { time: number; score: number }>(found: T[], others: number[]): T[] {
  const kept: T[] = [];
  for (const m of [...found].sort((a, b) => b.score - a.score)) {
    if (m.score < 7) break;
    if (others.some((t) => Math.abs(t - m.time) < NEAR) || kept.some((k) => Math.abs(k.time - m.time) < MOMENT_GAP)) continue;
    kept.push(m);
  }
  return kept.sort((a, b) => a.time - b.time);
}

interface Reading {
  kind: string;
  parts: { mood: string; term: string }[];
  moments: { words: string; sound: string; why: string; score: number; from: number; to: number }[];
}

type Words = { text: string; start: number; end: number }[];
const said = (words: Words, from: number, to: number, most = 400) =>
  words
    .filter((w) => w.start >= from - 1e-6 && w.start < to)
    .slice(0, most)
    .map((w) => w.text)
    .join(" ");

const writer = () => process.env.BEACON_WRITER ?? tool("beacon-writer");

/** Apple's on-device model, one part (its music) and one stretch (its moment) at a time: it has a small window. */
async function readOnDevice(parts: Part[], words: Words, say: (n: number, of: number) => void): Promise<Reading> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-suggest-"));
  const chunks = parts.flatMap((p) => {
    const n = Math.max(1, Math.round((p.to - p.from) / CHUNK));
    return Array.from({ length: n }, (_, k) => ({ from: p.from + ((p.to - p.from) * k) / n, to: p.from + ((p.to - p.from) * (k + 1)) / n }));
  });
  const total = parts.length + chunks.length;
  let n = 0;
  const ask = async <T>(kind: string, instructions: string, prompt: string): Promise<T> => {
    say(++n, total);
    const request = join(dir, `${n}.json`);
    writeFileSync(request, JSON.stringify({ instructions, prompt, kind }));
    try {
      return JSON.parse(await runTool([writer(), request])) as T;
    } catch (e) {
      jobSignal()?.throwIfAborted();
      throw new Error((e as Error).message.replace(/^.*? exited with \d+: /, ""));
    }
  };
  try {
    const kinds: string[] = [];
    const read: Reading["parts"] = [];
    for (const p of parts) {
      const m = await ask<{ kind: string; mood: string; term: string }>("mood", "You choose background music for one part of a video, under the speaker's voice, from what is said in it.", `Part "${p.name}". Said: ${said(words, p.from, p.to) || "(nothing)"}`);
      kinds.push(m.kind);
      read.push({ mood: m.mood, term: m.term });
    }
    const moments: Reading["moments"] = [];
    for (const c of chunks) {
      const text = said(words, c.from, c.to);
      if (text.split(" ").length < 8) {
        n++;
        continue;
      }
      const m = await ask<{ words: string; sound: string; why: string; score: number }>("moment", "You find the one moment in a stretch of talk that a short sound effect would lift, if there is one.", text);
      moments.push({ ...m, from: c.from, to: c.to });
    }
    const counts = new Map<string, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    return { kind: [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "", parts: read, moments };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "parts", "moments"],
  properties: {
    kind: { type: "string", description: "What kind of video it is: tutorial, explainer, review, story, interview, promo, vlog or talk" },
    parts: {
      type: "array",
      description: "One per part, in order",
      items: { type: "object", additionalProperties: false, required: ["mood", "term"], properties: { mood: { type: "string" }, term: { type: "string" } } },
    },
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["words", "sound", "why", "score"],
        properties: { words: { type: "string" }, sound: { type: "string" }, why: { type: "string" }, score: { type: "integer" } },
      },
    },
  },
};

/** OpenAI reads the whole talk at once (B-roll's planner model, on the user's key). */
async function readWithOpenAI(parts: Part[], words: Words, apiKey: string): Promise<Reading> {
  const system = [
    "You choose background music and sound effects for a talking-head or screen-recording video, from its transcript.",
    "For each part, in order: its music's mood in one word (calm, hopeful, uplifting, playful, curious, focused, dramatic, mysterious, energetic, warm, serious, triumphant) and a music library search of 2 to 6 words (genre, instruments, energy; never the topic). Music sits under the voice: prefer instrumental, steady tracks.",
    "Moments: a few places a short sound effect lifts the talk (a figure revealed, a punchline, a surprise, a before and after), at most one every 30 seconds, none for steady explaining. Each: 2 to 6 words copied exactly from the transcript, a sound effect search of 1 to 3 words (ding, riser, impact, cash register, record scratch, swoosh), why in under 10 words, and a score 0 to 10.",
  ].join("\n");
  const user = parts.map((p, i) => `Part ${i + 1}, "${p.name}":\n${said(words, p.from, p.to, 4000)}`).join("\n\n");
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(jobSignal() ? [jobSignal()!] : [])]);
  const res = await fetch(`${api()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: PLAN_MODEL, reasoning: { effort: "medium" }, input: [{ role: "system", content: system }, { role: "user", content: user }], text: { format: { type: "json_schema", name: "music_plan", strict: true, schema: SCHEMA } } }),
    signal,
  }).catch((e) => {
    jobSignal()?.throwIfAborted();
    throw (e as Error).name === "TimeoutError" ? new Error("OpenAI didn't answer within 3 minutes: try again") : e;
  });
  if (res.status === 401) throw new Error("OpenAI refused the API key: check it in Settings › AI");
  if (!res.ok) throw new Error(`OpenAI couldn't read the talk (${res.status})`);
  const reply = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text = reply.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : [])).find((c) => c.type === "output_text")?.text;
  let out: { kind?: string; parts?: { mood: string; term: string }[]; moments?: { words: string; sound: string; why: string; score: number }[] };
  try {
    out = JSON.parse(text ?? "");
  } catch {
    throw new Error("OpenAI's answer wasn't JSON");
  }
  const read = parts.map((_, i) => out.parts?.[i] ?? out.parts?.at(-1) ?? { mood: "calm", term: "soft ambient background" });
  return { kind: out.kind ?? "", parts: read, moments: (out.moments ?? []).map((m) => ({ ...m, from: 0, to: Infinity })) };
}

/**
 * Suggest's work: the talk read (by B-roll's planner: Apple's model on this Mac, or OpenAI), each part's music
 * searched on Epidemic Sound (three found, instrumental first), and a sound for each section change, key moment and
 * pop-in (three each). Nothing is downloaded.
 */
export async function suggest(project: Project, registry: FeatureRegistry, data: ActionContext["data"], env: Pick<TaskEnv, "progress" | "secret" | "pref">, pops: { time: number; kind: PopKind }[]): Promise<Suggestion> {
  const key = await keyOf(env.secret);
  const parts = partsOf(project);
  if (!parts.length) throw new Error("the timeline is empty");
  const words = timelineWords(project, registry, data);
  if (!words.length) throw new Error("nothing is said on the timeline yet: Suggest reads the transcript (wait for it, or add a recording)");
  const openai = env.pref("brollPlanner") === "openai";
  let reading: Reading;
  if (openai) {
    env.progress(0.05, "OpenAI is reading the talk");
    const k = await env.secret("openai-api-key");
    if (!k) throw new Error("no OpenAI API key: add one in Settings › AI, or choose Apple as the B-roll planner");
    reading = await readWithOpenAI(parts, words, k);
  } else reading = await readOnDevice(parts, words, (n, of) => env.progress((0.6 * (n - 1)) / of, `Apple's on-device model is reading the talk (${n} of ${of})`));

  const tracks = mergeMoods(parts.map((p, i) => ({ ...p, ...reading.parts[i]! })));
  const allSections = parts.slice(1).map((p) => p.from);
  const placed = [...allSections, ...pops.map((p) => p.time)];
  const moments = pickMoments(
    reading.moments.flatMap((m) => {
      const time = locate(words, m.words, m.from, m.to);
      return time === undefined ? [] : [{ ...m, time }];
    }),
    placed,
  );

  const musicFound = new Map<string, SuggestOption[]>();
  const sfxFound = new Map<string, SuggestOption[]>();
  const terms = [...new Set([...allSections.map(() => SECTION_SOUND), ...moments.map((m) => m.sound), ...pops.map((p) => POP_TERMS[p.kind])])];
  const steps = tracks.length + terms.length;
  let done = 0;
  const step = (what: string) => env.progress(0.6 + (0.4 * done++) / steps, what);
  for (const t of tracks) {
    step(`Searching Epidemic Sound for “${t.term}”`);
    const q = `${t.mood} ${t.term}`;
    if (musicFound.has(q)) continue;
    let items = (await searchMusic(key, { term: q, first: 12 })).items;
    if (!items.length) items = (await searchMusic(key, { term: t.term, first: 12 })).items;
    musicFound.set(q, [...items.filter((x) => !x.vocals), ...items.filter((x) => x.vocals)].slice(0, 3).map((x) => ({ id: x.id, title: x.title, ms: x.ms, preview: x.preview, ...(x.vocals ? { vocals: true } : {}) })));
  }
  for (const term of terms) {
    step(`Searching Epidemic Sound for “${term}”`);
    sfxFound.set(term, (await searchEffects(key, { term, first: 3 })).items.map((x) => ({ id: x.id, title: x.title, ms: x.ms, preview: x.preview })));
  }
  const sound = (time: number, kind: SoundKind, term: string, why: string): SuggestedSound => ({ time, kind, why, term, options: sfxFound.get(term) ?? [], chosen: 0, off: !(sfxFound.get(term) ?? []).length });
  const sounds = [
    ...allSections.map((t, i) => sound(t, "section", SECTION_SOUND, `${parts[i + 1]!.name} starts`)),
    ...moments.map((m) => sound(m.time, "moment", m.sound, m.why)),
    ...pops.map((p) => sound(p.time, p.kind, POP_TERMS[p.kind], p.kind === "motion" ? "A motion graphic or B-roll comes on" : "A picture comes on")),
  ].sort((a, b) => a.time - b.time);
  return {
    kind: reading.kind,
    tracks: tracks.map((t) => {
      const options = musicFound.get(`${t.mood} ${t.term}`) ?? [];
      return { from: t.from, to: t.to, name: t.name, mood: t.mood, term: t.term, options, chosen: 0, off: !options.length };
    }),
    sounds,
  };
}

/** The version of a part's track Apply downloads: an edit its length (with the crossfade), else the full mix, cut and faded. */
const versionOf = (seconds: number) => (seconds <= EDIT_MAX ? `edit:${seconds.toFixed(2)}` : "full");

/** Lanes for clips on tracks named `name`, from those there are, another added where two would overlap. */
function lanes(project: Project, name: string) {
  const list: { ref: string | number; spans: [number, number][] }[] = project.tracks
    .filter((t) => t.name === name && !t.locked)
    .map((t) => ({ ref: t.id, spans: t.clips.map((c) => [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))] as [number, number]) }));
  return (span: [number, number], steps: ActionStep[], add: object) => {
    let lane = list.find((l) => l.spans.every(([a, b]) => b <= span[0] + 1e-6 || a >= span[1] - 1e-6));
    if (!lane) {
      steps.push({ command: "track.add", args: { name, ...add } });
      lane = { ref: steps.length - 1, spans: [] };
      list.push(lane);
    }
    lane.spans.push(span);
    return lane.ref;
  };
}

/**
 * Apply for Suggest: the chosen tracks (each over its part, one second into the next to cross fade, ducked under
 * speech) and sounds, those not in the project downloaded first on the user's Epidemic Sound account, then all placed
 * in one undo step.
 */
export function applySuggestion(s: Suggestion, ctx: ActionContext): ActionPlan {
  const tracks = s.tracks.filter((t) => !t.off && t.options[t.chosen]);
  const sounds = s.sounds.filter((x) => !x.off && x.options[x.chosen]);
  if (!tracks.length && !sounds.length) throw new Error("nothing is ticked: tick a track or a sound");
  const end = ticksToSeconds(projectDuration(ctx.project));
  const music = tracks.map((t, i) => {
    const next = tracks[i + 1];
    const stop = next && Math.abs(next.from - t.to) < 1e-3 ? Math.min(end, t.to + CROSSFADE) : t.to;
    return { t, pick: t.options[t.chosen]!, from: t.from, to: stop, fadeIn: i > 0 && Math.abs(tracks[i - 1]!.to - t.from) < 1e-3, version: versionOf(stop - t.from) };
  });
  const have = (id: string, version: string, project: Project) => Object.values(project.assets).find((x) => libraryOf(x)?.id === id && libraryOf(x)?.version === version);
  const label = "Add Suggested Music and Sounds";
  const place = (added: Map<string, Omit<Asset, "id">>) => (ctx2: ActionContext): ActionPlan => {
    const steps: ActionStep[] = [];
    const refs = new Map<string, string | number>();
    for (const [k, a] of added) {
      steps.push({ command: "asset.add", args: a });
      refs.set(k, steps.length - 1);
    }
    const ref = (id: string, version: string) => refs.get(`${id}|${version}`) ?? have(id, version, ctx2.project)!.id;
    const lengthOf = (id: string, version: string) => mediaInfo((added.get(`${id}|${version}`) ?? have(id, version, ctx2.project)!) as Asset).duration;
    const speech = speechSpans(ctx2.project, ctx2.registry, ctx2.data);
    const musicLane = lanes(ctx2.project, "Music");
    const sfxLane = lanes(ctx2.project, "SFX");
    const placed: number[] = [];
    const placeAt = (asset: string | number, time: number, track: string | number) => {
      steps.push({ command: "asset.place", args: (r: unknown[]) => ({ asset: typeof asset === "number" ? r[asset] : asset, time, track: typeof track === "number" ? r[track] : track }) });
      placed.push(steps.length - 1);
      const at = steps.length - 1;
      return (r: unknown[]) => (r[at] as string[])[0]!;
    };
    for (const m of music) {
      const stop = Math.min(m.to, m.from + lengthOf(m.pick.id, m.version));
      const clip = placeAt(ref(m.pick.id, m.version), m.from, musicLane([m.from, stop], steps, { index: 0 }));
      const cut = m.from + lengthOf(m.pick.id, m.version) > m.to + 1e-3;
      if (cut) steps.push({ command: "clip.trim", args: (r: unknown[]) => ({ clip: clip(r), end: m.to }) });
      let points = duckPoints(m.from, stop, speech, { ...MUSIC_DEFAULTS, duck: true, fade: cut || stop > m.t.to + 1e-3 });
      if (m.fadeIn) {
        const level = points.find((p) => p.time >= m.from + FADE)?.value ?? points.at(-1)!.value;
        points = [{ time: m.from, value: 0 }, { time: m.from + FADE, value: level }, ...points.filter((p) => p.time > m.from + FADE + 1e-6)];
      }
      steps.push({ command: "volume.setPoints", args: (r: unknown[]) => ({ clip: clip(r), points }) });
    }
    for (const x of sounds) {
      const pick = x.options[x.chosen]!;
      placeAt(ref(pick.id, "full"), x.time, sfxLane([x.time, x.time + lengthOf(pick.id, "full")], steps, {}));
    }
    return { label, steps, after: (r) => [{ command: "selection.set", args: { clips: placed.map((i) => (r[i] as string[])[0]!), linked: false } }] };
  };
  const wanted = new Map<string, { kind: "music" | "sfx"; id: string; title: string; version: string; seconds: number }>();
  for (const m of music) wanted.set(`${m.pick.id}|${m.version}`, { kind: "music", id: m.pick.id, title: m.pick.title, version: m.version, seconds: m.to - m.from });
  for (const x of sounds) {
    const p = x.options[x.chosen]!;
    wanted.set(`${p.id}|full`, { kind: "sfx", id: p.id, title: p.title, version: "full", seconds: 0 });
  }
  const missing = [...wanted].filter(([, w]) => !have(w.id, w.version, ctx.project));
  if (!missing.length) return place(new Map())(ctx);
  return {
    label,
    task: {
      label: `Download ${missing.length === 1 ? `“${missing[0]![1].title}”` : `${missing.length} tracks and sounds`} from Epidemic Sound`,
      run: async (env) => {
        const key = await keyOf(env.secret);
        const added = new Map<string, Omit<Asset, "id">>();
        const made: string[] = [];
        try {
          for (const [i, [k, w]] of missing.entries()) {
            const say = `${w.kind === "music" && w.version !== "full" ? "Fitting and downloading" : "Downloading"} ${i + 1} of ${missing.length}`;
            env.progress(i / missing.length, say);
            const path = freePath(env.mediaDir, w.title, w.kind === "sfx" ? ".wav" : ".mp3");
            made.push(path);
            if (w.kind === "music" && w.version !== "full") await downloadEdit(key, w.id, w.seconds, path, (f) => env.progress((i + f) / missing.length, say));
            else await download(key, w.kind, w.id, path);
            const probed = await env.asset(path, "audio");
            const library: LibraryInfo = { source: "epidemic", kind: w.kind, id: w.id, title: w.title, version: w.version };
            added.set(k, { ...probed, name: w.title, derived: { ...probed.derived, library } });
          }
        } catch (e) {
          for (const path of made) rmSync(path, { force: true });
          throw e;
        }
        env.progress(1, "On the Music and SFX tracks; the files are in the project's media folder");
        return place(added);
      },
    },
  };
}
