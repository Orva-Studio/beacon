import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { secondsToTicks, ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-camera-delay-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(TAKE))("a take's camera delay set by hand moves every camera piece's picture against the sound, in place, its animations with it; the end piece loses what runs past the media; one undo step, exact", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const camera = () => clips().filter((c) => c.type === "video").sort((a, b) => a.start - b.start);
  const audio = () => clips().filter((c) => c.type === "audio");
  // Cut into pieces, as Remove Silences leaves a take; one piece zooms in.
  const whole = camera()[0]!;
  await core.run(h, "clip.split", { clips: [whole.id], at: ticksToSeconds(whole.start + whole.duration / 2) });
  const [first, last] = camera();
  await core.run(h, "edit.addAnimation", { clip: first!.id, time: 1, duration: 1 });
  const before = structuredClone(core.doc(h));
  const was = camera();
  const sound = JSON.stringify(audio());

  await core.run(h, "media.cameraDelay", { clip: last!.id, ms: 120 });
  const shift = secondsToTicks(0.12);
  const now = camera();
  // Both pieces show their media 120 ms later, where they were; the sound didn't move.
  expect(now.map((c) => c.mediaStart! - was[now.indexOf(c)]!.mediaStart!)).toEqual([shift, shift]);
  expect(now.map((c) => c.start)).toEqual(was.map((c) => c.start));
  expect(JSON.stringify(audio())).toBe(sound);
  expect(now[0]!.animations[0]!.end - was[0]!.animations[0]!.end).toBe(shift);
  // The last piece ran to the media's end: it is shorter by the frames past it.
  expect(now[1]!.duration).toBeLessThan(was[1]!.duration);
  expect(was[1]!.duration - now[1]!.duration).toBeLessThanOrEqual(shift + secondsToTicks(1 / 30));
  expect(now.every((c) => (c.props.media as { delay?: number }).delay === 120)).toBe(true);
  // Set again, it replaces the delay rather than adding to it.
  await core.run(h, "media.cameraDelay", { clip: now[0]!.id, ms: 40 });
  expect(camera()[0]!.mediaStart! - was[0]!.mediaStart!).toBe(secondsToTicks(0.04));
  // Only a take's camera has one.
  await expect(core.run(h, "media.cameraDelay", { clip: audio()[0]!.id, ms: 100 })).rejects.toThrow("is not a take's camera");
  await core.undo(h);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(JSON.stringify(before));
  await core.close(h);
});

test.skipIf(!existsSync(TAKE))("a camera delay reaches a copy of the take placed later and one inside a group, each moved from the delay it has", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache2") });
  const h = await core.create({ path: join(dir, "q.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = r.assets[0]!;
  const top = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const [old] = top().filter((c) => c.type === "video");
  const at = (c: { mediaStart?: number }) => c.mediaStart ?? 0;
  const start = at(old!);
  await core.run(h, "media.cameraDelay", { clip: old!.id, ms: 200 });
  // Placed again: its camera has no delay yet. Grouped, it is inside the group.
  const end = ticksToSeconds(Math.max(...top().map((c) => c.start + c.duration)));
  await core.run(h, "asset.place", { asset, time: end + 1 });
  const placed = top().find((c) => c.type === "video" && c.id !== old!.id)!;
  const group = (await core.run(h, "clip.group", { clips: [placed.id] })).results[0] as string;
  const inner = () => (top().find((c) => c.id === group)!.props.group as { tracks: { clips: { id: string; mediaStart?: number; props: Record<string, unknown> }[] }[] }).tracks.flatMap((t) => t.clips).find((c) => c.id === placed.id)!;
  const innerStart = at(inner());
  // Set on the grouped copy: it moves 300 ms, the other 100 ms more; both say 300.
  await core.run(h, "media.cameraDelay", { clip: placed.id, ms: 300 });
  expect(at(inner()) - innerStart).toBe(secondsToTicks(0.3));
  expect(at(top().find((c) => c.id === old!.id)!) - start).toBe(secondsToTicks(0.3));
  expect([(inner().props.media as { delay: number }).delay, (top().find((c) => c.id === old!.id)!.props.media as { delay: number }).delay]).toEqual([300, 300]);
  await core.close(h);
});
