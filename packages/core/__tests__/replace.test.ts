import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [LONG, SHORT, AUDIO, TREC] = ["video-3.mp4", "video.mp4", "audio.m4a", "recording.trec"].map((f) => join(FIXTURES, f)) as [string, string, string, string];
const dir = mkdtempSync(join(tmpdir(), "beacon-replace-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(![LONG, SHORT, AUDIO, TREC].every(existsSync))("Replace Media swaps an imported file, keeping its clips where the new one reaches; never a recording", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "replace.beproj") });
  const r = await core.import(h, [LONG]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = r.assets[0]!;
  await core.run(h, "clip.split", { at: 10 });
  const spans = () =>
    core
      .doc(h)
      .tracks.flatMap((t) => t.clips)
      .filter((c) => c.assetId === asset)
      .map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.duration)]);
  const before = spans();
  expect(before).toEqual([[0, 10], [10, expect.any(Number)]]);

  // 4.5 s replaces 20 s: the first clip ends where it does, the second began after it and goes.
  const { jobs } = await core.replace(h, asset, SHORT);
  for (const j of jobs) await core.cancelJob(j).catch(() => {});
  expect(core.doc(h).assets[asset]!.path).toBe(SHORT);
  expect(spans()).toEqual([[0, 4.5]]);
  await core.undo(h);
  expect(core.doc(h).assets[asset]!.path).toBe(LONG);
  expect(spans()).toEqual(before);

  await expect(core.replace(h, asset, AUDIO)).rejects.toThrow("can only be replaced with another video");
  const rec = await core.import(h, [TREC]);
  for (const j of rec.jobs) await core.cancelJob(j).catch(() => {});
  await expect(core.replace(h, rec.assets[0]!, SHORT)).rejects.toThrow("is a recording");
  await core.close(h);
}, 60_000);
