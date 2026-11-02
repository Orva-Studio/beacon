import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { roundSeconds } from "@beacon/model";
import { decodeAudio, jobSignal, runTool, tool } from "./tool";

export interface Word {
  text: string;
  /** Media seconds. */
  start: number;
  end: number;
  /** Mean token probability, 0–1. */
  p: number;
}

export interface Transcription {
  model: string;
  language: string;
  words: Word[];
  /** Media seconds where the audio is above the silence threshold; pauses are the gaps. */
  speech: [number, number][];
}

/**
 * Who turns speech into timed words: Whisper on this Mac (whisper.cpp, the downloaded model), Apple's
 * on-device SpeechTranscriber (macOS 26, no download), or Whisper through OpenAI's API (the audio is uploaded).
 */
export type Transcriber = "whisper" | "apple" | "openai";

export interface TranscribeOptions {
  /** Index among the file's audio streams. */
  stream?: number;
  transcriber?: Transcriber;
  /** OpenAI's API key, for `openai`. */
  apiKey?: string;
  /** Whisper's model file, for `whisper`. */
  model?: string;
  /** whisper.cpp's alignment-heads preset for the model (`--dtw`). */
  dtw?: string;
  language?: string;
  onProgress?: (fraction: number) => void;
}

export const DEFAULT_WHISPER_MODEL = join(homedir(), "Library/Caches/Beacon/models/ggml-large-v3-turbo-q5_0.bin");

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  /** DTW-aligned time in centiseconds; whisper's own `offsets` drift across pauses. */
  t_dtw: number;
  p: number;
}

/** Speech detection: RMS over 20 ms windows; shorter sounds are clicks, shorter gaps are within words. */
const RATE = 16000;
const WINDOW = 320;
const MIN_SPEECH = 0.1;
const MIN_GAP = 0.15;
/** How far before a speech region an aligned word start may sit and still belong to it. */
const SNAP = 0.3;
const MIN_WORD = 0.05;
/**
 * Where to look for a quiet boundary around a word's start, before and after it: DTW starts (local Whisper)
 * lag the sound by up to a quarter second; Apple's and the API's are about right either way.
 */
const SEARCH: Record<Transcriber, [number, number]> = { whisper: [0.25, 0.03], apple: [0.15, 0.15], openai: [0.15, 0.15] };
/**
 * Chunking for whisper: split at pauses of this many seconds, keep chunks under its 30 s window.
 * Measured on demo_3: 0.5 s still let it skip a fourth take; splitting at every pause
 * made it invent words on very short chunks.
 */
const CHUNK_GAP = 0.3;
const MAX_CHUNK = 25;
const PAD = 0.2;
/**
 * A pause between words can sit above the silence threshold (breath, the room with someone in front of the mic):
 * this far below the recording's speech level, for at least `MIN_PAUSE`, between louder sound, is a pause too.
 * Measured on a take whose sentence ends sat at -54 dB, speech at -26 and the threshold at -56.
 */
const PAUSE_BELOW_SPEECH = 24;
const MIN_PAUSE = 0.2;
/**
 * A word longer than this (seconds, plus per letter) has another's sound in it: whisper dropped a repeat (it
 * dedupes takes said close together in one chunk), and the word before or the first after a pause took its
 * time. Its stretch is transcribed again on its own.
 */
const STRETCHED = [0.4, 0.08] as const;
const NEIGHBOUR = 0.1;


/** RMS level in dB of each `WINDOW` of samples. */
function levels(pcm: Int16Array): number[] {
  const db: number[] = [];
  for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
    let sum = 0;
    for (let j = i; j < i + WINDOW; j++) sum += pcm[j]! * pcm[j]!;
    db.push(10 * Math.log10(sum / WINDOW / 32768 ** 2 + 1e-12));
  }
  return db;
}

/**
 * Inside continuous speech there is no silence to cut in, so the start of
 * each word that follows another in the same speech region moves to the
 * quietest window near its start (`SEARCH`), where a cut is least audible. A word touching the one before shares the boundary.
 */
