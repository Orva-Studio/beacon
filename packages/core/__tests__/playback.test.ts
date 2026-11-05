import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AudioOutput } from "@beacon/media";
import { DEFAULT_CACHE_DIR } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const SMALL = join(FIXTURES, "small.cmproj");
const dir = mkdtempSync(join(tmpdir(), "ot-playback-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The cache moved from ~/Library/Caches/opentasia to .../Beacon with its proxy records still
// pointing at the old folder, and playing drew nothing while the playhead moved (2026-10-13).
test.skipIf(!existsSync(SMALL))(
  "playing draws frames when proxy records point at a moved cache or at files that can't be read",
  async () => {
    const cache = join(dir, "cache");
    mkdirSync(join(cache, "derived"), { recursive: true });
    mkdirSync(join(cache, "proxies"), { recursive: true });
    for (const f of readdirSync(DEFAULT_CACHE_DIR)) if (f.startsWith("frames-")) cpSync(join(DEFAULT_CACHE_DIR, f), join(cache, f));

    const core = new LocalCore({ cacheDir: cache });
    const h = await core.create({ path: join(dir, "small.beproj"), cmproj: SMALL });
    const doc = core.doc(h);
    const def = core.registry.jobAnalyzers.get("proxy")!;
    const records: string[] = [];
    for (const asset of Object.values(doc.assets)) {
      if (!def.applies(asset)) continue;
      const key = new Bun.CryptoHasher("sha256").update(`${asset.path}\0${asset.fingerprint}`).digest("hex").slice(0, 16);
      const videos = (asset.derived.media as { streams: { kind: string }[] }).streams.filter((s) => s.kind === "video");
      const streams = Object.fromEntries(
        videos.map((_, i) => {
          const name = `${key}-v${i}.hevc.mp4`;
          // Moved into the new cache folder, but empty: it can't be decoded either.
          writeFileSync(join(cache, "proxies", name), "");
          return [i, { path: join(dir, "old-cache/proxies", name), factor: 0.5 }];
        }),
      );
      const record = join(cache, "derived", `proxy-v${def.version}-${key}.json`);
      writeFileSync(record, JSON.stringify({ streams, audio: {} }));
      records.push(record);
    }
    expect(records.length).toBeGreaterThan(0);

    const view = core.attachView(h, { offscreen: { width: 640, height: 360 } }, { silent: true, proxies: false });
    view.show(10);
    view.flush();
    // Only records of what is on screen are read.
    expect(records.filter((r) => readFileSync(r, "utf8").includes(join(cache, "proxies"))).length).toBeGreaterThan(0);

    const before = view.stats()!;
    view.play(10);
    await Bun.sleep(2000);
    view.pause();
    const after = view.stats()!;
    expect(after.shown - before.shown).toBeGreaterThan(45);
    expect(after.seq).toBeGreaterThan(before.seq + 45);
    core.detachView(h);
    await core.close(h);
  },
  120_000,
);

test("the audio clock says how far ahead of what is heard its sound has gone, so a new speed doesn't repeat it", async () => {
  const out = new AudioOutput();
  try {
    // An empty mix plays silence, so nothing is heard, but the device's clock and latency are real.
    out.play([], 10);
    await Bun.sleep(300);
    const heard = out.time()!;
    const sent = out.halt()!;
    expect(heard).toBeGreaterThan(10);
    expect(sent).toBeGreaterThanOrEqual(heard);
    expect(sent - heard).toBeLessThan(1);
    // Halting stopped it.
    expect(out.time()).toBeUndefined();
    expect(out.halt()).toBeUndefined();
  } finally {
    out.close();
  }
});

test("a seek while playing starts where it says, even close to where playback was", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "seek-cache") });
  const h = await core.create({ path: join(dir, "seek.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 5 });
  const view = core.attachView(h, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: false });
  try {
    view.play(1, 1);
    await Bun.sleep(300);
    // 0.2 s back, within what a change of speed would treat as "where playback is".
    view.play(1.1, 1);
    await Bun.sleep(60);
    const playhead = (await core.session(h)).playhead;
    expect(playhead).toBeGreaterThanOrEqual(1.1);
    expect(playhead).toBeLessThan(1.25);
  } finally {
    view.pause();
    view.close();
    await core.close(h);
  }
});

const AUDIO = join(FIXTURES, "audio.m4a");

