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
