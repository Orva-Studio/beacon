import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-polish-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RATE = 8000;
/** The file's audio as mono samples at 8 kHz. */
const samples = (path: string) => new Float32Array(Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]).stdout.buffer);
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

test.skipIf(!existsSync(RECORDING))("Polish (de-click, de-clip, de-ess) changes the voice but not its length or timing; one step, and only once per clip", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const range = { from: 0, to: 10 };
  await (await core.export(h, { output: join(dir, "before.wav"), ...range })).done;
  const before = samples(join(dir, "before.wav"));

  const audio = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio").map((c) => c.id);
  await core.run(h, "selection.set", { clips: audio, linked: false });
  const steps = (await core.history(h)).undo.length;
  await core.run(h, "edit.polish", {});
  expect((await core.history(h)).undo.length - steps).toBe(1);
  const polished = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => audio.includes(c.id)).map((c) => c.effects.filter((e) => e.type === "polish"));
  expect(polished().every((fx) => fx.length === 1 && fx[0]!.params.sibilance === 0.2)).toBe(true);
  await expect(core.run(h, "edit.polish", {})).rejects.toThrow(/already polished/);

  await (await core.export(h, { output: join(dir, "after.wav"), ...range })).done;
  const after = samples(join(dir, "after.wav"));
  expect(after.length).toBe(before.length);
  let diff = 0;
  for (let i = 0; i < before.length; i++) diff += Math.abs(before[i]! - after[i]!);
  expect(diff / before.length).toBeGreaterThan(1e-5);
  // Nothing moves: the polished voice lines up with the original to the sample.
  expect(Math.abs(lag(before, after))).toBeLessThanOrEqual(1);

  // Every stage off: the sound as it was.
  for (const c of core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => audio.includes(c.id))) {
    const fx = c.effects.find((e) => e.type === "polish")!;
    await core.run(h, "effect.set", { clip: c.id, effect: fx.id, params: { removeClicks: false, repairClipping: false, sibilance: 0 } });
  }
  await (await core.export(h, { output: join(dir, "off.wav"), ...range })).done;
  expect(Buffer.from(samples(join(dir, "off.wav")).buffer).equals(Buffer.from(before.buffer))).toBe(true);
  await core.close(h);
}, 180_000);

test.skipIf(!existsSync(RECORDING))("a muted clip is out of the mix with its volume kept; unmuted, the sound is back exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-mute") });
  const h = await core.create({ path: join(dir, "m.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const range = { from: 0, to: 5 };
  await (await core.export(h, { output: join(dir, "m-before.wav"), ...range })).done;
  const before = samples(join(dir, "m-before.wav"));
  const audio = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio");
  for (const c of audio) await core.run(h, "clip.set", { clip: c.id, props: { audio: { muted: true } } });
  await (await core.export(h, { output: join(dir, "m-muted.wav"), ...range })).done;
  const muted = samples(join(dir, "m-muted.wav"));
  expect(muted.length).toBe(before.length);
  expect(muted.every((s) => s === 0)).toBe(true);
  for (const c of audio) await core.run(h, "clip.set", { clip: c.id, props: { audio: { muted: false } } });
  await (await core.export(h, { output: join(dir, "m-after.wav"), ...range })).done;
  expect(Buffer.from(samples(join(dir, "m-after.wav")).buffer).equals(Buffer.from(before.buffer))).toBe(true);
  await core.close(h);
}, 120_000);
