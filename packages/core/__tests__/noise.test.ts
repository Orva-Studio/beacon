import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
import { audioPlaybackArgs } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-noise-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RATE = 8000;
/** The file's audio as mono samples at 8 kHz. */
const samples = (path: string) => new Float32Array(Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]).stdout.buffer);
const db = (s: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += s[i]! ** 2;
  return 10 * Math.log10(sum / ((to - from) * RATE) + 1e-12);
};
/** The start of the half second with the least (or most) sound. */
const loudness = (s: Float32Array, pick: (a: number, b: number) => boolean) => {
  let best = 0;
  for (let t = 0; t + 0.5 <= s.length / RATE; t += 0.1) if (pick(db(s, t, t + 0.5), db(s, best, best + 0.5))) best = t;
  return best;
};
/** Where `b` best lines up with `a`, in samples (within ±40 ms). */
const lag = (a: Float32Array, b: Float32Array) => {
  let best = 0;
  let score = -Infinity;
  for (let d = -320; d <= 320; d++) {
    let sum = 0;
    for (let i = 400; i < a.length - 400; i++) sum += a[i]! * (b[i + d] ?? 0);
    if (sum > score) [score, best] = [sum, d];
  }
  return best;
};

test.skipIf(!existsSync(RECORDING))("Noise Removal learns the noise from the in/out range and takes it out of the clip, in step with the original", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const range = { from: 0, to: 10 };
  await (await core.export(h, { output: join(dir, "before.wav"), ...range })).done;
  const before = samples(join(dir, "before.wav"));
  const quiet = loudness(before, (a, b) => a < b);
  const loud = loudness(before, (a, b) => a > b);

  const audio = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio").map((c) => c.id);
  const learned = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => audio.includes(c.id)).map((c) => c.effects.find((e) => e.type === "noise-removal")!.params as { learnFrom: number; learnTo: number });
  await core.run(h, "selection.set", { clips: audio, linked: false });
  // Before the waveform is there, it follows the noise as it goes; with it, it learns the clip's quietest half second.
  await core.run(h, "edit.removeNoise", {});
  expect(learned().every((p) => p.learnTo === p.learnFrom)).toBe(true);
  for (const asset of new Set(core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => audio.includes(c.id)).map((c) => c.assetId!))) await (await core.analyze(h, "waveform", asset)).done;
  await core.run(h, "edit.removeNoise", {});
  expect(learned().every((p) => Math.abs(p.learnTo - p.learnFrom - 0.5) < 0.01)).toBe(true);
  // An in/out range is what it learns from instead.
  await core.run(h, "range.set", { in: quiet, out: quiet + 0.5 });
  await core.run(h, "edit.removeNoise", {});
  expect(learned().every((p) => Math.abs(p.learnFrom - quiet) < 0.05 && Math.abs(p.learnTo - quiet - 0.5) < 0.05)).toBe(true);
  // Applied again it learns again, on the same effect.
  await core.run(h, "edit.removeNoise", { strength: 20 });
  expect(core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => audio.includes(c.id)).every((c) => c.effects.filter((e) => e.type === "noise-removal").length === 1)).toBe(true);
  await core.run(h, "range.clear", {});

  await (await core.export(h, { output: join(dir, "after.wav"), ...range })).done;
  const after = samples(join(dir, "after.wav"));
  expect(after.length).toBe(before.length);
  console.log(`quiet ${db(before, quiet, quiet + 0.5).toFixed(1)} → ${db(after, quiet, quiet + 0.5).toFixed(1)} dB; loud ${db(before, loud, loud + 0.5).toFixed(1)} → ${db(after, loud, loud + 0.5).toFixed(1)} dB`);
  expect(db(after, quiet, quiet + 0.5)).toBeLessThan(db(before, quiet, quiet + 0.5) - 6);
  expect(Math.abs(db(after, loud, loud + 0.5) - db(before, loud, loud + 0.5))).toBeLessThan(3);
  // Nothing moves: the cleaned sound lines up with the original to the sample.
  expect(Math.abs(lag(before, after))).toBeLessThanOrEqual(1);
  await core.close(h);
}, 180_000);

test.skipIf(!existsSync(RECORDING))("each cleaned clip learns its own noise, a range up to a cut takes only the clip it covers, and stacked effects each learn their own", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache2") });
  const h = await core.create({ path: join(dir, "two.beproj") });
  for (let i = 0; i < 2; i++) {
    const r = await core.import(h, [RECORDING]);
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  }
  const audio = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio").sort((a, b) => a.start - b.start);
  const [first] = audio();
  const cut = ticksToSeconds(first!.start + first!.duration);
  const range = { from: cut, to: cut + 10 };
  await (await core.export(h, { output: join(dir, "second-before.wav"), ...range })).done;
  const before = samples(join(dir, "second-before.wav"));
  const quiet = loudness(before, (a, b) => a < b);

  // A range drawn up to the cut, nothing selected: only the clips it runs over, not the ones starting at the cut.
  await core.run(h, "selection.clear", {});
  await core.run(h, "range.set", { in: cut - 0.5, out: cut });
  await core.run(h, "edit.removeNoise", {});
  const cleaned = () => audio().filter((c) => c.effects.some((e) => e.type === "noise-removal"));
  expect(cleaned().every((c) => c.start < first!.start + first!.duration)).toBe(true);
  expect(cleaned().length).toBeGreaterThan(0);

  // Now the second recording too, learning from its own quiet stretch: in one mix, each learns its own.
  await core.run(h, "range.set", { in: cut + quiet, out: cut + quiet + 0.5 });
  await core.run(h, "edit.removeNoise", {});
  await core.run(h, "range.clear", {});
  expect(cleaned().length).toBe(audio().length);
  const args = audioPlaybackArgs(core.doc(h), core.registry, cut - 1, 2).join(" ");
  const names = [...args.matchAll(/afftdn@(\w+)=/g)].map((m) => m[1]);
  expect(new Set(names).size).toBe(names.length);
  await (await core.export(h, { output: join(dir, "second-after.wav"), ...range })).done;
  const after = samples(join(dir, "second-after.wav"));
  expect(after.length).toBe(before.length);
  expect(db(after, quiet, quiet + 0.5)).toBeLessThan(db(before, quiet, quiet + 0.5) - 6);
  expect(Math.abs(lag(before, after))).toBeLessThanOrEqual(1);

  // A second Noise Removal on one clip, with a stretch of its own: two stages, each fed its own lead, in step and whole.
  const one = audio().at(-1)!;
  await core.run(h, "effect.add", { clip: one.id, type: "noise-removal", params: { learnFrom: quiet + 0.1, learnTo: quiet + 0.4, strength: 6 } });
  const stacked = audioPlaybackArgs(core.doc(h), core.registry, cut, 10).join(" ");
  expect(stacked.match(/concat=n=2/g)!.length).toBeGreaterThanOrEqual(2);
  await (await core.export(h, { output: join(dir, "stacked.wav"), ...range })).done;
  const twice = samples(join(dir, "stacked.wav"));
  expect(twice.length).toBe(before.length);
  expect(Math.abs(lag(before, twice))).toBeLessThanOrEqual(1);
  await core.close(h);
}, 240_000);
