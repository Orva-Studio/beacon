import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { audioPlaybackArgs } from "@beacon/render";
import { LocalCore, ticksToSeconds } from "../src";

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

const rate = (path: string) =>
  Number(Bun.spawnSync([tool("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path]).stdout.toString().trim());

test.skipIf(!existsSync(RECORDING))("the audio alone exports as .wav, .m4a and .mp3, sounding as the video's export does", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const range = { from: 1, to: 4 };
  // Each clip's delay into the mix is exact, not rounded to a millisecond (one 30 fps frame: 33.3333 ms).
  expect(audioPlaybackArgs(core.doc(h), core.registry, -1 / 30, 1).join(" ")).toContain("adelay=delays=33.3333:all=1");
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

  // MP3 stops at 48 kHz: a 96 kHz project is resampled for it, while .wav keeps 96 kHz.
  await core.run(h, "project.settings.set", { sampleRate: 96000 });
  for (const format of ["mp3", "wav"] as const) await (await core.export(h, { output: join(dir, `hi.${format}`), ...range })).done;
  expect(rate(join(dir, "hi.mp3"))).toBe(48000);
  expect(rate(join(dir, "hi.wav"))).toBe(96000);
  await core.run(h, "project.settings.set", { sampleRate: 48000 });

  // A range with nothing to hear (every track muted) is that much silence, not a failure.
  for (const t of core.doc(h).tracks) await core.run(h, "track.set", { track: t.id, muted: true });
  await (await core.export(h, { output: join(dir, "silent.wav"), ...range })).done;
  const silent = listen(join(dir, "silent.wav"));
  expect(silent.seconds).toBeCloseTo(3, 1);
  expect(silent.mean).toBeLessThan(-80);
  await core.close(h);
}, 120000);

test.skipIf(!existsSync(RECORDING))("exporting clips (the selection) plays only those, over their span", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "clips.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clips = core.doc(h).tracks.flatMap((t) => t.clips);
  const audio = clips.find((c) => c.type === "audio")!;
  const screen = clips.find((c) => c.type === "screen")!;
  // Split, so the selection is a piece that starts later than the timeline.
  await core.run(h, "clip.split", { at: 2, clips: [audio.id], linked: false });
  const piece = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "audio" && c.id !== audio.id)!;
  await (await core.export(h, { output: join(dir, "piece.wav"), clips: [piece.id] })).done;
  const heard = listen(join(dir, "piece.wav"));
  expect(heard.seconds).toBeCloseTo(ticksToSeconds(piece.duration), 1);
  expect(heard.mean).toBeGreaterThan(-60);
  // The screen alone has nothing to hear: the recording's audio is left out.
  await (await core.export(h, { output: join(dir, "screen.wav"), clips: [screen.id], from: 3, to: 5 })).done;
  expect(listen(join(dir, "screen.wav")).mean).toBeLessThan(-80);
  await expect(core.export(h, { output: join(dir, "x.wav"), clips: ["clip-nope"] })).rejects.toThrow('no clip "clip-nope" on the timeline');
  // Inside a group, the piece alone: the group keeps only it.
  await core.run(h, "clip.group", { clips: [piece.id, screen.id] });
  await (await core.export(h, { output: join(dir, "grouped.wav"), clips: [piece.id] })).done;
  const grouped = listen(join(dir, "grouped.wav"));
  expect(grouped.seconds).toBeCloseTo(ticksToSeconds(piece.duration), 1);
  expect(Math.abs(grouped.mean - heard.mean)).toBeLessThan(0.5);
  core.closeAll();
});
