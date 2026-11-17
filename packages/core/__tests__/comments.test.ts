import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-comments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("comments over a stretch or at a moment: overlapping each other and sections, edited, moved by ripple edits and space, listed by describe, jumped to, undone exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 20 });
  const shown = () => core.doc(h).comments.map((c) => [c.text, ticksToSeconds(c.start), c.end === undefined ? null : ticksToSeconds(c.end)]);
  const empty = JSON.stringify(core.doc(h));
  await core.run(h, "section.add", { start: 0, end: 12, name: "Demo" });
  const zoom = (await core.run(h, "comment.add", { start: 2, end: 8, text: "zoom in" })).results[0] as string;
  await core.run(h, "comment.add", { start: 4, end: 10, text: "add a caption" });
  const pin = (await core.run(h, "comment.add", { start: 9, text: "check the audio" })).results[0] as string;
  expect(shown()).toEqual([["zoom in", 2, 8], ["add a caption", 4, 10], ["check the audio", 9, null]]);
  await expect(core.run(h, "comment.add", { start: 5, end: 5, text: "x" })).rejects.toThrow("ends after it starts");
  expect(await core.query(h, "project.describe", {})).toContain(`${pin} 9s "check the audio"`);

  // Edited, moved, and made a moment.
  await core.run(h, "comment.set", { comment: zoom, text: "zoom in on the button", start: 1 });
  await core.run(h, "comment.set", { comment: zoom, end: null });
  expect(shown()[0]).toEqual(["zoom in on the button", 1, null]);
  await core.undo(h);
  await core.undo(h);

  // ⇧M's action adds one at the playhead; the playhead jumps between them.
  await core.run(h, "playhead.set", { time: 0 });
  await core.run(h, "playhead.jump", { to: "nextComment" });
  expect((await core.session(h)).playhead).toBe(2);
  await core.run(h, "playhead.jump", { to: "nextComment" });
  expect((await core.session(h)).playhead).toBe(4);

  // Ripple: cutting 3–5 s shrinks the stretches; one at a moment inside a cut goes, with space closed it stays.
  const before = JSON.stringify(core.doc(h));
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 3, end: 5 }] });
  expect(shown()).toEqual([["zoom in", 2, 6], ["add a caption", 3, 8], ["check the audio", 7, null]]);
  await core.undo(h);
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 8.5, end: 9.5 }] });
  expect(shown()).toEqual([["zoom in", 2, 8], ["add a caption", 4, 9]]);
  await core.undo(h);
  await core.run(h, "timeline.insertSpace", { at: 3, duration: 2 });
  expect(shown()).toEqual([["zoom in", 2, 10], ["add a caption", 6, 12], ["check the audio", 11, null]]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);

  await core.run(h, "comment.remove", { comment: pin });
  expect(shown()).toHaveLength(2);
  while (JSON.stringify(core.doc(h)) !== empty && (await core.history(h)).undo.length > 1) await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(empty);
  await core.close(h);
});
