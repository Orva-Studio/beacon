import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-sections-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("sections name parts of the video: never overlapping, renamed and moved, moved by ripple edits, listed by describe, undone exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 20 });
  const shown = () => core.doc(h).sections.map((s) => [s.name, ticksToSeconds(s.start), ticksToSeconds(s.end)]);
  const empty = JSON.stringify(core.doc(h));
  const demo = (await core.run(h, "section.add", { start: 6, end: 12, name: "Demo" })).results[0] as string;
  const intro = (await core.run(h, "section.add", { start: 0, end: 4, name: "Intro" })).results[0] as string;
  expect(shown()).toEqual([["Intro", 0, 4], ["Demo", 6, 12]]);
  await expect(core.run(h, "section.add", { start: 3, end: 7, name: "Hook" })).rejects.toThrow(`sections can't overlap: "Intro"`);
  await expect(core.run(h, "section.set", { section: intro, end: 6.5 })).rejects.toThrow(`"Demo"`);
  await expect(core.run(h, "section.add", { start: 5, end: 5, name: "Hook" })).rejects.toThrow("ends after it starts");
  await expect(core.run(h, "section.add", { start: 4, end: 6, name: " " })).rejects.toThrow();
  await core.run(h, "section.set", { section: intro, name: "Hook", end: 6 });
  expect(shown()).toEqual([["Hook", 0, 6], ["Demo", 6, 12]]);
  expect(await core.query(h, "project.describe", {})).toContain(`"Demo" 6-12s`);

  // Ripple: cutting 8–10 s shrinks Demo; opening 2 s at 3 s grows Hook and moves Demo on.
  const before = JSON.stringify(core.doc(h));
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 8, end: 10 }] });
  expect(shown()).toEqual([["Hook", 0, 6], ["Demo", 6, 10]]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 5, end: 13 }] });
  expect(shown()).toEqual([["Hook", 0, 5]]);
  await core.undo(h);
  await core.run(h, "timeline.insertSpace", { at: 3, duration: 2 });
  expect(shown()).toEqual([["Hook", 0, 8], ["Demo", 8, 14]]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);

  await core.run(h, "section.remove", { section: demo });
  expect(shown()).toEqual([["Hook", 0, 6]]);
  for (let i = 0; i < 4; i++) await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(empty);
  await core.close(h);
});
