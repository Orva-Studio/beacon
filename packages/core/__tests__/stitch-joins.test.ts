import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { secondsToTicks } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-stitch-joins-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(RECORDING))("stitching pieces whose look differs ramps to each piece's look over the half second before its join; the same look adds nothing; undone exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const screen = all().find((c) => c.type === "screen")!;
  await core.run(h, "clip.unlink", { clips: [screen.id] });
  for (const c of all()) if (c.id !== screen.id) await core.run(h, "clip.remove", { clip: c.id }).catch(() => {});
  await core.run(h, "clip.trim", { clip: screen.id, end: 4 });
  const [second] = (await core.run(h, "clip.split", { at: 2, clips: [screen.id], linked: false })).results[0] as string[];
  const scale = (all().find((c) => c.id === screen.id)!.props.transform as { scaleX: number }).scaleX;

  // The same look on both sides: nothing to ramp.
  const before = JSON.stringify(core.doc(h));
  const plain = (await core.run(h, "clip.stitch", { clips: [screen.id, second!] })).results[0] as string;
  expect(all().find((c) => c.id === plain)!.animations).toEqual([]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);

  // The second piece zoomed in: a half-second ease ending at the join takes the stitched clip there.
  await core.run(h, "clip.set", { clip: second!, props: { transform: { scaleX: scale * 1.5, scaleY: scale * 1.5 } } });
  const zoomed = JSON.stringify(core.doc(h));
  const id = (await core.run(h, "clip.stitch", { clips: [screen.id, second!] })).results[0] as string;
  const stitched = all().find((c) => c.id === id)!;
  expect(stitched.animations).toHaveLength(1);
  const [ramp] = stitched.animations;
  expect(ramp!.end).toBe(secondsToTicks(2));
  expect(ramp!.duration).toBe(secondsToTicks(0.5));
  expect(ramp!.easing).toBe("easeInOut");
  expect(ramp!.to).toEqual({ "transform.scaleX": scale * 1.5, "transform.scaleY": scale * 1.5 });
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(zoomed);

  // A crop on the second piece only (a recording has no crop of its own): it ramps in too.
  await core.run(h, "clip.set", { clip: second!, props: { transform: { scaleX: scale, scaleY: scale }, crop: { left: 100, top: 0, right: 0, bottom: 0 } } });
  const cropped = (await core.run(h, "clip.stitch", { clips: [screen.id, second!] })).results[0] as string;
  expect(all().find((c) => c.id === cropped)!.animations.map((a) => a.to)).toEqual([{ "crop.left": 100 }]);

  // A zoom made before the split, held across it: both pieces show it, so the stitch adds no ramp back.
  for (let i = 0; i < 4; i++) await core.undo(h);
  await core.run(h, "animation.add", { clip: screen.id, end: 1, duration: 0.5, to: { "transform.scaleX": scale * 1.5, "transform.scaleY": scale * 1.5 } });
  const [late] = (await core.run(h, "clip.split", { at: 2, clips: [screen.id], linked: false })).results[0] as string[];
  const held = (await core.run(h, "clip.stitch", { clips: [screen.id, late!] })).results[0] as string;
  expect(all().find((c) => c.id === held)!.animations).toHaveLength(1);
  await core.close(h);
}, 60_000);
