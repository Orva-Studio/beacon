import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTool, spawn, tool } from "./tool";

/** What a sync check measured: how late the camera's picture is behind the microphone's sound. */
export interface SyncResult {
  /** Milliseconds; positive when the camera is late (a capture card's usual delay), so its clips move earlier. */
  cameraLateMs: number;
  /** Flashes measured, and how far their results spread (max - min, milliseconds). */
  flashes: number;
  spreadMs: number;
}

interface Take {
  streams: Record<string, { file: string; start: number | null }>;
}

/** Each frame's time (seconds into its file) and mean luma (0-255), every frame as recorded (a still screen sends few). */
async function lumas(path: string): Promise<{ t: number; y: number }[]> {
  const out = await runTool([
    tool("ffmpeg"), "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", path,
    "-vf", "scale=32:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-fps_mode", "passthrough", "-f", "null", "-",
  ]);
  const frames: { t: number; y: number }[] = [];
  let t: number | undefined;
  for (const line of out.split("\n")) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && t !== undefined) frames.push({ t, y: Number(y[1]) });
  }
  return frames;
}

/** The file's audio as mono float samples at `rate`. */
async function samples(path: string, rate: number): Promise<Float32Array> {
  const proc = spawn([tool("ffmpeg"), "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", path, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdout: "pipe", stderr: "ignore" });
  const bytes = await new Response(proc.stdout).arrayBuffer();
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg could not read ${path}`);
  return new Float32Array(bytes);
}

/**
 * When a picture brightens: each time the luma rises well above where it rested, the moment it crosses halfway
 * between the two, between frames by straight line (a frame half-exposed to the flash is half as bright).
 */
function flashes(frames: { t: number; y: number }[], minRise: number): number[] {
  const out: number[] = [];
  let quietUntil = -Infinity;
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.t < quietUntil) continue;
    const before = frames.filter((g) => g.t < f.t && g.t >= f.t - 0.4).map((g) => g.y);
    if (!before.length) continue;
    const base = before.sort((a, b) => a - b)[Math.floor(before.length / 2)]!;
    const after = frames.filter((g) => g.t >= f.t && g.t < f.t + 0.3);
    const peak = Math.max(...after.map((g) => g.y));
    if (peak - base < minRise || f.y - base < (peak - base) / 2) continue;
    const half = base + (peak - base) / 2;
    const prev = frames[i - 1]!;
    out.push(prev.y < half && f.y > prev.y ? prev.t + ((half - prev.y) / (f.y - prev.y)) * (f.t - prev.t) : f.t);
    quietUntil = f.t + 0.8;
  }
  return out;
}

/** When each 1 kHz beep starts: the 1 kHz energy in 2 ms steps (Goertzel), rising past a quarter of its loudest. */
function beeps(pcm: Float32Array, rate: number): number[] {
  const n = Math.round(rate * 0.002);
  const k = (2 * Math.cos((2 * Math.PI * 1000) / rate));
  const power: number[] = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let [s1, s2] = [0, 0];
    for (let j = i; j < i + n; j++) [s1, s2] = [pcm[j]! + k * s1 - s2, s1];
    power.push(s1 * s1 + s2 * s2 - k * s1 * s2);
  }
  const loudest = Math.max(...power);
  const out: number[] = [];
  let quietUntil = -1;
  for (let w = 0; w < power.length; w++) {
    if (w < quietUntil || power[w]! < loudest / 4) continue;
    out.push((w * n) / rate);
    quietUntil = w + Math.round(0.5 / 0.002);
  }
  return out;
}

const nearest = (times: number[], t: number, from: number, to: number) => times.find((x) => x >= t + from && x <= t + to);

/**
 * Measures a sync-check take (docs/formats/brec.md): the screen flashed white with a beep a few times while
 * the screen, system audio, camera and microphone recorded. For each flash, how much later the camera saw it
 * than the microphone heard it, less how much later the screen showed it than the Mac played it (so the
 * flash and beep needn't fire together); the median of those. What it can't tell apart: the display's and
 * speakers' own delays, a few milliseconds either way.
 */
export async function measureSync(dir: string): Promise<SyncResult> {
  const take = JSON.parse(readFileSync(join(dir, "recording.json"), "utf8")) as Take;
  const stream = (role: string) => {
    const s = take.streams[role];
    if (!s || s.start === null) throw new Error(`the check recorded no ${role === "systemAudio" ? "system audio" : role}`);
    return { path: join(dir, s.file), start: s.start };
  };
  const [screen, system, camera, mic] = [stream("screen"), stream("systemAudio"), stream("camera"), stream("microphone")];
  const RATE = 48_000;
  const [screenFlashes, cameraFlashes, systemBeeps, micBeeps] = await Promise.all([
    lumas(screen.path).then((f) => flashes(f, 40).map((t) => t + screen.start)),
    // A camera sees the screen's light on the room, much fainter than the screen itself.
    lumas(camera.path).then((f) => flashes(f, 1.5).map((t) => t + camera.start)),
    samples(system.path, RATE).then((p) => beeps(p, RATE).map((t) => t + system.start)),
    samples(mic.path, RATE).then((p) => beeps(p, RATE).map((t) => t + mic.start)),
  ]);
  const late: number[] = [];
  for (const s of screenFlashes) {
    const y = nearest(systemBeeps, s, -0.4, 0.4);
    const c = nearest(cameraFlashes, s, -0.05, 0.6);
    const m = y === undefined ? undefined : nearest(micBeeps, y, -0.02, 0.4);
    if (y !== undefined && c !== undefined && m !== undefined) late.push(c - m - (s - y));
  }
  if (!screenFlashes.length) throw new Error("the screen recording shows no flash");
  if (!cameraFlashes.length) throw new Error("the camera didn't see the flashes: point it so the screen's light reaches it, and dim the room");
  if (!micBeeps.length) throw new Error("the microphone didn't hear the beeps: turn the speakers up");
  if (late.length < 2) throw new Error(`only ${late.length} of ${screenFlashes.length} flashes were seen and heard by both: try again`);
  late.sort((a, b) => a - b);
  const median = late[Math.floor(late.length / 2)]!;
  return { cameraLateMs: Math.round(median * 1000), flashes: late.length, spreadMs: Math.round((late.at(-1)! - late[0]!) * 1000) };
}
