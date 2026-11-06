#!/usr/bin/env bun
/**
 * A timeline of hundreds of clips, timed (Phase 14): edits in core, then the editor's UI in headless Chromium
 * (the UI harness, a development build of React, so slower than the app) opening, zooming, scrolling and dragging.
 * Works on a copy; `--split s` first splits every track every `s` seconds, for more clips.
 *
 *   bun scripts/timeline-bench.ts <project.beproj | .cmproj> [--split 2]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { LocalCore, readProject, writeProject } from "@beacon/core";
import { projectDuration, ticksToSeconds } from "@beacon/model";
import { openPage } from "./ui-harness/browser";
import { serveUi } from "./ui-harness/serve";

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { split: { type: "string" } } });
const source = positionals[0];
if (!source) throw new Error("usage: bun scripts/timeline-bench.ts <project.beproj | .cmproj> [--split seconds]");
const dir = mkdtempSync(join(tmpdir(), "beacon-timeline-"));
const path = join(dir, `${basename(source, extname(source))}.beproj`);
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
const ms = (x: number) => `${x.toFixed(1)} ms`;

const core = new LocalCore({ configDir: join(dir, "config") });
try {
  let h;
  if (extname(source) === ".beproj") {
    mkdirSync(path);
    writeProject(path, readProject(source, core.registry).doc);
    h = await core.open(path);
  } else h = await core.create({ path, cmproj: source });
  const duration = ticksToSeconds(projectDuration(core.doc(h)));
  if (values.split) {
    const step = Number(values.split);
    await core.transaction(h, "Split", Array.from({ length: Math.floor(duration / step) }, (_, i) => ({ command: "clip.split", args: { at: (i + 1) * step } })));
  }
  const clips = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const count = clips().length;
  console.log(`${basename(source)}: ${count} clips on ${core.doc(h).tracks.length} tracks, ${duration.toFixed(0)} s`);

  // Core: a move, a split and an undo, each one step as a click would make, on clips spread over the timeline.
  const times = { move: [] as number[], split: [] as number[], undo: [] as number[] };
  for (let i = 0; i < 20; i++) {
    const all = clips();
    const c = all[Math.floor((i / 20) * all.length)]!;
    let t = performance.now();
    await core.run(h, "clip.move", { clips: [c.id], by: 0 }).catch(() => undefined);
    times.move.push(performance.now() - t);
    t = performance.now();
    await core.run(h, "clip.split", { at: ticksToSeconds(c.start + c.duration / 2), clips: [c.id] });
    times.split.push(performance.now() - t);
    t = performance.now();
    await core.undo(h);
    times.undo.push(performance.now() - t);
  }
  for (const [k, xs] of Object.entries(times)) console.log(`  core ${k}: p50 ${ms(p50(xs))}, p95 ${ms(p95(xs))}`);
  await core.close(h);

  // The UI: opened until the timeline has drawn, then zoom, scroll and drag, each step timed to the next frame.
  let t = performance.now();
  const ui = await serveUi(path);
  const page = await openPage(ui.url);
  try {
    await page.until("!!document.querySelector('canvas[data-timeline]')", 60_000);
    await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    console.log(`  ui open until the timeline draws: ${ms(performance.now() - t)}`);
    const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>("(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
    const frame = () => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const steps = async (label: string, n: number, act: (i: number) => Promise<unknown>, per = 1) => {
      const before = await page.metrics();
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        await act(i);
        await frame();
        xs.push(performance.now() - t0);
      }
      const after = await page.metrics();
      console.log(`  ui ${label}: to the next frame p50 ${ms(p50(xs))}, p95 ${ms(p95(xs))}; main thread ${ms(((after.TaskDuration! - before.TaskDuration!) * 1000) / n / per)} a ${per > 1 ? "move" : "step"} (script ${ms(((after.ScriptDuration! - before.ScriptDuration!) * 1000) / n / per)})`);
    };
    const wheel = (dy: number, ctrl: boolean) =>
      page.evaluate(`document.querySelector('canvas[data-timeline]').dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, clientX: ${box.x + box.w / 2}, clientY: ${box.y + 40}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true }))`);
    // Out to the whole timeline (every clip drawn), then back in.
    await steps("zoom", 30, (i) => wheel(i < 15 ? 40 : -40, true));
    await steps("scroll", 30, () => page.wheel(box.x + box.w / 2, box.y + 40, 120, 0));
    // A drag across the first track's clips: hit-testing and drawing as it moves.
    const y = box.y + 40;
    await steps("drag of 30 moves", 1, () => page.drag([box.x + box.w * 0.4, y], [box.x + box.w * 0.6, y], [], 30), 30);
    await steps("select all (⌘A)", 1, () => page.key("a", "KeyA", ["meta"]));
  } finally {
    page.close();
    await ui.close();
  }
} finally {
  core.closeAll();
  rmSync(dir, { recursive: true, force: true });
}
