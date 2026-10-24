import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-toggles-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(RECORDING))("Toggle Camera and Toggle Cursor hide a recording's camera or cursor (opacity 0) and show it again (100%), each one undo step; with clips selected, only those", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const camera = () => clips().find((c) => c.type === "video")!;
  const screen = () => clips().find((c) => c.type === "screen")!;
  const opacity = (group: string, c = camera()) => (c.props[group] as { opacity?: number } | undefined)?.opacity ?? 1;
  expect(camera()).toBeDefined();

  await core.run(h, "camera.toggle", {});
  expect(opacity("transform")).toBe(0);
  expect((await core.history(h)).undo.at(-1)).toBe("Hide Camera");
  await core.run(h, "camera.toggle", {});
  expect(opacity("transform")).toBe(1);
  expect((await core.history(h)).undo.at(-1)).toBe("Show Camera");

  await core.run(h, "cursor.toggle", {});
  expect(opacity("cursor", screen())).toBe(0);
  await core.run(h, "cursor.toggle", {});
  expect(opacity("cursor", screen())).toBe(1);

  // Split in two and one piece selected: only it is hidden.
  await core.run(h, "clip.split", { at: 2, clips: [camera().id], linked: false });
  const [first, second] = clips().filter((c) => c.type === "video");
  await core.run(h, "selection.set", { clips: [second!.id], linked: false });
  await core.run(h, "camera.toggle", {});
  const after = clips().filter((c) => c.type === "video");
  expect(after.map((c) => opacity("transform", c))).toEqual([1, 0]);
  expect(after[0]!.id).toBe(first!.id);
  // The selected piece's track locked: refused, the other piece left as it is.
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === second!.id))!;
  await core.run(h, "track.set", { track: track.id, locked: true });
  await expect(core.run(h, "camera.toggle", {})).rejects.toThrow(/locked track/);
  expect(clips().filter((c) => c.type === "video").map((c) => opacity("transform", c))).toEqual([1, 0]);
  await core.run(h, "track.set", { track: track.id, locked: false });

  // A fade animated in still hides with the rest: its block ends at 0 too, then at 100% when shown, one undo step.
  await core.run(h, "selection.set", { clips: [first!.id], linked: false });
  await core.run(h, "animation.add", { clip: first!.id, end: 1, duration: 0.5, to: { "transform.opacity": 1, "transform.scaleX": 1.2 } });
  const steps = (await core.history(h)).undo.length;
  const block = () => clips().find((c) => c.id === first!.id)!.animations[0]!.to;
  await core.run(h, "camera.toggle", {});
  expect([opacity("transform", clips().find((c) => c.id === first!.id)), block()["transform.opacity"], block()["transform.scaleX"]]).toEqual([0, 0, 1.2]);
  expect((await core.history(h)).undo.length).toBe(steps + 1);
  await core.run(h, "camera.toggle", {});
  expect(block()["transform.opacity"]).toBe(1);
}, 60_000);
