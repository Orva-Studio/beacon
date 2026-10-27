import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const TAKE = join(FIXTURES, "take.brec");
const IMAGE = join(FIXTURES, "image.png");
const VIDEO = join(FIXTURES, "video-3.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-silences-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Stream = { words: { text: string; start: number; end: number }[]; speech: [number, number][] };

/** What the transcript job would have made for `asset`, written where the cache keeps it. */
function transcribed(core: LocalCore, asset: Asset, streams: Record<number, Stream>) {
  const def = core.registry.jobAnalyzers.get("transcript")!;
  const file = new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, def);
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  const full = Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, { model: "test", language: "en", ...s, words: s.words.map((w) => ({ ...w, p: 1 })) }]));
  writeFileSync(file, JSON.stringify({ streams: full }));
}

const SETTINGS = { min: 0.6, keep: 0.3 };

test.skipIf(!existsSync(AUDIO))("Remove Silences cuts nothing while audio heard with a transcribed clip still has no transcript", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-a") });
  const h = await core.create({ path: join(dir, "waiting.beproj") });
  const [a, b] = [join(dir, "a.m4a"), join(dir, "b.m4a")];
  copyFileSync(AUDIO, a);
  copyFileSync(AUDIO, b);
  const ra = await core.import(h, [a], { at: 0 });
  await core.run(h, "track.add", { name: "B" });
  const track = core.doc(h).tracks.find((t) => t.name === "B")!.id;
  const rb = await core.import(h, [b], { at: 0, track });
  for (const j of [...ra.jobs, ...rb.jobs]) await core.cancelJob(j).catch(() => {});
  const doc = core.doc(h);
  const [assetA, assetB] = [doc.assets[ra.assets[0]!]!, doc.assets[rb.assets[0]!]!];
  // A speaks at 0–1 s and 9–10 s; B, heard at the same time, isn't transcribed yet and may speak in between.
  transcribed(core, assetA, { 0: { words: [{ text: "one", start: 0.1, end: 0.9 }, { text: "two", start: 9.1, end: 9.9 }], speech: [[0, 1], [9, 10]] } });
  const before = JSON.stringify(core.doc(h).tracks);
  const plan = (await core.query(h, "transcript.silences", SETTINGS)) as { waiting: string[] };
  expect(plan.waiting).toEqual([assetB.id]);
  await expect(core.run(h, "transcript.removeSilences", SETTINGS)).rejects.toThrow(/transcri/);
  await expect(core.run(h, "transcript.removePauses", {})).rejects.toThrow(/transcri/);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  // Once B's transcript is there (room tone, nothing said), it cuts.
  transcribed(core, assetB, { 0: { words: [], speech: [] } });
  await core.run(h, "transcript.removeSilences", SETTINGS);
  expect(JSON.stringify(core.doc(h).tracks)).not.toBe(before);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("Remove Silences cuts only the silences picked when asked to, and refuses two voices heard at once, naming them, until one is muted", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-pick") });
  const h = await core.create({ path: join(dir, "pick.beproj") });
  const [a, b] = [join(dir, "pa.m4a"), join(dir, "pb.m4a")];
  copyFileSync(AUDIO, a);
  copyFileSync(AUDIO, b);
  const ra = await core.import(h, [a], { at: 0 });
  for (const j of ra.jobs) await core.cancelJob(j).catch(() => {});
  const assetA = core.doc(h).assets[ra.assets[0]!]!;
  // Speech at 0–1, 3–4 and 7–8 s: silences at 1–3 and 4–7 s.
  transcribed(core, assetA, { 0: { words: [{ text: "one", start: 0.1, end: 0.9 }, { text: "two", start: 3.1, end: 3.9 }, { text: "three", start: 7.1, end: 7.9 }], speech: [[0, 1], [3, 4], [7, 8]] } });
  type Found = { silences: { start: number; end: number; selected: boolean }[]; saved: number; selectedSaved: number; stacked?: string };
  const plan = (await core.query(h, "transcript.silences", { ...SETTINGS, selected: [5] })) as Found;
  const inner = plan.silences.filter((x) => x.start >= 0.9 && x.end <= 7.1);
  expect(inner.map((x) => [x.start, x.selected])).toEqual([[1, false], [4, true]]);
  expect(Math.abs(plan.selectedSaved - (3 - 0.3))).toBeLessThan(0.07);
  expect(plan.saved).toBeGreaterThan(plan.selectedSaved);
  const length = () => core.doc(h).tracks.flatMap((t) => t.clips).reduce((n, c) => Math.max(n, c.start + c.duration), 0);
  const before = length();
  await core.run(h, "transcript.removeSilences", { ...SETTINGS, at: [5] });
  expect((before - length()) / 705_600_000).toBeCloseTo(2.7, 1);
  await expect(core.run(h, "transcript.removeSilences", { ...SETTINGS, at: [0.5] })).rejects.toThrow(/no silence over 0.6 s at 0.5/);
  await core.undo(h);

  // In the review, ⇧-clicking anywhere else in a picked silence unpicks it; another silence is added.
  await core.run(h, "silences.review", SETTINGS);
  const picked = async () => ((await core.session(h)).features.transcript as { silences: { selected: number[] } }).silences.selected;
  await core.run(h, "silences.select", { at: 5 });
  await core.run(h, "silences.select", { at: 2, add: true });
  expect(await picked()).toEqual([5, 2]);
  await core.run(h, "silences.select", { at: 6, add: true });
  expect(await picked()).toEqual([2]);
  await core.run(h, "silences.close", {});

  // A second voice over it: refused, both named, nothing cut; muted, it no longer counts.
  await core.run(h, "track.add", { name: "B" });
  const track = core.doc(h).tracks.find((t) => t.name === "B")!.id;
  const rb = await core.import(h, [b], { at: 0, track });
  for (const j of rb.jobs) await core.cancelJob(j).catch(() => {});
  const assetB = core.doc(h).assets[rb.assets[0]!]!;
  // With no transcript yet it holds Remove Silences up while heard; muted, it doesn't.
  const waiting = async () => ((await core.query(h, "transcript.silences", SETTINGS)) as { waiting: string[] }).waiting;
  const quiet = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.assetId === assetB.id)!;
  expect(await waiting()).toContain(assetB.id);
  await core.run(h, "clip.set", { clip: quiet.id, props: { audio: { muted: true } } });
  expect(await waiting()).not.toContain(assetB.id);
  await core.run(h, "clip.set", { clip: quiet.id, props: { audio: { muted: false } } });
  transcribed(core, assetB, { 0: { words: [{ text: "hello", start: 5.1, end: 5.9 }], speech: [[5, 6]] } });
  const stacked = ((await core.query(h, "transcript.silences", SETTINGS)) as Found).stacked;
  expect(stacked).toContain("one voice at a time");
  expect(stacked).toContain('"pa"');
  expect(stacked).toContain('"pb"');
  const tracks = JSON.stringify(core.doc(h).tracks);
  await expect(core.run(h, "transcript.removeSilences", SETTINGS)).rejects.toThrow(/one voice at a time/);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(tracks);
  const clipB = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.assetId === assetB.id)!;
  await core.run(h, "clip.set", { clip: clipB.id, props: { audio: { muted: true } } });
  expect(((await core.query(h, "transcript.silences", SETTINGS)) as Found).stacked).toBeUndefined();
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO) || !existsSync(IMAGE) || !existsSync(VIDEO))("Remove Silences keeps time that shows a picture put there (an image over a pause, a card after the talk), cutting the silence around it; a camera from another file across the talk is cut as usual", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-p") });
  const h = await core.create({ path: join(dir, "pictures.beproj") });
  const audio = join(dir, "talk.m4a");
  copyFileSync(AUDIO, audio);
  const r = await core.import(h, [audio], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, core.doc(h).assets[r.assets[0]!]!, { 0: { words: [{ text: "one", start: 0.1, end: 0.9 }, { text: "two", start: 9.1, end: 9.9 }], speech: [[0, 1], [9, 10]] } });
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const seconds = (ticks: number) => ticks / 705_600_000;
  const talkEnd = Math.max(...clips().map((c) => seconds(c.start + c.duration)));
  await core.run(h, "track.add", { name: "Pictures" });
  const track = core.doc(h).tracks.find((t) => t.name === "Pictures")!.id;
  // A still over the pause, and a card after the talk, each on screen for 5 s.
  await core.import(h, [IMAGE], { at: 3, track });
  await core.import(h, [IMAGE], { at: talkEnd, track });
  // The talk's picture from a camera recorded apart from the microphone: another file, its own sound left out.
  await core.run(h, "track.add", { name: "Camera" });
  const camera = core.doc(h).tracks.find((t) => t.name === "Camera")!.id;
  const rv = await core.import(h, [VIDEO], { at: 0, track: camera });
  for (const j of rv.jobs) await core.cancelJob(j).catch(() => {});
  const own = clips().filter((c) => c.assetId === rv.assets[0] && c.type === "audio").map((c) => c.id);
  if (own.length) await core.run(h, "clip.remove", { clips: own, linked: false });
  expect(seconds(clips().find((c) => c.assetId === rv.assets[0])!.duration)).toBeGreaterThan(10);
  const images = () => clips().filter((c) => c.type === "image");
  expect(images().map((c) => seconds(c.duration))).toEqual([5, 5]);
  await core.run(h, "transcript.removeSilences", SETTINGS);
  // Both still shown for 5 s; the pause around the first is cut down to it (1–3 s and 8–9 s), and the talk's long tail.
  expect(images().map((c) => seconds(c.duration))).toEqual([5, 5]);
  const words = (await core.query(h, "transcript.get", { format: "words" })) as { text: string; start: number }[];
  expect(words.map((w) => w.text)).toEqual(["one", "two"]);
  expect(seconds(images()[0]!.start)).toBeLessThan(2);
  expect(words[1]!.start - seconds(images()[0]!.start + images()[0]!.duration)).toBeLessThan(0.5);
  expect(seconds(images()[1]!.start)).toBeLessThan(11);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO) || !existsSync(IMAGE))("Remove Silences keeps a title card before the talk whole, to the frame, with nothing of the pause kept", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-t") });
  const h = await core.create({ path: join(dir, "title.beproj") });
  const audio = join(dir, "title.m4a");
  copyFileSync(AUDIO, audio);
  const r = await core.import(h, [audio], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, core.doc(h).assets[r.assets[0]!]!, { 0: { words: [{ text: "one", start: 9.1, end: 9.9 }], speech: [[9, 10]] } });
  await core.run(h, "track.add", { name: "Title" });
  const track = core.doc(h).tracks.find((t) => t.name === "Title")!.id;
  // From frame 92 at 30 fps (3.0667 s, between milliseconds) for 5 s, before anything is said.
  await core.import(h, [IMAGE], { at: 92 / 30, track });
  const card = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "image")!;
  const frames = (ticks: number) => Math.round((ticks / 705_600_000) * 30);
  expect([frames(card().start), frames(card().duration)]).toEqual([92, 150]);
  await core.run(h, "transcript.removeSilences", { ...SETTINGS, keep: 0 });
  // The pause before it and after it go; the card stays all 150 frames.
  expect([frames(card().start), frames(card().duration)]).toEqual([0, 150]);
  const words = (await core.query(h, "transcript.get", { format: "words" })) as { text: string; start: number }[];
  expect(words.map((w) => w.text)).toEqual(["one"]);
  expect(words[0]!.start).toBeLessThan(5.5);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(TAKE))("a silence where the cursor moved once, logged by a single sample inside it, is screen action", async () => {
  const take = join(dir, "sparse.brec");
  cpSync(TAKE, take, { recursive: true });
  // A `.brec` logs a position only when it changes: here at the start, then once mid-silence 500 points away.
  writeFileSync(
    join(take, "cursor.jsonl"),
    [
      { display: { h: 1169, w: 1800, x: 0, y: 0 } },
      { t: 0.0004, x: 100, y: 100 },
      { file: "cursor-0.png", height: 400, hotX: 50, hotY: 50, image: 0, scale: 0.1, width: 280 },
      { cursor: 0, t: 0.0004 },
      { t: 1.0, x: 600, y: 100 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const core = new LocalCore({ cacheDir: join(dir, "cache-b") });
  const h = await core.create({ path: join(dir, "sparse.beproj") });
  const r = await core.import(h, [take]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  // Speech at the start and the end of the 2 s take, the microphone's; the system audio says nothing.
  transcribed(core, asset, {
    0: { words: [{ text: "hi", start: 0.05, end: 0.25 }, { text: "bye", start: 1.85, end: 1.95 }], speech: [[0, 0.3], [1.8, 2.0]] },
    1: { words: [], speech: [] },
  });
  const plan = (await core.query(h, "transcript.silences", SETTINGS)) as { waiting: string[]; silences: { start: number; end: number; active: boolean; selected: boolean }[] };
  expect(plan.waiting).toEqual([]);
  const silence = plan.silences.find((s) => s.start < 1 && s.end > 1)!;
  expect(silence).toBeDefined();
  expect([silence.active, silence.selected]).toEqual([true, false]);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("Remove Silences finds a pause split across a cut: the quiet end of one clip and the quiet start of the next, each under the minimum, are one silence", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-cut") });
  const h = await core.create({ path: join(dir, "cut.beproj") });
  const a = join(dir, "cut.m4a");
  copyFileSync(AUDIO, a);
  const r = await core.import(h, [a], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, core.doc(h).assets[r.assets[0]!]!, { 0: { words: [{ text: "one", start: 0.1, end: 0.9 }, { text: "two", start: 3.1, end: 3.9 }], speech: [[0, 1], [3, 4]] } });
  // 1.3–2.7 s cut out: 0.3 s of quiet before the cut, 0.3 s after.
  await core.run(h, "timeline.rippleDelete", { ranges: [{ start: 1.3, end: 2.7 }] });
  const audio = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio");
  expect(audio).toHaveLength(2);
  const plan = (await core.query(h, "transcript.silences", { min: 0.5, keep: 0 })) as { silences: { start: number; end: number }[] };
  const across = plan.silences.find((x) => x.start < 1.3 && x.end > 1.3);
  expect(across).toBeDefined();
  expect(across!.start).toBeCloseTo(1, 1);
  expect(across!.end).toBeCloseTo(1.6, 1);
});
