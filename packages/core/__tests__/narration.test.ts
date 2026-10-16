import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore, type CoreEvent } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-narration-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The narration's microphone is a stand-in recorder's file: nothing listens to the room.
const recorder = join(dir, "beacon-recorder");
const hostStartFile = join(dir, "host-start");
// The sidecar is spawned with the environment Bun started with, so its settings are in the script.
writeFileSync(
  recorder,
  `#!/bin/sh\nexport FAKE_RECORDER_MIC="${join(dir, "mic.wav")}" FAKE_RECORDER_HOST_START="${hostStartFile}"\nexec "${process.execPath}" "${join(import.meta.dir, "helpers/fake-recorder.ts")}"\n`,
);
chmodSync(recorder, 0o755);
process.env.BEACON_RECORDER_PATH = recorder;

test("a narration over the range plays it muted, stops at its end and lands on a new track where the timeline was heard, as one undo step", async () => {
  await runTool(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000", join(dir, "tone.wav")]);
  await runTool(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=duration=10:sample_rate=48000:amplitude=0.1", "-ac", "1", join(dir, "mic.wav")]);
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "n.beproj") });
  for (const j of (await core.import(h, [join(dir, "tone.wav")])).jobs) await core.cancelJob(j).catch(() => {});
  const view = core.attachView(h, { offscreen: { width: 64, height: 36 } }, { proxies: false });
  const before = core.doc(h);
  await core.run(h, "range.set", { in: 2, out: 3 });

  const events: CoreEvent[] = [];
  core.watch(h, (e) => events.push(e));
  await core.recordStart(h, { narrate: {} });
  expect(view.muted).toBe(true);
  expect((await core.recordStatus()).narration).toEqual({ from: 2, until: 3, hear: false });
  let heard = view.heard();
  for (const end = Date.now() + 3000; !heard && Date.now() < end; heard = view.heard()) await Bun.sleep(5);
  expect(heard?.time).toBe(2);
  // The microphone's file began 0.5 s before the timeline's first sound was heard (its first sample 0.02 s into the take).
  writeFileSync(hostStartFile, String(heard!.host - 0.5 - 0.02));

  // The end of the range ends it, with no Stop.
  for (const end = Date.now() + 5000; !events.some((e) => e.kind === "narrated") && Date.now() < end; ) await Bun.sleep(20);
  const narrated = events.find((e) => e.kind === "narrated");
  expect(narrated).toBeDefined();
  expect(view.muted).toBe(false);
  const status = await core.recordStatus();
  expect(status.recording).toBe(false);
  expect(status.last?.clips).toHaveLength(1);

  const doc = core.doc(h);
  const track = doc.tracks.at(-1)!;
  expect(track.name).toBe("Narration");
  expect(doc.tracks).toHaveLength(before.tracks.length + 1);
  const [clip] = track.clips;
  expect(clip!.type).toBe("audio");
  expect(ticksToSeconds(clip!.start)).toBe(2);
  expect(ticksToSeconds(clip!.mediaStart ?? 0)).toBeCloseTo(0.5, 6);
  expect(doc.assets[clip!.assetId!]?.path).toEndWith(".brec");

  await core.undo(h);
  expect(core.doc(h).tracks).toEqual(before.tracks);
  expect(core.doc(h).assets).toEqual(before.assets);
  // Undone, the take stays in the project's recordings: Redo needs it.
  expect(existsSync(status.last!.take)).toBe(true);
  await core.close(h);
}, 30000);

test("a discarded narration adds nothing and leaves no take", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.open(join(dir, "n.beproj"));
  core.attachView(h, { offscreen: { width: 64, height: 36 } }, { proxies: false });
  await core.run(h, "range.clear", {});
  await core.run(h, "playhead.set", { time: 1 });
  const before = core.doc(h);
  const { take } = await core.recordStart(h, { narrate: { hear: true } });
  await Bun.sleep(300);
  const r = await core.recordStop({ discard: true });
  expect(r.discarded).toBe(true);
  expect(existsSync(take)).toBe(false);
  expect(core.doc(h)).toEqual(before);
  await core.close(h);
}, 30000);

test("with nothing after the playhead, a narration records there without playing and starts with its file", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.open(join(dir, "n.beproj"));
  core.attachView(h, { offscreen: { width: 64, height: 36 } }, { proxies: false });
  await core.run(h, "range.clear", {});
  await core.run(h, "playhead.jump", { to: "end" });
  const at = (await core.session(h)).playhead;
  await core.recordStart(h, { narrate: { hear: true } });
  expect((await core.session(h)).playing).toBe(false);
  expect((await core.recordStatus()).narration).toEqual({ from: at, until: at, hear: false });
  // A click on the timeline doesn't end it: there is no playback to follow.
  await core.run(h, "playhead.set", { time: 0 });
  expect((await core.recordStatus()).recording).toBe(true);
  const r = await core.recordStop();
  const clip = core.doc(h).tracks.at(-1)!.clips[0]!;
  expect(r.clips).toEqual([clip.id]);
  expect(ticksToSeconds(clip.start)).toBe(at);
  expect(clip.mediaStart ?? 0).toBe(0);
  await core.close(h);
}, 30000);
