import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [RECORDING, VIDEO] = ["recording.trec", "video-3.mp4"].map((f) => join(FIXTURES, f)) as [string, string];
const dir = mkdtempSync(join(tmpdir(), "beacon-export-decode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** PNG frames of a stretch with a seek in it (a cut), decoded natively or as FFmpeg drives VideoToolbox. */
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

test.skipIf(![RECORDING, VIDEO].every(existsSync))("export decodes natively through VideoToolbox, frame for frame what FFmpeg's path gave", async () => {
  const before = await frames(false);
  const after = await frames(true);
  expect(before.size).toBeGreaterThan(50);
  expect([...after.keys()]).toEqual([...before.keys()]);
  const differ = [...before].filter(([f, png]) => !png.equals(after.get(f)!)).map(([f]) => f);
  expect(differ).toEqual([]);
}, 180_000);
