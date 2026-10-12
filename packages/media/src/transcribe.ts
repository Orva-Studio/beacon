import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { roundSeconds } from "@beacon/model";
import { runTool } from "./tool";

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

export interface TranscribeOptions {
  /** Index among the file's audio streams. */
  stream?: number;
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
/** How far DTW word starts lag the sound, at most. */
const LAG = 0.25;
/**
 * Chunking for whisper: split at pauses of this many seconds, keep chunks under its 30 s window.
 * Measured on demo_3: 0.5 s still let it skip a fourth take; splitting at every pause
 * made it invent words on very short chunks.
 */
const CHUNK_GAP = 0.3;
const MAX_CHUNK = 25;
const PAD = 0.2;


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
 * quietest window shortly before its aligned start (DTW lags), where a cut
 * is least audible. A word touching the one before shares the boundary.
 */
function quietBoundaries(words: Word[], speech: [number, number][], db: number[], rate = RATE): Word[] {
  const step = WINDOW / rate;
  const region = (t: number) => speech.findIndex(([a, b]) => t >= a && t <= b);
  const out = words.map((w) => ({ ...w }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const next = out[i]!;
    if (region(prev.end) < 0 || region(prev.end) !== region(next.start)) continue;
    const touching = Math.abs(prev.end - next.start) < 1e-6;
    const from = Math.ceil(Math.max(touching ? prev.start + MIN_WORD : prev.end, next.start - LAG) / step);
    const to = Math.floor(Math.min(next.end - MIN_WORD, next.start + 0.03) / step);
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
export function speechRegions(pcm: Int16Array, rate = RATE): [number, number][] {
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
  return raw.filter(([x, y]) => y - x >= MIN_SPEECH);
}

/**
 * Places each word in the speech region holding its aligned start (or one
 * starting just after), dropping words that lie in silence. DTW starts lag
 * the sound by up to a quarter second, so a cut there would leave the onset
 * of a cut word audible: the first word after a silence starts where the
 * sound does, and the last word before one ends where it stops.
 */
function placeInSpeech(words: Word[], speech: [number, number][]): Word[] {
  const placed: { w: Word; region: [number, number] }[] = [];
  for (const w of words) {
    const region = speech.find(([a, b]) => w.start >= a - SNAP && w.start < b);
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

function wavFile(pcm: Int16Array): Uint8Array {
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

/**
 * Word timings for one audio stream, with whisper.cpp's `whisper-cli`
 * (local, Metal). Speech is split at pauses into chunks decoded
 * independently and without previous text (`-mc 0`): over long audio
 * whisper skips repeated phrases, and those are the retakes an editor cuts.
 * Words are timed by DTW alignment (needs flash attention off), then fitted
 * to the detected speech; words in silence are dropped.
 */
export async function transcribe(path: string, opts: TranscribeOptions = {}): Promise<Transcription> {
  const model = opts.model ?? process.env.BEACON_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
  if (!existsSync(model)) throw new Error(`whisper model not found at ${model}; download ggml-large-v3-turbo-q5_0.bin from huggingface.co/ggerganov/whisper.cpp`);
  const dir = mkdtempSync(join(tmpdir(), "beacon-whisper-"));
  try {
    const raw = join(dir, "audio.pcm");
    await runTool(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", path, "-map", `0:a:${opts.stream ?? 0}`, "-ac", "1", "-ar", String(RATE), "-f", "s16le", raw]);
    const bytes = await Bun.file(raw).bytes();
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const db = levels(pcm);
    const speech = speechRegions(pcm);
    const chunks = chunksOf(speech, pcm.length / RATE);
    const files = chunks.map(([a, b], i) => {
      const file = join(dir, `c${i}.wav`);
      writeFileSync(file, wavFile(pcm.subarray(Math.floor(a * RATE), Math.ceil(b * RATE))));
      return file;
    });
    const language = opts.language ?? "en";
    let done = 0;
    if (files.length) {
      const dtw = opts.dtw ?? process.env.BEACON_WHISPER_DTW ?? "large.v3.turbo";
      await runTool(["whisper-cli", "-m", model, "-l", language, "-mc", "0", "-nfa", "--dtw", dtw, "-ojf", "-np", ...files.flatMap((f) => ["-f", f])], { onStderr: (chunk) => {
        done += chunk.match(/saving output/g)?.length ?? 0;
        opts.onProgress?.(done / files.length);
      } });
    }
    const words: Word[] = [];
    for (const [i, file] of files.entries()) {
      const json = (await Bun.file(`${file}.json`).json()) as { transcription: { tokens: WhisperToken[] }[] };
      words.push(...chunkWords(json.transcription.flatMap((seg) => seg.tokens), chunks[i]!));
    }
    const heard = quietBoundaries(placeInSpeech(words, speech), speech, db);
    return {
      model: model.split("/").pop()!,
      language,
      words: heard.map((w) => ({ ...w, start: roundSeconds(w.start), end: roundSeconds(w.end), p: roundSeconds(w.p) })),
      speech: speech.map(([a, b]) => [roundSeconds(a), roundSeconds(b)]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
