import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, tool, type MediaInfo } from "@beacon/media";
import { asAuthor, LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-recording-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(TAKE))("a take whose microphone stopped saving at once still imports its screen, camera and system audio, and says so", async () => {
  // As a wireless microphone's left one: its writer failed after two buffers, 0.01 s of sound.
  const broken = join(dir, "broken.brec");
  cpSync(TAKE, broken, { recursive: true });
  await runTool([tool("ffmpeg"), "-nostdin", "-v", "error", "-i", join(TAKE, "microphone.wav"), "-t", "0.01", "-y", join(broken, "microphone.wav")]);
  const meta = JSON.parse(readFileSync(join(broken, "recording.json"), "utf8"));
  meta.errors = ["microphone: The operation could not be completed"];
  meta.streams.microphone.error = "The operation could not be completed";
  writeFileSync(join(broken, "recording.json"), JSON.stringify(meta));

  const recorder = join(dir, "beacon-recorder");
  writeFileSync(recorder, `#!/bin/sh\nexport FAKE_RECORDER_TAKE="${broken}"\nexec "${process.execPath}" "${join(import.meta.dir, "helpers/fake-recorder.ts")}"\n`);
  chmodSync(recorder, 0o755);
  process.env.BEACON_RECORDER_PATH = recorder;

  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "r.beproj") });
  // A take's name stays a file in the project's recordings folder: an agent can't write elsewhere with it.
  await expect(core.recordStart(h, { name: "../../outside" })).rejects.toThrow("can't name a take");
  // An agent records only once the user says so in the app; with no app to ask, never.
  await expect(asAuthor("claude-code", () => core.recordStart(h))).rejects.toThrow("asks the user first");
  const asked: string[] = [];
  const app = new LocalCore({ cacheDir: join(dir, "cache"), confirmAgentRecording: async (agent, what) => (asked.push(`${agent}: ${what}`), false) });
  const h2 = await app.create({ path: join(dir, "asked.beproj") });
  await expect(asAuthor("claude-code", () => app.recordStart(h2))).rejects.toThrow("didn't let the agent record");
  expect(asked).toEqual(["Claude Code: the screen, the microphone, the Mac's sound"]);
  await app.close(h2);
  await core.recordStart(h);
  const r = await core.recordStop();
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  expect(r.problems).toEqual(["microphone: The operation could not be completed"]);
  const info = core.doc(h).assets[r.assets[0]!]!.derived.media as MediaInfo;
  expect(info.streams.map((s) => s.role)).toEqual(["screen", "camera", "systemAudio"]);
  expect(r.clips).toHaveLength(3);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(TAKE))("a take goes where Settings › Recording says (the playhead, or the Media Bin only) with its cursor at the Cursor Size, which any recording imported gets too", async () => {
  const take = join(dir, "place.brec");
  cpSync(TAKE, take, { recursive: true });
  const recorder = join(dir, "beacon-recorder-place");
  writeFileSync(recorder, `#!/bin/sh\nexport FAKE_RECORDER_TAKE="${take}"\nexec "${process.execPath}" "${join(import.meta.dir, "helpers/fake-recorder.ts")}"\n`);
  chmodSync(recorder, 0o755);
  process.env.BEACON_RECORDER_PATH = recorder;

  const core = new LocalCore({ cacheDir: join(dir, "cache-place"), configDir: join(dir, "config-place") });
  await core.setSettings({ recordingPlace: "playhead", cursorScale: 3 });
  const h = await core.create({ path: join(dir, "place.beproj") });
  // Something on the timeline already, so its end isn't the playhead.
  const first = join(dir, "first.brec");
  cpSync(TAKE, first, { recursive: true });
  const imported = await core.import(h, [first]);
  for (const j of imported.jobs) await core.cancelJob(j).catch(() => {});
  const clip = (id: string) => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  const cursorOf = (ids: string[]) => ids.map(clip).filter((c) => c.props.cursor).map((c) => (c.props.cursor as { scale: number }).scale);
  // An imported recording takes the Cursor Size too.
  expect(cursorOf(imported.clips)).toEqual([3]);
  await core.run(h, "playhead.set", { time: 1 });
  await core.recordStart(h);
  const r = await core.recordStop();
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  expect(r.clips.length).toBeGreaterThan(0);
  expect(Math.min(...r.clips.map((id) => clip(id).start)) / 705_600_000).toBeCloseTo(1, 2);
  expect(cursorOf(r.clips)).toEqual([3]);
  // Media Bin only: the take is media, with no clips.
  await core.setSettings({ recordingPlace: "bin" });
  const clips = core.doc(h).tracks.flatMap((t) => t.clips).length;
  await core.recordStart(h);
  const binned = await core.recordStop();
  for (const j of binned.jobs) await core.cancelJob(j).catch(() => {});
  expect(binned.clips).toEqual([]);
  expect(core.doc(h).assets[binned.assets[0]!]).toBeDefined();
  expect(core.doc(h).tracks.flatMap((t) => t.clips)).toHaveLength(clips);
  await core.close(h);
}, 60_000);
