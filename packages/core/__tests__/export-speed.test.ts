import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [AUDIO, VIDEO] = ["audio.m4a", "video.mp4"].map((f) => join(FIXTURES, f)) as [string, string];
const dir = mkdtempSync(join(tmpdir(), "beacon-export-speed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function streams(path: string) {
  const r = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,duration,nb_read_frames,avg_frame_rate", "-of", "json", path]);
  return (JSON.parse(r.stdout.toString()) as { streams: Record<string, string>[] }).streams;
}

test.skipIf(![AUDIO, VIDEO].every(existsSync))("an export sped up to 1.25× is the timeline sampled faster at the same rate, its sound and .srt with it; the project isn't changed", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  copyFileSync(AUDIO, join(dir, "talk.m4a"));
  await core.import(h, [VIDEO], { at: 0 });
  const r = await core.import(h, [join(dir, "talk.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const words = ["One", "two", "three", "four"].map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
  await core.run(h, "captions.create", { maxWords: 2 });
  const before = JSON.stringify(core.doc(h));

  const job = await core.export(h, { output: join(dir, "fast.mp4"), from: 0, to: 3, speed: 1.25, files: ["captions"] });
  expect(((await job.done) as { seconds: number }).seconds).toBeCloseTo(2.4, 6);
  const [video, audio] = ["video", "audio"].map((k) => streams(join(dir, "fast.mp4")).find((s) => s.codec_type === k)!);
  // 90 frames of the timeline in 72 of the file, still at 30 fps.
  expect(Number(video!.nb_read_frames)).toBe(72);
  expect(video!.avg_frame_rate).toBe("30/1");
  expect(Number(audio!.duration)).toBeCloseTo(2.4, 1);
  // "One two" is up from 0.5 s to 1.5 s of the timeline (until "three four"): 0.4 s to 1.2 s of the file.
  expect(readFileSync(join(dir, "fast.srt"), "utf8")).toContain("00:00:00,400 --> 00:00:01,200\nOne two");
  expect(JSON.stringify(core.doc(h))).toBe(before);

  await (await core.export(h, { output: join(dir, "fast.wav"), from: 0, to: 3, speed: 1.5 })).done;
  expect(Number(streams(join(dir, "fast.wav"))[0]!.duration)).toBeCloseTo(2, 2);
  await expect(core.export(h, { output: join(dir, "x.mp4"), speed: 3 })).rejects.toThrow("1× to 2×");
  await core.close(h);
}, 120_000);
