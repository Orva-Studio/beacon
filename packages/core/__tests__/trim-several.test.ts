import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-trim-several-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("trimming several annotations' starts stops them all where one reaches the timeline's start; undone exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 5, duration: 2 });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 1, duration: 2 });
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const start = (id: string) => ticksToSeconds(all().find((c) => c.id === id)!.start);
  const late = all().find((c) => start(c.id) === 5)!.id;
  const early = all().find((c) => start(c.id) === 1)!.id;
  const before = JSON.stringify(core.doc(h));
  await core.run(h, "clip.trim", { clip: late, start: 2, with: [early] });
  expect([start(late), start(early)]).toEqual([4, 0]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);
  await core.close(h);
});
