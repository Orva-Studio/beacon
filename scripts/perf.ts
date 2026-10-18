// Times the editor's preview offscreen (docs/performance.md): jumps, settling
// on the originals, scrubbing both ways and playing, on a copy of a project.
//   bun scripts/perf.ts <project.cmproj | .beproj> [--size 1280x720] [--jumps 40] [--play 10]
//     [--cache dir] (proxies built there, not in the shared cache) [--mode quiet|fast] (how they are built)
//     [--no-proxies] (an empty cache and no proxy jobs: everything read from the originals)
//     [--export from-to] (instead: times an MP4 export of those timeline seconds; BEACON_PROFILE=1 adds its stages)
// A .beproj is copied without its media: only its project.json, the media read where it is.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { LocalCore } from "@beacon/core";
import { DEFAULT_CACHE_DIR } from "@beacon/render";
import { projectDuration, ticksToSeconds } from "@beacon/model";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    size: { type: "string", default: "1280x720" },
    jumps: { type: "string", default: "40" },
    play: { type: "string", default: "10" },
    cache: { type: "string" },
    mode: { type: "string", default: "fast" },
    "no-proxies": { type: "boolean", default: false },
    export: { type: "string" },
  },
});
const source = positionals[0];
if (!source) throw new Error("usage: bun scripts/perf.ts <project.cmproj | .beproj> [--size WxH] [--jumps n] [--play s]");
const [width, height] = values.size.split("x").map(Number) as [number, number];
const jumps = Number(values.jumps);