function quietBoundaries(words: Word[], speech: [number, number][], db: number[], [before, after]: [number, number], rate = RATE): Word[] {
  const step = WINDOW / rate;
  const region = (t: number) => speech.findIndex(([a, b]) => t >= a && t <= b);
  const out = words.map((w) => ({ ...w }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const next = out[i]!;
    if (region(prev.end) < 0 || region(prev.end) !== region(next.start)) continue;
    const touching = Math.abs(prev.end - next.start) < 1e-6;
    const from = Math.ceil(Math.max(touching ? prev.start + MIN_WORD : prev.end, next.start - before) / step);
    const to = Math.floor(Math.min(next.end - MIN_WORD, next.start + after) / step);
    let best = -1;
    for (let k = from; k <= to; k++) if (db[k] !== undefined && (best < 0 || db[k]! < db[best]!)) best = k;
    if (best < 0) continue;
    next.start = (best + 0.5) * step;
    if (touching) prev.end = next.start;
  }
  return out;
}

/**
 * Where someone is speaking in 16 kHz mono PCM. The threshold sits between
 * the recording's noise floor and its speech level (10th and 90th
 * percentile window levels), so it adapts to the mic and gain.
 */
function speechRegions(pcm: Int16Array, rate = RATE): [number, number][] {
  const db = levels(pcm);
  const sorted = [...db].sort((x, y) => x - y);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.max(floor + 10, Math.min(floor + 18, loud - 20));
  const step = WINDOW / rate;
  const raw: [number, number][] = [];
  for (const [i, v] of db.entries()) {
    if (v < threshold) continue;
    const last = raw.at(-1);
    if (last && i * step - last[1] < MIN_GAP) last[1] = (i + 1) * step;
    else raw.push([i * step, (i + 1) * step]);
  }
  const quiet = loud - PAUSE_BELOW_SPEECH;
  return raw.filter(([x, y]) => y - x >= MIN_SPEECH).flatMap((r) => (quiet > threshold ? splitAtPauses(r, db, quiet, step) : [r]));
}

/** `region` split where it stays under `quiet` for `MIN_PAUSE` or more with louder sound on both sides. */
function splitAtPauses([a, b]: [number, number], db: number[], quiet: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  const first = Math.round(a / step);
  const last = Math.round(b / step) - 1;
  let from = a;
  let run = -1;
  for (let k = first; k <= last; k++) {
    if (db[k]! < quiet) {
      if (run < 0) run = k;
      continue;
    }
    if (run > first && (k - run) * step >= MIN_PAUSE) {
      out.push([from, run * step]);
      from = k * step;
    }
    run = -1;
  }
  out.push([from, b]);
  return out;
}

/**
 * Places each word in the speech region holding its aligned start (or one
 * starting just after), dropping words that lie in silence. DTW starts lag
 * the sound by up to a quarter second, so a cut there would leave the onset
 * of a cut word audible: the first word after a silence starts where the
 * sound does, and the last word before one ends where it stops. Apple's
 * starts lead the sound instead, often by more than `SNAP` after a pause:
 * such a word goes to the region it overlaps most.
 */
function placeInSpeech(words: Word[], speech: [number, number][]): Word[] {
  const overlap = (w: Word, [a, b]: [number, number]) => Math.min(w.end, b) - Math.max(w.start, a);
  const placed: { w: Word; region: [number, number] }[] = [];
  for (const w of words) {
    const region =
      speech.find(([a, b]) => w.start >= a - SNAP && w.start < b) ??
      speech.filter((r) => overlap(w, r) > 0).sort((x, y) => overlap(w, y) - overlap(w, x))[0];
    if (!region) continue;
    const start = Math.max(w.start, region[0]);
    const end = Math.min(w.end, region[1]);
    placed.push({ w: { ...w, start, end: end - start >= MIN_WORD ? end : Math.min(region[1], start + MIN_WORD) }, region });
  }
  return placed.map(({ w, region }, i) => ({
    ...w,
    start: placed[i - 1]?.region === region ? w.start : region[0],
    end: placed[i + 1]?.region === region ? w.end : region[1],
  }));
}

/** Speech regions joined across short pauses into chunks of at most `MAX_CHUNK` seconds, padded, in seconds. */
function chunksOf(speech: [number, number][], duration: number): [number, number][] {
  const chunks: [number, number][] = [];
  for (const [a, b] of speech) {
    const last = chunks.at(-1);
    if (last && a - last[1] < CHUNK_GAP && b - last[0] <= MAX_CHUNK) last[1] = b;
    else chunks.push([a, b]);
  }
  return chunks.map(([a, b]) => [Math.max(0, a - PAD), Math.min(duration, b + PAD)]);
}

function wavFile(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
}

/** A chunk's tokens joined into words at leading spaces; each runs from its first token's aligned time to the next word's. */
function chunkWords(tokens: WhisperToken[], [offset, end]: [number, number]): Word[] {
  const groups: WhisperToken[][] = [];
  for (const t of tokens) {
    if (t.text.startsWith("[_")) continue;
    if (!groups.length || t.text.startsWith(" ")) groups.push([]);
    groups.at(-1)!.push(t);
  }
  return groups
    .map((g, i) => {
      const next = groups[i + 1]?.[0];
      const start = offset + g[0]!.t_dtw / 100;
      return { text: g.map((t) => t.text).join("").trim(), start, end: next ? offset + next.t_dtw / 100 : end, p: g.reduce((sum, t) => sum + t.p, 0) / g.length };
    })
    .filter((w) => w.text);
}

const whisperModel = (opts: TranscribeOptions) => opts.model ?? process.env.BEACON_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;

/** whisper.cpp over each span of the audio (seconds), in one run: each span's words. */
async function whisperSpans(dir: string, name: string, pcm: Int16Array, spans: [number, number][], opts: TranscribeOptions, language: string, progress?: (f: number) => void): Promise<Word[][]> {
  const model = whisperModel(opts);
  if (!existsSync(model)) throw new Error(`whisper model not found at ${model}; download ggml-large-v3-turbo-q5_0.bin from huggingface.co/ggerganov/whisper.cpp`);
  const files = spans.map(([a, b], i) => {
    const file = join(dir, `${name}${i}.wav`);
    writeFileSync(file, wavFile(pcm.subarray(Math.floor(a * RATE), Math.ceil(b * RATE))));
    return file;
  });
  let done = 0;
  if (files.length) {
    const dtw = opts.dtw ?? process.env.BEACON_WHISPER_DTW ?? "large.v3.turbo";
    await runTool([tool("whisper-cli"), "-m", model, "-l", language, "-mc", "0", "-nfa", "--dtw", dtw, "-ojf", "-np", ...files.flatMap((f) => ["-f", f])], { onStderr: (chunk) => {
      done += chunk.match(/saving output/g)?.length ?? 0;
      progress?.(done / files.length);
    } });
  }
  const out: Word[][] = [];
  for (const [i, file] of files.entries()) {
    const json = (await Bun.file(`${file}.json`).json()) as { transcription: { tokens: WhisperToken[] }[] };
    out.push(chunkWords(json.transcription.flatMap((seg) => seg.tokens), spans[i]!));
  }
  return out;
}

/** Raw word times from whisper.cpp, chunked at pauses (see `transcribe`). */
async function whisperWords(dir: string, pcm: Int16Array, speech: [number, number][], opts: TranscribeOptions, language: string): Promise<{ words: Word[]; model: string }> {
  const words = (await whisperSpans(dir, "c", pcm, chunksOf(speech, pcm.length / RATE), opts, language, opts.onProgress)).flat();
  return { words, model: whisperModel(opts).split("/").pop()! };
}

const said = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const stretched = (w: Word) => w.end - w.start > STRETCHED[0] + STRETCHED[1] * said(w.text).length;

/**
 * Words placed in speech, with each stretched one (see `STRETCHED`) transcribed again on its own: when that
 * hears it with more words, they take its place; otherwise it stays.
 */
async function unstretch(dir: string, pcm: Int16Array, placed: Word[], speech: [number, number][], opts: TranscribeOptions, language: string): Promise<Word[]> {
  const long = placed.filter(stretched);
  if (!long.length) return placed;
  const duration = pcm.length / RATE;
  const heard = await whisperSpans(dir, "s", pcm, long.map((w) => [Math.max(0, w.start - PAD), Math.min(duration, w.end + PAD)]), opts, language);
  const again = new Map<Word, Word[]>();
  for (const [i, w] of long.entries()) {
    // The padding lets the words beside it in: DTW starts lag the sound, so one starting before it, or this close
    // to its end, is a neighbour, not one more of this.
    const inside = heard[i]!.filter((x) => x.start >= w.start && x.start < w.end - NEIGHBOUR).map((x) => ({ ...x, end: Math.min(x.end, w.end) }));
    if (inside.length > 1 && inside.some((x) => said(x.text) === said(w.text))) again.set(w, inside);
  }
  if (!again.size) return placed;
  return placeInSpeech(placed.flatMap((w) => again.get(w) ?? [w]), speech);
}

/** Raw word times from Apple's SpeechTranscriber, through `beacon-speech`, over the whole stream at once. */
async function appleWords(dir: string, pcm: Int16Array, opts: TranscribeOptions, language: string): Promise<{ words: Word[]; model: string }> {
  const file = join(dir, "audio.wav");
  writeFileSync(file, wavFile(pcm));
  const duration = pcm.length / RATE;
  const locale = language === "en" ? "en-US" : language;
  const out = await runTool([tool("beacon-speech"), file, "--locale", locale], { onStderr: (chunk) => {
    const at = [...chunk.matchAll(/progress ([\d.]+)/g)].at(-1)?.[1];
    if (at && duration > 0) opts.onProgress?.(Math.min(1, Number(at) / duration));
  } });
  const words = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Word);
  return { words, model: "apple-speechtranscriber" };
}

