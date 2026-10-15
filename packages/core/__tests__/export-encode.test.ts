import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { audioPlaybackArgs, type VideoEncoding } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [RECORDING, VIDEO] = ["recording.trec", "video-3.mp4"].map((f) => join(FIXTURES, f)) as [string, string];
const ready = [RECORDING, VIDEO].every(existsSync);
const dir = mkdtempSync(join(tmpdir(), "beacon-export-encode-"));
const core = new LocalCore({ cacheDir: join(dir, "cache") });
let h: Awaited<ReturnType<LocalCore["create"]>>;

beforeAll(async () => {
  if (!ready) return;
  h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING, VIDEO], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 1, end: 3 }] });
});
afterAll(async () => {
  if (h) await core.close(h);
  rmSync(dir, { recursive: true, force: true });
});

interface Probe {
  codec: string;
  width: number;
  height: number;
  fps: string;
  frames: number;
  audio: string | undefined;
}

function probe(path: string): Probe {
  const r = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames", "-of", "json", path]);
  const streams = (JSON.parse(r.stdout.toString()) as { streams: Record<string, string | number>[] }).streams;
  const v = streams.find((s) => s.codec_type === "video")!;
  const a = streams.find((s) => s.codec_type === "audio");
  return { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: String(v.avg_frame_rate), frames: Number(v.nb_read_frames), audio: a && String(a.codec_name) };
}

/** Every frame as RGBA, decoded by ffmpeg. */
function decode(path: string): Uint8Array {
  return Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).stdout;
}

/** PSNR over RGB and the share of pixels more than 8 levels off in a channel. */
function compare(a: Uint8Array, b: Uint8Array): { psnr: number; off: number } {
  let se = 0;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      se += d * d;
      worst = Math.max(worst, d);
    }
    if (worst > 8) off++;
  }
  return { psnr: se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / ((a.length / 4) * 3))), off: off / (a.length / 4) };
}

async function exportWith(native: boolean, file: string, opts: VideoEncoding): Promise<string> {
  const output = join(dir, `${native ? "native" : "ffmpeg"}-${file}`);
  if (native) delete process.env.BEACON_ENCODE_FFMPEG;
  else process.env.BEACON_ENCODE_FFMPEG = "1";
  try {
    await (await core.export(h, { output, from: 0, to: 2, ...opts })).done;
  } finally {
    delete process.env.BEACON_ENCODE_FFMPEG;
  }
  return output;
}

// Both encode with VideoToolbox at the same settings, from the same frames converted to BT.709 on the GPU or by
// swscale, so they differ by compression noise.
const CASES: [string, VideoEncoding][] = [
  ["h264.mp4", { codec: "h264" }],
  ["hevc.mp4", { codec: "hevc" }],
  ["prores.mov", { codec: "prores" }],
  ["small.mp4", { codec: "h264", size: { width: 640, height: 640 } }],
  ["24fps.mp4", { codec: "h264", fps: 24 }],
  ["12.5fps.mp4", { codec: "h264", fps: 12.5 }],
];

/** Frames of an export at another rate at the same instants as the project's 30 fps: every `step`th is every `ref`th. */
const SAME_INSTANTS: Record<number, { step: number; ref: number }> = { 24: { step: 4, ref: 5 }, 12.5: { step: 5, ref: 12 } };

for (const [file, opts] of CASES) {
  test.skipIf(!ready)(`the native encoder's ${file} matches ffmpeg's`, async () => {
    const [before, after] = [await exportWith(false, file, opts), await exportWith(true, file, opts)];
    const [a, b] = [probe(before), probe(after)];
    // ffmpeg's -r rounds the frame count up past the range (50 frames for 2 s at 24 fps); natively it is exact.
    // Its rate is the same fraction ("25/2" at 12.5 fps).
    const frames = Math.round(2 * (opts.fps ?? 30));
    expect(b).toEqual({ ...a, frames });
    const pb = decode(after);
    const size = a.width * a.height * 4;
    expect(pb.length).toBe(frames * size);
    // ffmpeg drops or repeats frames for another rate where they are evaluated at it natively: compare the frames
    // at the same instants in ffmpeg's export at the project's rate.
    const { step, ref: refStep } = opts.fps ? SAME_INSTANTS[opts.fps]! : { step: 1, ref: 1 };
    const reference = opts.fps ? await exportWith(false, `30-${file}`, { ...opts, fps: undefined }) : before;
    const pa = decode(reference);
    let worst = { psnr: Infinity, off: 0 };
    for (let i = 0; i * step < frames; i++) {
      const [x, y] = [i * refStep, i * step];
      const c = compare(pa.subarray(x * size, (x + 1) * size), pb.subarray(y * size, (y + 1) * size));
      worst = { psnr: Math.min(worst.psnr, c.psnr), off: Math.max(worst.off, c.off) };
    }
    console.log(`${file}: ${a.codec} ${a.width}×${a.height} ${b.fps}, ${frames} frames, worst ${worst.psnr.toFixed(1)} dB, ${(worst.off * 100).toFixed(2)}% more than 8 levels off`);
    expect(worst.psnr).toBeGreaterThan(opts.codec === "prores" ? 45 : 40);
    expect(worst.off).toBeLessThan(0.02);
  }, 120_000);
}

/** Mono 48 kHz float samples of a file's audio, or of ffmpeg argv ending before its output. */
function pcm(input: string | string[]): Float32Array {
  const args = typeof input === "string" ? [tool("ffmpeg"), "-v", "error", "-i", input] : input;
  const out = Bun.spawnSync([...args, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]).stdout;
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

test.skipIf(!ready)("the audio, mixed while the video renders, is the range's mix under it", async () => {
  const output = join(dir, "audio.mp4");
  await (await core.export(h, { output, from: 0.5, to: 2 })).done;
  const exported = pcm(output);
  const mixed = pcm(audioPlaybackArgs(core.doc(h), core.registry, 0.5, 1.5));
  expect(exported.length).toBeGreaterThan(0.99 * mixed.length);
  expect(exported.length).toBeLessThan(1.01 * mixed.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < Math.min(exported.length, mixed.length); i++) {
    signal += mixed[i]! ** 2;
    noise += (mixed[i]! - exported[i]!) ** 2;
  }
  const snr = 10 * Math.log10(signal / noise);
  console.log(`audio: ${(exported.length / 48000).toFixed(3)} s against ${(mixed.length / 48000).toFixed(3)} s, ${snr.toFixed(1)} dB`);
  expect(signal).toBeGreaterThan(0);
  expect(snr).toBeGreaterThan(20);
}, 120_000);