const dir = mkdtempSync(join(tmpdir(), "ot-perf-"));
/** A cache with the frame indexes already built (so first jumps don't time building them), and no proxies. */
function cacheWithoutProxies(): string {
  const dir = mkdtempSync(join(tmpdir(), "ot-perf-cache-"));
  for (const f of readdirSync(DEFAULT_CACHE_DIR)) if (f.startsWith("frames-")) cpSync(join(DEFAULT_CACHE_DIR, f), join(dir, f));
  return dir;
}
const core = new LocalCore(values["no-proxies"] ? { cacheDir: cacheWithoutProxies() } : values.cache ? { cacheDir: values.cache } : {});
if (values.mode !== "quiet" && values.mode !== "fast") throw new Error("--mode is quiet or fast");
core.setJobMode(values.mode);
try {
  const path = join(dir, `${basename(source, extname(source))}.beproj`);
  let h;
  if (extname(source) === ".beproj") {
    const doc = JSON.parse(readFileSync(join(source, "project.json"), "utf8")) as { assets: Record<string, { path: string }> };
    for (const a of Object.values(doc.assets)) if (!isAbsolute(a.path)) a.path = join(source, a.path);
    mkdirSync(path);
    writeFileSync(join(path, "project.json"), JSON.stringify(doc));
    h = await core.open(path);
  } else {
    h = await core.create({ path, cmproj: source });
  }
  const doc = core.doc(h);
  const fps = doc.settings.fps.num / doc.settings.fps.den;
  const duration = ticksToSeconds(projectDuration(doc));

  if (values.export) {
    const [from, to] = values.export.split("-").map(Number) as [number, number];
    const output = join(dir, "export.mp4");
    const t0 = performance.now();
    await (await core.export(h, { output, from, to })).done;
    const seconds = (performance.now() - t0) / 1000;
    console.log(`${basename(source)}: export ${from}-${to} s (${doc.settings.width}×${doc.settings.height} at ${fps} fps) in ${seconds.toFixed(1)} s, ${((to - from) / seconds).toFixed(2)}× real time, ${(statSync(output).size / 1e6).toFixed(1)} MB`);
    await core.close(h);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }

  // The proxies the app would build (cached across runs); the bench waits for them.
  const running = new Set<string>();
  core.watchApp((e) => e.kind === "job" && (e.job.state === "running" ? running.add(e.job.id) : running.delete(e.job.id)));
  const view = core.attachView(h, { offscreen: { width, height } }, { silent: true, proxies: !values["no-proxies"] });
  const waitStart = performance.now();
  for (let idle = 0; idle < 6; idle = running.size ? 0 : idle + 1) await Bun.sleep(250);
  const proxyWait = (performance.now() - waitStart) / 1000 - 1.5;

  // Deterministic positions, so runs compare.
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const positions = Array.from({ length: jumps }, () => random() * (duration - 2) + 1);
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  view.show(0);
  view.flush();
  const jump = positions.map((t) => time(() => (view.show(t), view.flush())));
  const settle = positions.slice(0, Math.min(10, jumps)).map((t) => {
    view.show(t);
    view.flush();
    return time(() => (view.settle(), view.flush()));
  });
  // A drag moves a few frames per pointer event: two frames a step.
  const scrub = (from: number, step: number) => {
    view.show(from);
    view.flush();
    return Array.from({ length: 90 }, (_, i) => time(() => (view.show(from + ((i + 1) * step) / fps), view.flush())));
  };
  const mid = duration / 2;
  const forward = scrub(mid, 2);
  const backward = scrub(mid, -2);

  // Canvas edits at a settled frame, as the canvas sends them: one command a pointer move, coalesced into one undo step.
  view.show(mid);
  view.settle();
  view.flush();
  const visible = doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "screen" && c.start / 705_600_000 <= mid && (c.start + c.duration) / 705_600_000 > mid);
  const edits: [string, number[]][] = [];
  if (visible) {
    const props = (visible.props.transform ?? {}) as { scaleX?: number; x?: number };
    const edit = async (name: string, step: (i: number) => Record<string, Record<string, number>>) => {
      const xs: number[] = [];
      for (let i = 1; i <= 60; i++) {
        const t0 = performance.now();
        await core.run(h, "clip.set", { clip: visible.id, props: step(i), at: mid }, { coalesce: name });
        view.flush();
        xs.push(performance.now() - t0);
      }
      edits.push([name, xs]);
    };
    const s0 = props.scaleX ?? 1;
    const x0 = props.x ?? 0;
    await edit("move", (i) => ({ transform: { x: x0 + i * 4 } }));
    await edit("resize", (i) => ({ transform: { scaleX: s0 * (1 - i / 200), scaleY: s0 * (1 - i / 200) } }));
    await edit("crop", (i) => ({ crop: { left: i * 6 } }));
    const select: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await core.run(h, "selection.set", { clips: i % 2 ? [] : [visible.id], linked: false });
      view.flush();
      select.push(performance.now() - t0);
    }
    edits.push(["select", select]);
    const zoom: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await core.run(h, "canvas.zoom", { zoom: 50 + (i % 10) * 15 });
      view.flush();
      zoom.push(performance.now() - t0);
    }
    await core.run(h, "canvas.zoom", { zoom: "fit" });
    edits.push(["canvas zoom", zoom]);
  }

  view.settle();
  view.flush();
  const before = view.stats()!;
  const playSeconds = Math.min(Number(values.play), duration - mid);
  view.play(mid);
  await Bun.sleep(playSeconds * 1000);
  view.pause();
  const after = view.stats()!;

  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
  const row = (name: string, xs: number[]) =>
    console.log(`${name.padEnd(22)} p50 ${pct(xs, 0.5).toFixed(1).padStart(7)} ms   p95 ${pct(xs, 0.95).toFixed(1).padStart(7)} ms   max ${Math.max(...xs).toFixed(1).padStart(7)} ms`);
  console.log(`${basename(source)}: ${duration.toFixed(0)} s at ${fps} fps, view ${width}×${height}, proxies ready after ${Math.max(0, proxyWait).toFixed(1)} s`);
  row(`jump (proxy) ×${jumps}`, jump);
  row(`settle (originals) ×${settle.length}`, settle);
  row("scrub forward ×90", forward);
  row("scrub backward ×90", backward);
  console.log(`${"scrub fps".padEnd(22)} forward ${(1000 / pct(forward, 0.5)).toFixed(0)}, backward ${(1000 / pct(backward, 0.5)).toFixed(0)} (from p50)`);
  for (const [name, xs] of edits) row(`edit: ${name} ×${xs.length}`, xs);
  if (!visible) console.log("edits: no screen clip at the middle of the timeline");
  const shown = after.shown - before.shown;
  console.log(`${`play ${playSeconds.toFixed(0)} s`.padEnd(22)} ${shown} frames shown of ${Math.round(playSeconds * fps)}, ${after.skipped - before.skipped} skipped`);
  core.detachView(h);
  await core.close(h);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