/** Requests to OpenAI's API at once. */
const API_PARALLEL = 4;
/**
 * A segment the API is this sure holds no speech, and was this unsure of, is noise. On the fixtures every
 * invented word's segment had no_speech_prob ≥ 0.78 and avg_logprob ≤ -0.6; speech stayed under 0.5.
 */
const NO_SPEECH = 0.6;
const NOISE_LOGPROB = -0.5;

interface ApiSegment {
  start: number;
  end: number;
  no_speech_prob: number;
  avg_logprob: number;
}

/**
 * Raw word times from Whisper through OpenAI's API (`whisper-1`: the model that returns word timestamps), in
 * the chunks local Whisper gets: given minutes at once, it skips repeated phrases, the retakes an editor cuts.
 */
async function openaiWords(pcm: Int16Array, speech: [number, number][], opts: TranscribeOptions, language: string): Promise<{ words: Word[]; model: string }> {
  if (!opts.apiKey) throw new Error("no OpenAI API key: add one in Settings › AI");
  const chunks = chunksOf(speech, pcm.length / RATE);
  const results: Word[][] = [];
  let done = 0;
  // Cancelled (the job, its project closed), nothing more is uploaded: each chunk is charged to the user's account.
  const signal = jobSignal();
  const one = async ([a, b]: [number, number]): Promise<Word[]> => {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("language", language);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    form.append("file", new Blob([wavFile(pcm.subarray(Math.floor(a * RATE), Math.ceil(b * RATE)))], { type: "audio/wav" }), "audio.wav");
    let res: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form, ...(signal ? { signal } : {}) });
      if (res.status !== 429 && res.status < 500) break;
      await Bun.sleep(1000 * 2 ** attempt);
    }
    if (!res!.ok) {
      const detail = ((await res!.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res!.statusText;
      throw new Error(res!.status === 401 ? "OpenAI refused the API key: check it in Settings › AI" : `OpenAI's API: ${detail}`);
    }
    const json = (await res!.json()) as { words?: { word: string; start: number; end: number }[]; segments?: ApiSegment[] };
    opts.onProgress?.(++done / chunks.length);
    // Over noise (typing, clicks) the API invents a word ("Bye", "You"): Whisper's own no-speech rule drops it.
    const noise = (json.segments ?? []).filter((g) => g.no_speech_prob > NO_SPEECH && g.avg_logprob < NOISE_LOGPROB);
    return (json.words ?? [])
      .filter((w) => !noise.some((g) => w.start >= g.start - 0.01 && w.start < g.end))
      .map((w) => ({ text: w.word.trim(), start: a + w.start, end: a + w.end, p: 1 }))
      .filter((w) => w.text);
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(API_PARALLEL, chunks.length) }, async () => {
      while (next < chunks.length) {
        signal?.throwIfAborted();
        const i = next++;
        results[i] = await one(chunks[i]!);
      }
    }),
  );
  signal?.throwIfAborted();
  return { words: results.flat(), model: "openai-whisper-1" };
}

