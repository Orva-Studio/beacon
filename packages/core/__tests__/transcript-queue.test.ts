import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_WHISPER_MODEL } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const MEDIA = [join(FIXTURES, "audio.m4a"), join(FIXTURES, "repeats.wav")];
const dir = mkdtempSync(join(tmpdir(), "beacon-transcript-queue-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Opening a project from Camtasia started a transcript for each of its media at once: four whisper-cli processes,
// 900 MB each, sharing the GPU and running the fans (2026-11-06).
test.skipIf(!MEDIA.every(existsSync) || !existsSync(DEFAULT_WHISPER_MODEL))("transcripts run one at a time, the others waiting their turn, and in Quiet mode at background priority", async () => {
  // A cache of its own, so every transcript is made, with the speech model the user already has.
  const cache = join(dir, "cache");
  mkdirSync(cache);
  symlinkSync(dirname(DEFAULT_WHISPER_MODEL), join(cache, "models"));
  const core = new LocalCore({ cacheDir: cache, configDir: join(dir, "config") });
  const stages = new Set<string>();
  core.watchApp((e) => e.kind === "job" && e.job.kind === "transcript" && e.job.stage && stages.add(e.job.stage));
  await core.setSettings({ proxyMode: "quiet" });
  try {
    const h = await core.create({ path: join(dir, "p.beproj") });
    const r = await core.import(h, MEDIA);
    expect(r.jobs.length).toBe(MEDIA.length);
    let most = 0;
    const priorities: number[] = [];
    const whispers = () => Bun.spawnSync(["pgrep", "-f", `whisper-cli.*${cache}`]).stdout.toString().trim().split("\n").filter(Boolean);
    while ((await core.jobs()).some((j) => j.kind === "transcript" && j.state === "running")) {
      const pids = whispers();
      most = Math.max(most, pids.length);
      // macOS shows a task at background priority as 4 (31 is the default); it lifts one now and then while something
      // waits on it, so most samples, not all, are 4.
      for (const pid of pids) {
        const pri = Bun.spawnSync(["ps", "-o", "pri=", "-p", pid]).stdout.toString().trim();
        if (pri) priorities.push(Number(pri));
      }
      await Bun.sleep(50);
    }
    expect((await core.jobs()).filter((j) => j.kind === "transcript").map((j) => j.state)).toEqual(MEDIA.map(() => "done"));
    expect(most).toBe(1);
    expect(stages.has("Waiting")).toBe(true);
    // Its turn come, a transcript no longer says it is waiting.
    expect((await core.jobs()).filter((j) => j.kind === "transcript").map((j) => j.stage)).toEqual(MEDIA.map(() => undefined));
    expect(priorities.length).toBeGreaterThan(10);
    expect(priorities.filter((p) => p <= 4).length / priorities.length).toBeGreaterThan(0.8);
  } finally {
    core.closeAll();
  }
}, 300_000);
