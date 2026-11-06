#!/usr/bin/env bun
/**
 * What a person waits for, timed (Phase 14): the project read and imported in core, and the built app launched cold
 * with it until its window has drawn the canvas; then the app's memory (every process it started) as it plays and
 * jumps for a while. Run `bun run --cwd packages/desktop build` first; the shared cache keeps proxies between runs.
 *
 * A recording (.trec, .brec) or a video instead of a project makes a new project of just it: a typical small one.
 *
 *   bun scripts/launch-bench.ts <project.cmproj | recording> [--play seconds]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { LocalCore, RemoteCore } from "@beacon/core";

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { play: { type: "string", default: "60" } } });
const source = positionals[0];
if (!source) throw new Error("usage: bun scripts/launch-bench.ts <project.cmproj | recording> [--play seconds]");
// BEACON_APP: another build's launcher (a packaged release unpacked, to try it under the hardened runtime).
const APP = process.env.BEACON_APP ?? join(import.meta.dir, "../packages/desktop/build/dev-macos-arm64/Beacon-dev.app/Contents/MacOS/launcher");
if (!existsSync(APP)) throw new Error("build the app first: bun run --cwd packages/desktop build");
const dir = mkdtempSync(join(tmpdir(), "beacon-launch-"));
const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;

// Core alone: a Camtasia project imported, then the Beacon project opened again as a relaunch would.
const core = new LocalCore();
const project = join(dir, `${basename(source, extname(source))}.beproj`);
let t = performance.now();
if (extname(source) === ".cmproj") await core.close(await core.create({ path: project, cmproj: source }));
else {
  const h = await core.create({ path: project });
  const r = await core.import(h, [source]);
  // Transcripts are kept by media, so a fixture's are usually there already; a new one would only add to the app's work.
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  await core.close(h);
}
console.log(`import ${basename(source)}: ${ms(t)}`);
t = performance.now();
await core.close(await core.open(project));
console.log(`open the .beproj (core): ${ms(t)}`);

/** The app's processes' memory (resident, MB): it and everything under it. */
function appMemory(pid: number): number {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  const mine = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of rows) if (mine.has(pp) && !mine.has(p)) (mine.add(p), (grew = true));
  }
  return Math.round(rows.filter(([p]) => mine.has(p)).reduce((a, [, , rss]) => a + rss, 0) / 1024);
}

const socket = join(dir, "app.sock");
t = performance.now();
const app = Bun.spawn([APP], { env: { ...process.env, BEACON_BACKGROUND: "1", BEACON_PROJECT: project, BEACON_SOCKET: socket }, stdout: "ignore", stderr: "ignore" });
try {
  while (!existsSync(socket)) await Bun.sleep(20);
  const toSocket = performance.now() - t;
  const remote = await RemoteCore.connect(socket);
  let h = "";
  for (;;) {
    h = await remote.open(project).catch(() => "");
    if (h) break;
    await Bun.sleep(50);
  }
  for (;;) {
    const snap = await remote.snapshot(h);
    if (snap.description.includes("window shows:") && snap.image) break;
    await Bun.sleep(50);
  }
  console.log(`launch the app until its socket is up: ${Math.round(toSocket)} ms; until the window has drawn the project: ${ms(t)}`);
  console.log(`memory once open: ${appMemory(app.pid)} MB`);
  const described = String(await remote.query(h, "project.describe", {}));
  const duration = Math.max(1, Number(/duration ([\d.]+)s/.exec(described)?.[1] ?? 501) - 1);

  // A session's worth of use: play, and jump about now and then.
  const play = Number(values.play);
  const end = performance.now() + play * 1000;
  let peak = 0;
  await remote.run(h, "playback.play", {});
  let next = performance.now() + 30_000;
  while (performance.now() < end) {
    await Bun.sleep(2000);
    peak = Math.max(peak, appMemory(app.pid));
    if (performance.now() > next) {
      console.log(`  ${Math.round((performance.now() - end) / 1000 + play)} s: ${appMemory(app.pid)} MB`);
      next += 30_000;
    }
    if (Math.random() < 0.3) await remote.run(h, "playhead.set", { time: Math.random() * duration });
  }
  await remote.run(h, "playback.pause", {});
  console.log(`memory after ${play} s of playing and jumping: ${appMemory(app.pid)} MB (peak ${peak} MB)`);
  remote.disconnect();
} finally {
  app.kill();
  await app.exited;
  rmSync(dir, { recursive: true, force: true });
}
