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