/**
 * Word timings for one audio stream. Whisper on this Mac (whisper.cpp's `whisper-cli`, Metal) gets speech
 * split at pauses into chunks decoded independently and without previous text (`-mc 0`): over long audio
 * whisper skips repeated phrases, and those are the retakes an editor cuts; its words are timed by DTW
 * alignment (needs flash attention off). Apple's transcriber and OpenAI's API time words themselves.
 * Whichever made them, words are then fitted to the detected speech, and words in silence are dropped.
 */
export async function transcribe(path: string, opts: TranscribeOptions = {}): Promise<Transcription> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-transcribe-"));
  try {
    const bytes = await decodeAudio(path, { stream: opts.stream ?? 0, rate: RATE, format: "s16le" });
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const db = levels(pcm);
    const speech = speechRegions(pcm);
    const language = opts.language ?? "en";
    const transcriber = opts.transcriber ?? "whisper";
    const { words, model } =
      transcriber === "apple" ? await appleWords(dir, pcm, opts, language) : transcriber === "openai" ? await openaiWords(pcm, speech, opts, language) : await whisperWords(dir, pcm, speech, opts, language);
    const placed = placeInSpeech(words, speech);
    const whole = transcriber === "whisper" ? await unstretch(dir, pcm, placed, speech, opts, language) : placed;
    const heard = quietBoundaries(whole, speech, db, SEARCH[transcriber]);
    return {
      model,
      language,
      words: heard.map((w) => ({ ...w, start: roundSeconds(w.start), end: roundSeconds(w.end), p: roundSeconds(w.p) })),
      speech: speech.map(([a, b]) => [roundSeconds(a), roundSeconds(b)]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
