import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const IMAGE = join(FIXTURES, "image.png");
const dir = mkdtempSync(join(tmpdir(), "beacon-extend-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const seconds = (ticks: number) => ticks / 705_600_000;

test.skipIf(!existsSync(RECORDING) || !existsSync(IMAGE))("a recording's first frame held before it: with room made its linked clips move with it, at 0 without room it's refused, inside a group not before the group's window", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "extend.beproj") });
  const r = await core.import(h, [RECORDING], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const video = all().find((c) => c.linkId && ["screen", "camera", "video"].includes(c.type))!;
  const partners = () => all().filter((c) => c.linkId === video.linkId);
  expect(partners().length).toBeGreaterThan(1);
  expect(seconds(video.start)).toBe(0);
  const before = JSON.stringify(core.doc(h).tracks);

  await expect(core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start" })).rejects.toThrow(/start/);
  const still = (await core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start", ripple: true })).results[0] as string;
  const held = all().find((c) => c.id === still)!;
  expect([seconds(held.start), seconds(held.duration), held.mediaStart ?? 0]).toEqual([0, 1, video.mediaStart ?? 0]);
  for (const c of partners()) expect(seconds(c.start)).toBe(1);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);

  // Grouped with an image 3 s before it, the group's start then trimmed to 2.5 s: a frame held from 2 s would be hidden.
  await core.run(h, "timeline.insertSpace", { at: 0, duration: 3 });
  await core.run(h, "track.add", { name: "Image" });
  const track = core.doc(h).tracks.find((t) => t.name === "Image")!.id;
  const img = await core.import(h, [IMAGE], { at: 0, track });
  const image = all().find((c) => c.assetId === img.assets[0])!;
  const group = (await core.run(h, "clip.group", { clips: [image.id, ...partners().map((c) => c.id)] })).results[0] as string;
  await core.run(h, "clip.trim", { clip: group, start: 2.5 });
  await expect(core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start" })).rejects.toThrow(/group/);
  await core.run(h, "clip.extendFrame", { clip: video.id, duration: 0.5, edge: "start" });
  await core.close(h);
}, 60_000);
