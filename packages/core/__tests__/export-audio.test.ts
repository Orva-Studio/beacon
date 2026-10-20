import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-export-audio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The first audio stream's codec and duration, and its mean loudness in dB. */
function listen(path: string) {
  const r = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path]);
  const j = JSON.parse(r.stdout.toString()) as { streams: { codec_name: string }[]; format: { duration: string } };
  const v = Bun.spawnSync([tool("ffmpeg"), "-hide_banner", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
  const video = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", path]).stdout.toString().trim();
  return { codec: j.streams[0]?.codec_name, seconds: Number(j.format.duration), mean: Number(/mean_volume: (-?[\d.]+) dB/.exec(v)?.[1]), video: video !== "" };
}

test.skipIf(!existsSync(RECORDING))("the audio alone exports as .wav, .m4a and .mp3, sounding as the video's export does", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const range = { from: 1, to: 4 };
  await (await core.export(h, { output: join(dir, "video.mp4"), ...range })).done;
  const reference = listen(join(dir, "video.mp4"));

  for (const [format, codec] of [["wav", "pcm_s16le"], ["m4a", "aac"], ["mp3", "mp3"]] as const) {
    const out = join(dir, `audio.${format}`);
    const job = await core.export(h, { output: out, ...range });
    expect((await job.done) as { frames: number }).toMatchObject({ frames: 0 });
    const heard = listen(out);
    expect(heard).toMatchObject({ codec, video: false });
    expect(heard.seconds).toBeCloseTo(3, 1);
    expect(Math.abs(heard.mean - reference.mean)).toBeLessThan(0.5);
  }
  await expect(core.export(h, { output: join(dir, "none.wav"), audio: false })).rejects.toThrow("can't be exported without audio");
  await core.close(h);
}, 120000);
