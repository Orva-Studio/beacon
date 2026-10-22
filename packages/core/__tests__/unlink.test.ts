import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-unlink-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(TAKE))("Unlink Recording unlinks every selected recording, not only the first, in one undo", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "unlink.beproj") });
  const placed: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await core.import(h, [TAKE]);
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
    placed.push(...r.clips);
  }
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => placed.includes(c.id));
  const linked = clips().filter((c) => c.linkId);
  expect(new Set(linked.map((c) => c.linkId)).size).toBe(2);
  const before = structuredClone(core.doc(h));

  await core.run(h, "selection.set", { clips: linked.map((c) => c.id), linked: false });
  await core.run(h, "edit.unlink", {});
  expect(clips().filter((c) => c.linkId)).toEqual([]);
  expect(await core.undo(h)).toBe("Unlink Recording");
  expect(core.doc(h)).toEqual(before);
});

test.skipIf(!existsSync(TAKE))("Delete Audio and Delete Video take that part of a recording, linked or already unlinked, keeping the rest in place, one undo step each", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-part") });
  const h = await core.create({ path: join(dir, "part.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => r.clips.includes(c.id));
  const kinds = () => clips().map((c) => c.type).sort();
  const audio = clips().find((c) => c.type === "audio")!;
  const before = structuredClone(core.doc(h));
  const all = kinds();
  expect(all.filter((k) => k === "audio").length).toBeGreaterThan(0);

  // Linked: a click on its audio selects it with its camera, and Delete Video leaves only the sound of the two; the screen, never linked, stays.
  const together = clips().filter((c) => c.linkId && c.linkId === audio.linkId);
  expect(together.some((c) => core.registry.hasTrait(c.type, "video"))).toBe(true);
  await core.run(h, "selection.set", { clips: [audio.id] });
  await core.run(h, "edit.deleteVideo", {});
  expect(clips().filter((c) => c.linkId === audio.linkId).every((c) => c.type === "audio")).toBe(true);
  expect(clips().some((c) => c.type === "screen")).toBe(all.includes("screen"));
  expect(clips().find((c) => c.id === audio.id)!.start).toBe(audio.start);
  expect(await core.undo(h)).toBe("Delete Video");
  expect(core.doc(h)).toEqual(before);
  await core.run(h, "selection.set", { clips: [audio.id] });
  await core.run(h, "edit.deleteAudio", {});
  expect(clips().some((c) => c.type === "audio")).toBe(false);
  expect(clips().length).toBe(all.length - all.filter((k) => k === "audio").length);
  expect(await core.undo(h)).toBe("Delete Audio");

  // Unlinked first, the clicked clip alone is what it reads: its audio can't be deleted from the picture.
  await core.run(h, "selection.set", { clips: [audio.id] });
  await core.run(h, "edit.unlink", {});
  const picture = clips().find((c) => core.registry.hasTrait(c.type, "video"))!;
  await core.run(h, "selection.set", { clips: [picture.id] });
  await expect(core.run(h, "edit.deleteAudio", {})).rejects.toThrow(/no audio to delete/);
  await expect(core.run(h, "edit.deleteVideo", {})).rejects.toThrow(/all picture/);
  await core.close(h);
});
