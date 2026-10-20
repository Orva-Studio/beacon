import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, tool, type MediaInfo } from "@beacon/media";
import { LocalCore } from "../src";

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
  await core.recordStart(h);
  const r = await core.recordStop();
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  expect(r.problems).toEqual(["microphone: The operation could not be completed"]);
  const info = core.doc(h).assets[r.assets[0]!]!.derived.media as MediaInfo;
  expect(info.streams.map((s) => s.role)).toEqual(["screen", "camera", "systemAudio"]);
  expect(r.clips).toHaveLength(3);
  await core.close(h);
}, 60_000);
