import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";
import { openPage } from "./browser";
import { serveUi } from "./serve";

const dir = mkdtempSync(join(tmpdir(), "beacon-many-clips-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The timeline asked each clip's track for its neighbours by looking at every other clip: zooming 2,350 clips took
// ~52 ms of script a step (docs/performance.md). Generous for a loaded machine, well under that.
test("a timeline of 2,000 clips zooms and scrolls in well under a frame's budget of script each step", async () => {
  const path = join(dir, "many.beproj");
  const core = new LocalCore({ configDir: join(dir, "config") });
  const h = await core.create({ path });
  const tracks: string[] = [];
  for (let k = 0; k < 4; k++) tracks.push((await core.run(h, "track.add", { name: `Row ${k + 1}` })).results[0] as string);
  await core.transaction(h, "Clips", tracks.flatMap((track) => Array.from({ length: 500 }, (_, i) => ({ command: "clip.add", args: { type: "video", track, start: i * 0.6, duration: 0.5 } }))));
  await core.close(h);
  core.closeAll();

  const ui = await serveUi(path);
  const page = await openPage(ui.url);
  try {
    await page.until("!!document.querySelector('canvas[data-timeline]')", 30_000);
    await ui.core.run(ui.handle, "timeline.view", { start: 0, end: 300 });
    const box = await page.evaluate<{ x: number; y: number; w: number }>("(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()");
    const frame = () => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const scriptPerStep = async (act: (i: number) => Promise<unknown>) => {
      await frame();
      const before = (await page.metrics()).ScriptDuration!;
      for (let i = 0; i < 10; i++) {
        await act(i);
        await frame();
      }
      return (((await page.metrics()).ScriptDuration! - before) * 1000) / 10;
    };
    const zoom = await scriptPerStep((i) => page.evaluate(`document.querySelector('canvas[data-timeline]').dispatchEvent(new WheelEvent('wheel', { deltaY: ${i % 2 ? 30 : -30}, clientX: ${box.x + box.w / 2}, clientY: ${box.y + 40}, ctrlKey: true, bubbles: true, cancelable: true }))`));
    const scroll = await scriptPerStep(() => page.wheel(box.x + box.w / 2, box.y + 40, 60, 0));
    console.log(`2,000 clips: zoom ${zoom.toFixed(1)} ms, scroll ${scroll.toFixed(1)} ms of script a step`);
    expect(zoom).toBeLessThan(30);
    expect(scroll).toBeLessThan(30);
  } finally {
    page.close();
    await ui.close();
  }
}, 120_000);
