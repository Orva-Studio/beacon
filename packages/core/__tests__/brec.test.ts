import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaInfo } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
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
