import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds, type Project } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-ripple-links-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Each link group's clips start together, as they were placed. */
function lined(doc: Project) {
  const starts = new Map<string, Set<number>>();
  for (const c of doc.tracks.flatMap((t) => t.clips)) if (c.linkId) starts.set(c.linkId, (starts.get(c.linkId) ?? new Set()).add(c.start));
  return [...starts.values()].every((s) => s.size === 1);
}

async function twoTakes(name: string) {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, `${name}.beproj`) });
  const takes: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const r = await core.import(h, [TAKE]);
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
    takes.push(r.clips);
  }
  const clip = (id: string) => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  const of = (take: number, type: string) => takes[take]!.map(clip).find((c) => c.type === type)!;
  return { core, h, of, take: (i: number) => takes[i]!.map(clip) };
}

test.skipIf(!existsSync(TAKE))("a ripple removal moves later linked clips on other tracks with their partners, or holds them all back", async () => {
  const { core, h, of, take } = await twoTakes("remove");
  const audio = of(0, "audio");
  const later = of(1, "audio").start;
  expect(of(1, "video").linkId).toBe(of(1, "audio").linkId);
  await core.run(h, "clip.unlink", { clips: [audio.id] });
  const before = structuredClone(core.doc(h));

  // The first take's camera still covers its time on its track: the second take's audio can't move without its camera.
  await core.run(h, "clip.remove", { clip: audio.id, ripple: true });
  expect(lined(core.doc(h))).toBe(true);
  expect(of(1, "audio").start).toBe(later);
  await core.undo(h);
  expect(core.doc(h)).toEqual(before);

  // With the rest of the first take gone first (a gap left), the second moves back by the take's length, all of it.
  await core.run(h, "clip.remove", { clips: take(0).filter((c) => c.id !== audio.id && c.type !== "screen").map((c) => c.id) });
  await core.run(h, "clip.remove", { clip: audio.id, ripple: true });
  expect(lined(core.doc(h))).toBe(true);
  expect(of(1, "audio").start).toBe(later - audio.duration);
  expect(of(1, "video").start).toBe(later - audio.duration);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(TAKE))("a ripple delete of a range cuts a disabled track's linked clips with the rest, and a locked one refuses it", async () => {
  const { core, h, of } = await twoTakes("range");
  const camera = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === of(0, "video").id))!;
  const take = of(0, "audio");
  const range = { start: ticksToSeconds(take.start) + 1, end: ticksToSeconds(take.start) + 2 };
  await core.run(h, "track.set", { track: camera.id, hidden: true });
  const before = structuredClone(core.doc(h));
  await core.run(h, "timeline.rippleDelete", { ranges: [range] });
  expect(lined(core.doc(h))).toBe(true);
  expect(of(1, "video").start).toBe(of(1, "audio").start);
  await core.undo(h);
  expect(core.doc(h)).toEqual(before);

  await core.run(h, "track.set", { track: camera.id, hidden: false, locked: true });
  await expect(core.run(h, "timeline.rippleDelete", { ranges: [range] })).rejects.toThrow("is locked");
  await core.close(h);
}, 60_000);