/** A mix's output as the device takes it: f32 stereo at 48 kHz. */
async function mixed(args: string[]): Promise<Float32Array> {
  const p = Bun.spawn([...args, "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"], { stdout: "pipe", stderr: "ignore" });
  const buf = Buffer.from(await new Response(p.stdout).arrayBuffer());
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

// From the start of a rough-cut talk, one mix opened all 126 of its pieces before a sound (~0.4 s; the user, 2026-11-02).
test.skipIf(!existsSync(AUDIO))("playback's sound starts from a short mix of the next seconds, the rest joined on at its last sample", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "chain-cache") });
  const h = await core.create({ path: join(dir, "chain.beproj") });
  const r = await core.import(h, [AUDIO], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  // A rough cut: 60 pieces.
  await core.run(h, "timeline.rippleDelete", { ranges: Array.from({ length: 59 }, (_, i) => ({ start: 3 * i + 2.5, end: 3 * i + 3 })).reverse() });
  const doc = core.doc(h);
  const { audioPlaybackArgs, audioPlaybackChain } = await import("@beacon/render");
  const { evaluateAudio } = await import("@beacon/model");
  expect(evaluateAudio(doc, core.registry).length).toBe(60);
  const inputs = (args: string[]) => args.filter((a) => a === "-i").length;
  const one = audioPlaybackArgs(doc, core.registry, 0, 40);
  const chain = audioPlaybackChain(doc, core.registry, 0, 40);
  expect(inputs(one)).toBe(16);
  expect(chain.map(inputs)).toEqual([4, 12]);
  const whole = await mixed(one);
  const parts = await Promise.all(chain.map(mixed));
  expect(parts.map((p) => p.length / 2)).toEqual([480_000, 1_440_000]);
  const joined = new Float32Array(whole.length);
  joined.set(parts[0]!);
  joined.set(parts[1]!, parts[0]!.length);
  // The same sound, but for the resampler's edges (a 44.1 kHz file played at 48 kHz) within 16 samples of the join, far under hearing.
  const seam = parts[0]!.length;
  for (let i = 0; i < whole.length; i++) {
    const d = Math.abs(joined[i]! - whole[i]!);
    if (d > 1e-6) {
      expect(Math.abs(i - seam)).toBeLessThanOrEqual(34);
      expect(d).toBeLessThan(0.003);
    }
  }
  // Nothing heard in the first seconds: those are silence as long as they are, so the rest isn't heard early.
  await core.run(h, "clip.move", { clip: core.doc(h).tracks[0]!.clips[0]!.id, start: 12, ripple: true });
  const late = audioPlaybackChain(core.doc(h), core.registry, 0, 30);
  expect(inputs(late[0]!)).toBe(0);
  const [hush, rest] = await Promise.all(late.map(mixed));
  expect(hush!.length / 2).toBe(480_000);
  expect(hush!.every((v) => v === 0)).toBe(true);
  expect(rest!.length / 2).toBe(960_000);
  await core.close(h);

  // The device plays a chain one mix after the other (silence here: nothing heard).
  const quiet = late[0]!.slice(0, -1).concat("0.3");
  const out = new AudioOutput();
  try {
    out.play([quiet, quiet], 0);
    await Bun.sleep(500);
    expect(out.time()!).toBeGreaterThan(0.1);
    expect(out.heard()!.stalled).toBe(0);
  } finally {
    out.close();
  }
}, 60_000);

// Sound on its way to the speakers when Space paused was heard again from the paused frame on the next play (the user, 2026-11-02).
test("a pause stops the playhead where the sound stopped, not where the picture was, so playing on doesn't repeat it", async () => {
  // The device's latency: what is sent but not yet heard.
  const out = new AudioOutput();
  out.play([], 0);
  await Bun.sleep(300);
  const heard = out.time()!;
  const latency = out.halt()! - heard;
  out.close();

  const core = new LocalCore({ cacheDir: join(dir, "pause-cache") });
  const h = await core.create({ path: join(dir, "pause.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 10 });
  const view = core.attachView(h, { offscreen: { width: 320, height: 180 } }, { proxies: false });
  view.muted = true;
  try {
    await core.run(h, "playhead.set", { time: 1 });
    await core.run(h, "playback.play", {});
    await Bun.sleep(800);
    const shown = (await core.session(h)).playhead;
    await core.run(h, "playback.pause", {});
    const paused = (await core.session(h)).playhead;
    // A frame or so may tick by between reading the playhead and pausing.
    expect(paused - shown).toBeGreaterThanOrEqual(latency - 0.04);
    expect(paused - shown).toBeLessThan(latency + 0.08);
    expect(view.playing).toBe(false);
  } finally {
    view.close();
    await core.close(h);
  }
}, 60_000);
