import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-fillers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Said = { text: string; start: number; end: number };

/** What the transcript job would have made for `asset`, written where the cache keeps it. */
function transcribed(core: LocalCore, asset: Asset, words: Said[], speech: [number, number][]) {
  const def = core.registry.jobAnalyzers.get("transcript")!;
  const file = new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, def);
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(file, JSON.stringify({ streams: { 0: { model: "test", language: "en", words: words.map((w) => ({ ...w, p: 1 })), speech } } }));
}

test.skipIf(!existsSync(AUDIO))("Remove Filler Words never cuts into a kept word: an edge that rounding to whole frames would take into one goes to the filler's side", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "edges.beproj") });
  const audio = join(dir, "talk.m4a");
  copyFileSync(AUDIO, audio);
  const r = await core.import(h, [audio], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  // As Whisper wrote one of the user's takes at 30 fps: "uh," touching both neighbours, its edges between frames;
  // and an "um" a few milliseconds from each, whose pause rounded out would reach the word after.
  const words: Said[] = [
    { text: "Is", start: 0.5, end: 0.93 },
    { text: "top,", start: 0.93, end: 1.35 },
    { text: "uh,", start: 1.35, end: 1.79 },
    { text: "padding?", start: 1.79, end: 2.23 },
    { text: "so", start: 3.0, end: 3.405 },
    { text: "um", start: 3.415, end: 3.8 },
    { text: "the", start: 3.81, end: 4.2 },
  ];
  transcribed(core, core.doc(h).assets[r.assets[0]!]!, words, [[0.5, 2.23], [3.0, 4.2]]);
  const before = JSON.stringify(core.doc(h).tracks);
  const cuts = (await core.run(h, "transcript.removeFillers", {})).results[0] as { start: number; end: number }[];
  expect(cuts.length).toBe(2);
  const kept = words.filter((w) => !["uh,", "um"].includes(w.text));
  for (const c of cuts) for (const w of kept) expect(c.end <= w.start + 1e-3 || c.start >= w.end - 1e-3).toBe(true);
  const left = (await core.query(h, "transcript.get", { format: "words" })) as Said[];
  expect(left.map((w) => w.text)).toEqual(kept.map((w) => w.text));
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("Remove Filler Words keeps a short word a sliver of a clip would have taken, and words a transcriber wrote overlapping a filler", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-b") });
  const h = await core.create({ path: join(dir, "slivers.beproj") });
  const audio = join(dir, "short.m4a");
  copyFileSync(AUDIO, audio);
  const r = await core.import(h, [audio], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  // "I" in the first frame before an "um"; "a" two frames wide between "um" and "uh"; "yes" running into an "um".
  const words: Said[] = [
    { text: "I", start: 0, end: 0.03 },
    { text: "um", start: 0.04, end: 0.5 },
    { text: "so", start: 0.6, end: 1.0 },
    { text: "um", start: 1.0, end: 1.3 },
    { text: "a", start: 1.31, end: 1.35 },
    { text: "uh", start: 1.36, end: 1.6 },
    { text: "next", start: 2.0, end: 2.4 },
    { text: "yes", start: 2.5, end: 3.2 },
    { text: "um", start: 3.0, end: 3.5 },
    { text: "ok", start: 3.8, end: 4.2 },
  ];
  transcribed(core, core.doc(h).assets[r.assets[0]!]!, words, [[0, 1.6], [2.0, 2.4], [2.5, 4.2]]);
  const before = JSON.stringify(core.doc(h).tracks);
  const cuts = (await core.run(h, "transcript.removeFillers", {})).results[0] as { start: number; end: number }[];
  const kept = words.filter((w) => !["um", "uh"].includes(w.text));
  for (const c of cuts) for (const w of kept) expect(c.end <= w.start + 1e-3 || c.start >= w.end - 1e-3).toBe(true);
  const left = (await core.query(h, "transcript.get", { format: "words" })) as Said[];
  expect(left.map((w) => w.text)).toEqual(kept.map((w) => w.text));
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 60_000);
