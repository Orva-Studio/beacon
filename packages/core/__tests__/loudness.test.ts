import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-loudness-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ffmpeg = (args: string[]) => Bun.spawnSync([tool("ffmpeg"), "-nostdin", "-hide_banner", ...args]).stderr.toString();
const peak = (path: string) => Number(/max_volume: (-?[\d.]+) dB/.exec(ffmpeg(["-i", path, "-af", "volumedetect", "-f", "null", "-"]))![1]);
const lufs = (path: string) => Number([...ffmpeg(["-i", path, "-af", "ebur128", "-f", "null", "-"]).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)![1]);

// A microphone recorded at -52.6 LUFS was raised 35 dB to the -18 target and clipped in the export, its room noise
// raised with it (2026-11-06).
test.skipIf(!existsSync(AUDIO))("Auto-normalize raises a quiet recording at most 20 dB, and the mix never clips", async () => {
  const quiet = join(dir, "quiet.wav");
  ffmpeg(["-i", AUDIO, "-t", "20", "-af", "volume=-36dB", "-ar", "48000", quiet]);
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  try {
    const h = await core.create({ path: join(dir, "p.beproj") });
    const r = await core.import(h, [quiet], { at: 0 });
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
    const clip = r.clips[0]!;
    const measured = (Object.values(core.doc(h).assets)[0]!.derived.loudness as Record<number, number>)[0]!;
    expect(measured).toBeLessThan(-18 - 20);

    // Levelled 20 dB, not all the way to -18: it plays under the target.
    await core.run(h, "clip.set", { clip, props: { audio: { normalize: true } } });
    const levelled = join(dir, "levelled.wav");
    await (await core.export(h, { output: levelled })).done;
    expect(Math.abs(lufs(levelled) - (measured + 20))).toBeLessThan(1);
    expect(peak(levelled)).toBeLessThanOrEqual(-0.9);

    // Pushed far over full scale by its own gain: the limiter holds it under -1 dBFS.
    await core.run(h, "clip.set", { clip, props: { audio: { gain: 10 } } });
    const loud = join(dir, "loud.wav");
    await (await core.export(h, { output: loud })).done;
    expect(peak(loud)).toBeLessThanOrEqual(-0.9);
    expect(lufs(loud)).toBeGreaterThan(lufs(levelled) + 5);

    // Under the limit, nothing changes: the clip at its own level comes out as it went in.
    await core.run(h, "clip.set", { clip, props: { audio: { gain: 1, normalize: false } } });
    const plain = join(dir, "plain.wav");
    await (await core.export(h, { output: plain })).done;
    expect(Math.abs(peak(plain) - peak(quiet))).toBeLessThan(0.2);
  } finally {
    core.closeAll();
  }
}, 120_000);
