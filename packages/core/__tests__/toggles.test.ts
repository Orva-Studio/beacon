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
}, 60_000);
