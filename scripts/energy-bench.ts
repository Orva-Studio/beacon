#!/usr/bin/env bun
/**
 * What keeps the fans going (Phase 14): the built app on a recording, its CPU (every process it started, % of one
 * core) and energy impact (Activity Monitor's Energy column: CPU and GPU), sampled each second through the first minute after opening (the analyses an
 * import starts), sitting idle, playing, and scrubbing. Media is read in place; the project is a temporary one, and the
 * recording is imported in the app as a drop is. `--fresh`: an empty cache (Whisper's model linked in), so the
 * recording is analysed as a new take is, not from what earlier opens left.
 *
 * `--transcriber whisper|apple|openai`: a copy of the user's settings with that transcriber, theirs left as they are.
 *
 *   bun scripts/energy-bench.ts <recording.brec | .trec | video> [--phase seconds] [--fresh] [--transcriber id]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { LocalCore, RemoteCore } from "@beacon/core";
import { DEFAULT_CACHE_DIR } from "@beacon/render";

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { phase: { type: "string", default: "60" }, fresh: { type: "boolean", default: false }, transcriber: { type: "string" } } });
const source = positionals[0];
if (!source) throw new Error("usage: bun scripts/energy-bench.ts <recording> [--phase seconds]");
const APP = process.env.BEACON_APP ?? join(import.meta.dir, "../packages/desktop/build/dev-macos-arm64/Beacon-dev.app/Contents/MacOS/launcher");
if (!existsSync(APP)) throw new Error("build the app first: bun run --cwd packages/desktop build");
const phase = Number(values.phase);
const dir = mkdtempSync(join(tmpdir(), "beacon-energy-"));
const project = join(dir, `${basename(source)}.beproj`);

const cache = values.fresh ? join(dir, "cache") : undefined;
if (cache) {
  mkdirSync(cache);
  if (existsSync(join(DEFAULT_CACHE_DIR, "models"))) symlinkSync(join(DEFAULT_CACHE_DIR, "models"), join(cache, "models"));
}
let config: string | undefined;
if (values.transcriber) {
  config = join(dir, "config");
  cpSync(process.env.BEACON_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Beacon"), config, { recursive: true, filter: (f) => !f.endsWith(".sock") });
}
const core = new LocalCore({ ...(cache ? { cacheDir: cache } : {}), ...(config ? { configDir: config } : {}) });
if (values.transcriber) await core.setPreference("transcriber", values.transcriber);
await core.close(await core.create({ path: project }));
core.closeAll();

/** CPU % of the app and everything under it, by process name. */
function cpu(root: number): Map<string, number> {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,%cpu=,comm="]).stdout.toString().trim().split("\n").map((l) => {
    const [pid, ppid, pct, ...comm] = l.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pct: Number(pct), name: basename(comm.join(" ")) };
  });
  const mine = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) (mine.add(r.pid), (grew = true));
  }
  const out = new Map<string, number>();
  for (const r of rows) if (mine.has(r.pid)) out.set(r.name, (out.get(r.name) ?? 0) + r.pct);
  return out;
}
/** Each process's GPU time so far (ns), from the graphics driver's clients: what CPU figures miss (Whisper runs on Metal). */
function gpuTimes(): Map<number, number> {
  const out = new Map<number, number>();
  let pid = 0;
  for (const line of Bun.spawnSync(["ioreg", "-r", "-c", "AGXDeviceUserClient", "-l"]).stdout.toString().split("\n")) {
    const creator = /"IOUserClientCreator" = "pid (\d+)/.exec(line);
    if (creator) pid = Number(creator[1]);
    else if (line.includes('"AppUsage"')) for (const m of line.matchAll(/"accumulatedGPUTime"=(\d+)/g)) out.set(pid, (out.get(pid) ?? 0) + Number(m[1]));
  }
  return out;
}

/** The app's processes: it and everything under it, by pid. */
function tree(root: number): Map<number, string> {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="]).stdout.toString().trim().split("\n").map((l) => {
    const [pid, ppid, ...comm] = l.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), name: basename(comm.join(" ")) };
  });
  const mine = new Map([[root, "launcher"]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) (mine.set(r.pid, r.name), (grew = true));
  }
  return mine;
}

