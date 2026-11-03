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

// Shift-dragging an end to the right kept the gap after it, pushing the next clips along (the user, 2026-11-02).
test.skipIf(!existsSync(TAKE))("a ripple trim lengthening an end fills the gap after it first, then pushes what is after, linked clips in step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "fill.beproj") });
  const r = await core.import(h, [TAKE]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  // A gap from 0.6 s to 1 s on every track (the take is 1.93 s).
  await core.run(h, "timeline.deleteRanges", { ranges: [{ start: 0.6, end: 1 }] });
  const before = structuredClone(core.doc(h));
  const pieces = (type: string) => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === type).sort((a, b) => a.start - b.start);
  const spans = (t: { clips: { start: number; duration: number }[] }) => [...t.clips].sort((a, b) => a.start - b.start).map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)]);
  /** The camera's track and both of its sound's (microphone and system audio), each read on its own. */
  const linkedTracks = () => core.doc(h).tracks.filter((t) => t.clips.some((c) => c.linkId)).map(spans);
  const video = pieces("video")[0]!;
  expect(video.linkId).toBeDefined();
  // Halfway into the gap: nothing after it moves.
  const next = ticksToSeconds(pieces("video")[1]!.duration);
  await core.run(h, "clip.trim", { clip: video.id, end: 0.8, ripple: true });
  expect(linkedTracks().length).toBe(3);
  for (const t of linkedTracks()) expect(t).toEqual([[0, 0.8], [1, 1 + next]]);
  // Past it: the gap is filled, and what is after moves on by the rest, in step.
  await core.run(h, "clip.trim", { clip: video.id, end: 1.2, ripple: true });
  for (const t of linkedTracks()) expect(t).toEqual([[0, 1.2], [1.2, 1.2 + next]]);
  expect(lined(core.doc(h))).toBe(true);
  // Shortening still pulls what is after back with it.
  await core.run(h, "clip.trim", { clip: video.id, end: 1.1, ripple: true });
  for (const t of linkedTracks()) expect(t[1]![0]).toBe(1.1);
  for (let i = 0; i < 3; i++) await core.undo(h);
  expect(core.doc(h)).toEqual(before);
  await core.close(h);
});

test.skipIf(!existsSync(TAKE))("a cut never leaves a sliver: a piece under half a second it would leave goes with it, on every track, in one undo step", async () => {
  const { core, h, of, take } = await twoTakes("slivers");
  const end = ticksToSeconds(of(0, "audio").start + of(0, "audio").duration);
  const before = structuredClone(core.doc(h));
  // Leaves the first take's last 0.2 s: gone with the cut, so the second take follows its first 0.5 s.
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 0.5, end: end - 0.2 }] });
  for (const c of take(0)) expect(ticksToSeconds(c.duration)).toBeCloseTo(0.5, 2);
  expect(ticksToSeconds(of(1, "audio").start)).toBeCloseTo(0.5, 2);
  expect(lined(core.doc(h))).toBe(true);
  await core.undo(h);
  expect(core.doc(h)).toEqual(before);
});

test.skipIf(!existsSync(TAKE))("a clip has one effect of a type: adding it again changes the one it has, and unstitching keeps the stitched clip's", async () => {
  const { core, h, of } = await twoTakes("one-effect");
  const video = () => of(0, "video");
  const first = (await core.run(h, "effect.add", { clip: video().id, type: "round-corners", params: { radius: 20 } })).results[0] as string;
  const again = (await core.run(h, "effect.add", { clip: video().id, type: "round-corners", params: { radius: 8 } })).results[0] as string;
  expect(again).toBe(first);
  expect(video().effects.filter((e) => e.type === "round-corners").map((e) => e.params.radius)).toEqual([8]);

  // Split, both pieces carry it; stitched, the stitched clip gets its own; unstitched, each piece has one.
  await core.run(h, "clip.unlink", { clips: [video().id] });
  const id = video().id;
  await core.run(h, "clip.split", { at: ticksToSeconds(video().start) + 1, clips: [id] });
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === id))!;
  const halves = track.clips.filter((c) => c.assetId === video().assetId).slice(0, 2).map((c) => c.id);
  const stitched = (await core.run(h, "clip.stitch", { clips: halves })).results[0] as string;
  await core.run(h, "effect.add", { clip: stitched, type: "round-corners", params: { radius: 30 } });
  const pieces = (await core.run(h, "clip.unstitch", { clip: stitched })).results[0] as string[];
  const clips = core.doc(h).tracks.flatMap((t) => t.clips);
  for (const id of pieces) expect(clips.find((c) => c.id === id)!.effects.filter((e) => e.type === "round-corners").map((e) => e.params.radius)).toEqual([30]);
});
