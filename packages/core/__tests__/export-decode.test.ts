import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [RECORDING, VIDEO] = ["recording.trec", "video-3.mp4"].map((f) => join(FIXTURES, f)) as [string, string];
const dir = mkdtempSync(join(tmpdir(), "beacon-export-decode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** RGBA of a PNG. */
function rgba(png: Buffer): Uint8Array {
  const r = Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-f", "png_pipe", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdin: png });
  return r.stdout;
}

/** Peak signal to noise over RGB, the share of pixels more than 3 levels off in a channel, and the largest difference. */
function compare(a: Uint8Array, b: Uint8Array): { psnr: number; off: number; max: number } {
  let se = 0;
  let off = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      se += d * d;
      worst = Math.max(worst, d);
    }
    if (worst > 3) off++;
    max = Math.max(max, worst);
  }
  const n = (a.length / 4) * 3;
  return { psnr: se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n)), off: off / (a.length / 4), max };
}

/** PNG frames of a stretch with a seek in it (a cut): as today (FFmpeg drives VideoToolbox, swscale converts) or natively, converted on the GPU from the decoded IOSurfaces. */
async function frames(native: boolean): Promise<Map<string, Buffer>> {
  const out = join(dir, native ? "native/" : "ffmpeg/");
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, `${native ? "native" : "ffmpeg"}.beproj`) });
  const r = await core.import(h, [RECORDING, VIDEO], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 1, end: 3 }] });
  if (native) delete process.env.BEACON_DECODE_FFMPEG;
  else process.env.BEACON_DECODE_FFMPEG = "1";
  try {
    await (await core.export(h, { output: out, from: 0, to: 2 })).done;
  } finally {
    delete process.env.BEACON_DECODE_FFMPEG;
  }
  await core.close(h);
  return new Map(readdirSync(out).map((f) => [f, readFileSync(join(out, f))]));
}

test.skipIf(![RECORDING, VIDEO].every(existsSync))("export decodes natively and converts on the GPU, matching the frames FFmpeg's path gave", async () => {
  const before = await frames(false);
  const after = await frames(true);
  expect(before.size).toBeGreaterThan(50);
  expect([...after.keys()]).toEqual([...before.keys()]);
  // The GPU averages and converts in floating point where swscale uses fixed point, and filters chroma at sharp
  // edges slightly differently: nearly every pixel is within a level, a few at edges up to ~16.
  let worst = { psnr: Infinity, off: 0, max: 0 };
  for (const [f, png] of before) {
    const c = compare(rgba(png), rgba(after.get(f)!));
    expect(c.psnr, f).toBeGreaterThan(45);
    expect(c.off, f).toBeLessThan(0.001);
    worst = { psnr: Math.min(worst.psnr, c.psnr), off: Math.max(worst.off, c.off), max: Math.max(worst.max, c.max) };
  }
  expect(worst.max).toBeLessThanOrEqual(24);
}, 180_000);
