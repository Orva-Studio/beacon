import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia, runTool, type MediaInfo } from "@beacon/media";
import { projectDuration, ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-brec-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(TAKE))("a .brec take imports as one recording whose clips show the same moment, with its cursor", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "take.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const doc = core.doc(h);
  const asset = doc.assets[r.assets[0]!]!;
  expect(asset.kind).toBe("recording");
  const info = asset.derived.media as MediaInfo;
  expect(info.streams.map((s) => s.role)).toEqual(["screen", "camera", "microphone", "systemAudio"]);

  const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => r.clips.includes(c.id));
  expect(clips.map((c) => c.type)).toEqual(["screen", "video", "audio", "audio"]);
  expect(new Set(clips.map((c) => c.start)).size).toBe(1);
  // Each clip starts as far into its file as that file began after the latest one: all show the same moment.
  const moment = clips.map((c) => {
    const kind = c.type === "audio" ? "audio" : "video";
    const s = info.streams.filter((x) => x.kind === kind)[(c.props.media as { stream: number }).stream]!;
    return s.start! + ticksToSeconds(c.mediaStart ?? 0);
  });
  for (const m of moment) expect(m).toBeCloseTo(moment[0]!, 6);
  // As a `.trec`'s: the camera and audio linked, the screen apart.
  expect(clips[0]!.linkId).toBeUndefined();
  expect(new Set(clips.slice(1).map((c) => c.linkId)).size).toBe(1);

  const cursor = core.derived<{ t: Float64Array; images: { file?: string }[] }>(h, asset.id, "cursor")!;
  expect(cursor.t.length).toBeGreaterThan(0);
  expect(cursor.images.every((i) => i.file && existsSync(i.file))).toBe(true);
  expect((await core.frame(h, 0.5, { width: 320 })).png.length).toBeGreaterThan(1000);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(TAKE))("a .brec take exports as an MP4 as long as the timeline, with its picture and its sound", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "export.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const length = ticksToSeconds(projectDuration(core.doc(h)));
  const out = join(dir, "take.mp4");
  const job = await core.export(h, { output: out });
  let info = await core.job(job.id);
  while (info.state === "running") info = (await Bun.sleep(100), await core.job(job.id));
  expect(info.error).toBeUndefined();
  expect(info.state).toBe("done");

  const media = await probeMedia(out);
  const video = media.streams.filter((s) => s.kind === "video");
  const audio = media.streams.filter((s) => s.kind === "audio");
  expect(video.length).toBe(1);
  expect(audio.length).toBe(1);
  expect([video[0]!.width, video[0]!.height]).toEqual([core.doc(h).settings.width, core.doc(h).settings.height]);
  expect(Math.abs(media.duration - length)).toBeLessThan(0.1);
  // The microphone and system audio mixed in: not silence.
  let stats = "";
  await runTool(["ffmpeg", "-nostdin", "-v", "info", "-i", out, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"], { onStderr: (c) => (stats += c) });
  const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(stats)?.[1]);
  expect(peak).toBeGreaterThan(-50);
  await core.close(h);
}, 120_000);

test.skipIf(!existsSync(TAKE))("a take whose recorder was killed imports from what its last checkpoint says", async () => {
  const take = join(dir, "killed.brec");
  cpSync(TAKE, take, { recursive: true });
  const meta = JSON.parse(readFileSync(join(take, "recording.json"), "utf8"));
  writeFileSync(join(take, "recording.json"), JSON.stringify({ ...meta, complete: false, duration: null }));
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "killed.beproj") });
  const r = await core.import(h, [take]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const info = core.doc(h).assets[r.assets[0]!]!.derived.media as MediaInfo;
  expect(info.streams.map((s) => s.role)).toEqual(["screen", "camera", "microphone", "systemAudio"]);
  expect(info.duration).toBeGreaterThan(1.5);
  await core.close(h);
}, 60_000);