/** Energy impact (Activity Monitor's Energy column, CPU and GPU together) of the app's processes, summed. */
function energy(root: number): number {
  const pids = new Set([root]);
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of rows) if (pids.has(pp) && !pids.has(p)) (pids.add(p), (grew = true));
  }
  // The second of two samples: the first has no interval to measure over.
  const out = Bun.spawnSync(["top", "-l", "2", "-s", "1", "-stats", "pid,power", ...[...pids].flatMap((p) => ["-pid", String(p)])]).stdout.toString();
  const last = out.slice(out.lastIndexOf("PID"));
  return last.split("\n").slice(1).reduce((a, l) => a + (Number(l.trim().split(/\s+/)[1]) || 0), 0);
}

const socket = join(dir, "app.sock");
const app = Bun.spawn([APP], { env: { ...process.env, BEACON_BACKGROUND: "1", BEACON_PROJECT: project, BEACON_SOCKET: socket, ...(cache ? { BEACON_CACHE_DIR: cache } : {}), ...(config ? { BEACON_CONFIG_DIR: config } : {}) }, stdout: "ignore", stderr: "ignore" });
try {
  while (!existsSync(socket)) await Bun.sleep(20);
  const remote = await RemoteCore.connect(socket);
  let h = "";
  while (!(h = await remote.open(project).catch(() => ""))) await Bun.sleep(50);
  const imported = await remote.import(h, [source]);
  console.log(`imported: ${imported.clips.length} clips, jobs: ${(await remote.jobs()).map((j) => `${j.label} (${j.state})`).join(", ") || "none"}${imported.needs?.length ? `, needs ${imported.needs.join(", ")}` : ""}`);
  const duration = Number(/duration ([\d.]+)s/.exec(String(await remote.query(h, "project.describe", {})))?.[1] ?? 60);

  const measure = async (label: string, during?: (t: number) => Promise<unknown>, until?: () => Promise<boolean>) => {
    const samples: { cpu: Map<string, number>; energy: number }[] = [];
    const gpuBefore = gpuTimes();
    const t0 = performance.now();
    const end = performance.now() + (until ? 600 : phase) * 1000;
    while (performance.now() < end && !(until && (await until()))) {
      if (during) await during(performance.now());
      samples.push({ cpu: cpu(app.pid), energy: energy(app.pid) });
    }
    const names = new Set(samples.flatMap((s) => [...s.cpu.keys()]));
    const mean = (f: (s: (typeof samples)[number]) => number) => samples.reduce((a, s) => a + f(s), 0) / samples.length;
    const total = mean((s) => [...s.cpu.values()].reduce((a, b) => a + b, 0));
    const by = [...names].map((n) => [n, mean((s) => s.cpu.get(n) ?? 0)] as const).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]);
    const gpuAfter = gpuTimes();
    const procs = tree(app.pid);
    const gpuBy = new Map<string, number>();
    for (const [pid, name] of procs) {
      const d = (gpuAfter.get(pid) ?? 0) - (gpuBefore.get(pid) ?? 0);
      if (d > 0) gpuBy.set(name, (gpuBy.get(name) ?? 0) + (d / 1e6 / (performance.now() - t0)) * 100);
    }
    const gpuText = [...gpuBy].filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${v.toFixed(0)}%`).join(", ") || "none";
    const jobs = (await remote.jobs()).filter((j) => j.state === "running").map((j) => j.label);
    console.log(`${label} (${((performance.now() - t0) / 1000).toFixed(0)} s): CPU ${total.toFixed(0)}% (${by.map(([n, v]) => `${n} ${v.toFixed(0)}%`).join(", ")}), GPU busy: ${gpuText}; energy impact ${mean((s) => s.energy).toFixed(0)}${jobs.length ? `; still running: ${jobs.join(", ")}` : ""}`);
  };

  console.log(`${basename(source)}: ${duration.toFixed(0)} s`);
  await measure("transcribing", undefined, async () => !(await remote.jobs()).some((j) => j.state === "running" && j.kind === "transcript"));
  const transcript = (await remote.jobs()).find((j) => j.kind === "transcript");
  console.log(`transcript: ${transcript?.state ?? "none"}${transcript?.error ? ` (${transcript.error})` : ""}`);
  await measure("idle");
  await remote.run(h, "playback.play", {});
  await measure("playing");
  await remote.run(h, "playback.pause", {});
  let t = duration * 0.2;
  await measure("scrubbing", async () => {
    for (let k = 0; k < 10; k++) {
      t = (t + 0.4) % duration;
      await remote.run(h, "playhead.set", { time: t });
      await Bun.sleep(100);
    }
  });
  await measure("idle again");
  remote.disconnect();
} finally {
  app.kill();
  await app.exited;
  rmSync(dir, { recursive: true, force: true });
}
