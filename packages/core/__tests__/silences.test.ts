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

const SETTINGS = { min: 0.6, keep: 0.3, keepActive: true, flipped: [] };

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
  // Once B's transcript is there, it cuts.
  transcribed(core, assetB, { 0: { words: [{ text: "three", start: 0.2, end: 0.8 }], speech: [[0, 1]] } });
  await core.run(h, "transcript.removeSilences", SETTINGS);
  expect(JSON.stringify(core.doc(h).tracks)).not.toBe(before);
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

test.skipIf(!existsSync(TAKE))("a silence where the cursor moved once, logged by a single sample inside it, is screen action and kept", async () => {
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
  const plan = (await core.query(h, "transcript.silences", SETTINGS)) as { waiting: string[]; silences: { start: number; end: number; active: boolean; cut: boolean }[] };
  expect(plan.waiting).toEqual([]);
  const silence = plan.silences.find((s) => s.start < 1 && s.end > 1)!;
  expect(silence).toBeDefined();
  expect([silence.active, silence.cut]).toEqual([true, false]);
  await core.close(h);
}, 60_000);
