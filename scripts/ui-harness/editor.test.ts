import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";
import type { Clip } from "@beacon/model";
import { openPage } from "./browser";
import { serveUi } from "./serve";
import { cornerButtons, headerIcons, headerWidth } from "../../packages/ui/src/timeline-layout";
import { DEFAULT_EXPORT } from "../../packages/ui/src/export-defaults";

/**
 * The editor's flows, driven in headless Chromium against a LocalCore (no window, no screen): what was
 * rehearsed by hand each session, kept so it can't quietly break. A real recording, read only.
 */
const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const skip = !existsSync(RECORDING);

let dir = "";
let ui: Awaited<ReturnType<typeof serveUi>>;
let page: Awaited<ReturnType<typeof openPage>>;

const clips = () => ui.core.doc(ui.handle).tracks.flatMap((t) => t.clips);
const clip = (id: string) => clips().find((c) => c.id === id)!;
const run = (command: string, args: unknown = {}) => ui.core.run(ui.handle, command, args);
const session = () => ui.core.session(ui.handle);
const has = (selector: string) => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
const centre = (selector: string) =>
  page.evaluate<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
/** Types into the focused field as a person would (React sees it). */
const type = (text: string) => page.evaluate(`(() => { document.activeElement.select?.(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
const select = async (ids: string[]) => {
  await run("selection.set", { clips: ids, linked: false });
  await Bun.sleep(300);
};
/** Waits until what the page sends back (a menu, settings) has arrived, rather than for a fixed time. */
const arrived = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(20);
};
let screen: Clip;
let callout: Clip;

beforeAll(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "beacon-e2e-"));
  const core = new LocalCore();
  const h = await core.create({ path: join(dir, "e2e.beproj") });
  await core.import(h, [RECORDING]);
  await core.run(h, "edit.addAnnotation", { preset: "text" });
  await core.captureFrame(h, 1);
  await core.close(h);
  ui = await serveUi(join(dir, "e2e.beproj"));
  page = await openPage(ui.url);
  await page.until("document.querySelectorAll('[data-asset]').length >= 2", 15000);
  screen = clips().find((c) => c.type === "screen")!;
  callout = clips().find((c) => c.type === "callout")!;
}, 60000);

afterAll(async () => {
  if (skip) return;
  page.close();
  await ui.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(skip)("value boxes clamp: typing past 100% or stepping past it stays at 100%", async () => {
  await select([callout.id]);
  await run("inspector.tab", { tab: "callout" });
  await page.until("[...document.querySelectorAll('span')].some(s => s.textContent === 'Opacity')");
  await page.evaluate(`[...document.querySelectorAll('span')].find(s => s.textContent === 'Opacity').parentElement.querySelector('span.cursor-text').click()`);
  await page.until("document.activeElement?.tagName === 'INPUT'");
  await type("210");
  expect(await page.evaluate<string>("document.activeElement.value")).toBe("100");
  await page.key("ArrowUp", "ArrowUp");
  expect(await page.evaluate<string>("document.activeElement.value")).toBe("100");
  await page.key("Escape", "Escape");
});

test.skipIf(skip)("the colour picker sets a colour from a preset and from its square, one undo step a drag", async () => {
  await select([callout.id]);
  await run("inspector.tab", { tab: "callout" });
  await page.until(`!!document.querySelector('[title="Color"]')`);
  await page.click(...(await centre('[title="Color"]')));
  await page.until(`!!document.querySelector('[title="Pick a colour from the canvas"]')`);
  await page.click(...(await centre('[title="#e8473b"]')));
  await Bun.sleep(300);
  const text = () => (clip(callout.id).props.callout as { text: { color: number[] } }).text.color;
  expect(text()[0]).toBeCloseTo(0xe8 / 255, 2);
  const sq = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const undoBefore = (await ui.core.history(ui.handle)).undo.length;
  await page.drag([sq.x + sq.w * 0.8, sq.y + 4], [sq.x + 2, sq.y + sq.h - 2]);
  await Bun.sleep(400);
  expect(Math.max(...text().slice(0, 3))).toBeLessThan(0.1);
  expect((await ui.core.history(ui.handle)).undo.length - undoBefore).toBe(1);
  await page.key("Escape", "Escape");
});

test.skipIf(skip)("copy a clip, paste onto another selected clip gives it the effects; with nothing selected it pastes the clip", async () => {
  const camera = clips().find((c) => c.type === "video")!;
  await run("effect.add", { clip: screen.id, type: "drop-shadow" });
  await select([screen.id]);
  await run("edit.copy");
  await select([camera.id]);
  await run("edit.paste");
  expect(clip(camera.id).effects.map((e) => e.type)).toContain("drop-shadow");
  const before = clips().length;
  await run("selection.clear");
  await run("playhead.set", { time: 500 });
  await run("edit.paste");
  expect(clips().length).toBeGreaterThan(before);
  // Back as it was: the pasted clip, the pasted effect, the added one.
  for (let i = 0; i < 3; i++) await ui.core.undo(ui.handle);
  expect(clips().length).toBe(before);
  await run("playhead.set", { time: 2 });
});

test.skipIf(skip)("Clip Speed is a tab once added; editing its duration sets the speed of the selected clip only", async () => {
  await select([screen.id]);
  await run("inspector.tab", { tab: "transform" });
  expect(await page.evaluate<boolean>("!!document.querySelector('[title=\"Clip Speed\"]')")).toBe(false);
  // As the app's Clip Speed menu item does.
  ui.send("showClipSpeed", { clip: screen.id });
  await run("inspector.tab", { tab: "speed" });
  await page.until("!!document.querySelector('[title=\"Clip Speed\"]') && document.body.innerText.includes('Minutes')");
  const minutes = Math.floor(clip(screen.id).duration / 705_600_000 / 60);
  await page.evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.endsWith('Minutes')).querySelector('span').click()`);
  await page.until("document.activeElement?.tagName === 'INPUT'");
  await type(String(minutes * 2));
  await page.key("Enter", "Enter");
  await Bun.sleep(400);
  const s = clip(screen.id).speed!;
  expect(s.num / s.den).toBeLessThan(0.75);
  // The recording's audio and camera aren't selected, so they keep their speed.
  const others = clips().filter((c) => c.assetId === screen.assetId && c.id !== screen.id);
  expect(others.length).toBeGreaterThan(0);
  for (const o of others) expect(o.speed).toBeUndefined();
  await run("clip.speed", { clips: [screen.id], speed: null });
});

test.skipIf(skip)("double-clicking a Media Bin item previews it: video with a play bar, an image without", async () => {
  const tile = (i: number) => page.evaluate<[number, number]>(`(() => { const r = document.querySelectorAll('[data-asset]')[${i}].getBoundingClientRect(); return [r.x + r.width / 2, r.y + 30]; })()`);
  const dbl = async ([x, y]: [number, number]) => page.evaluate(`document.elementFromPoint(${x}, ${y}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await dbl(await tile(0));
  await page.until("document.body.innerText.includes('Preview - ')");
  expect(await has('[title="Play (Space)"]')).toBe(true);
  await page.key(" ", "Space");
  await page.until(`!!document.querySelector('[title="Pause (Space)"]')`);
  await page.key("Escape", "Escape");
  await page.until("!document.body.innerText.includes('Preview - ')");
  await dbl(await tile(1));
  await page.until("document.body.innerText.includes('Preview - ')");
  expect(await has('[title="Play (Space)"]')).toBe(false);
  await page.click(...(await centre('[title="Close (Esc)"]')));
  await page.until("!document.body.innerText.includes('Preview - ')");
  expect(ui.menus.filter((m) => m.startsWith("preview:"))).toEqual(["preview:play:0", "preview:close", "preview:close"]);
});

test.skipIf(skip)("a double-click on a text callout types into it on the canvas, with a caret and selection", async () => {
  await select([callout.id]);
  const [x, y] = await page.evaluate<[number, number]>(`(() => { const g = [...document.querySelectorAll('[data-clip]')].map(e => e.getBoundingClientRect()); const xs = g.map(r => r.x + r.width / 2), ys = g.map(r => r.y + r.height / 2); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; })()`);
  await page.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); for (const t of ['pointerdown','mousedown']) el.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: ${x}, clientY: ${y}, button: 0, detail: 2, pointerId: 1 })); })()`);
  await page.until(`document.activeElement?.getAttribute('aria-label') === 'Text'`);
  // All of it selected first: a selection band (a square-ended line).
  await page.until(`[...document.querySelectorAll('svg line')].some(l => Number(l.getAttribute('stroke-width')) > 10)`, 3000);
  await page.evaluate("document.execCommand('insertText', false, 'Hello')");
  await Bun.sleep(300);
  expect((clip(callout.id).props.callout as { text: { text: string } }).text.text).toBe("Hello");
  await page.until(`[...document.querySelectorAll('svg line')].some(l => l.getAttribute('stroke-width') === '1.5')`, 3000);
  await page.key("Escape", "Escape");
});

test.skipIf(skip)("the Y dial tilts a clip in perspective and its outline follows", async () => {
  await select([screen.id]);
  await run("inspector.tab", { tab: "transform" });
  // After the canvas border's four lines, the selection outline's four.
  const outline = () => page.evaluate<number[][]>(`[...document.querySelectorAll('svg line')].slice(4, 8).map(l => [+l.getAttribute('x1'), +l.getAttribute('y1')])`);
  const flat = await outline();
  await run("clip.set", { clips: [screen.id], props: { transform: { rotationY: 0.4 } } });
  await page.until("document.body.innerText.includes('22.9°')");
  const tilted = await outline();
  // Perspective: the left and right edges no longer have the same height.
  const height = (a: number[], b: number[]) => Math.abs(a[1]! - b[1]!);
  expect(Math.abs(height(tilted[0]!, tilted[3]!) - height(tilted[1]!, tilted[2]!))).toBeGreaterThan(5);
  expect(Math.abs(height(flat[0]!, flat[3]!) - height(flat[1]!, flat[2]!))).toBeLessThan(1);
  await run("clip.set", { clips: [screen.id], props: { transform: { rotationY: 0 } } });
});

test.skipIf(skip)("New Project asks for a name and the canvas (presets); the project's name renames it", async () => {
  ui.send("newProjectSheet", { name: "Untitled Project" });
  await page.until("document.body.innerText.includes('New Project')");
  await type("Episode 12");
  const dims = `[...document.querySelectorAll('[data-canvas-settings] input')].map((i) => i.value).join('x')`;
  const pick = (size: string) => page.evaluate(`(() => { const s = document.querySelector('[data-canvas-size]'); s.value = '${size}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // The Portrait tab starts from 9:16 FHD; its list holds only portrait sizes.
  await page.click(...(await centre('[data-canvas-shape] [title="Portrait"]')));
  await page.until(`${dims} === '1080x1920'`);
  expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[data-canvas-size] option')].map((o) => o.value)`)).toEqual(["600x750", "1080x1350", "1080x1920", "custom"]);
  await pick("1080x1350");
  await page.until(`${dims} === '1080x1350'`);
  await pick("1080x1920");
  await page.until(`${dims} === '1080x1920'`);
  // Typed and committed as a person would: the value through React's input, then leaving the field.
  await page.evaluate(`(() => {
    const i = document.querySelector('[title="Canvas width in pixels"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '1440');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.focus();
    i.blur();
  })()`);
  // Locked, the height keeps the shape.
  await page.until(`${dims} === '1440x2560'`);
  expect(await page.evaluate<string>(`document.querySelector('[data-lock]').dataset.lock`)).toBe("true");
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Create').click()`);
  await page.until("!document.body.innerText.includes('New Project')");
  await page.click(...(await centre('[title="Rename the project"]')));
  await page.until("document.activeElement?.tagName === 'INPUT'");
  await type("Client Demo");
  await page.key("Enter", "Enter");
  await arrived(() => ui.menus.includes("newProject:Episode 12"));
  expect(ui.menus).toContain("newProject:Episode 12");
  expect(ui.menus).toContain(`newProjectSettings:${JSON.stringify({ width: 1440, height: 2560, fps: 30, background: "#000000", normalize: true })}`);
  expect(ui.menus).toContain("renameProject:Client Demo");
});

test.skipIf(skip)("zoomed all the way in, the timeline shows ten frames", async () => {
  await run("timeline.zoom", { to: "max" });
  const s = await session();
  expect((s.timeline.end - s.timeline.start) * 30).toBeCloseTo(10, 0);
  await run("timeline.zoom", { to: "fit" });
});

test.skipIf(skip)("opening a project whose proxies are all built doesn't hang, and an export outlives its project", async () => {
  const core = new LocalCore();
  const path = join(dir, "second.beproj");
  const h = await core.create({ path });
  await core.import(h, [RECORDING]);
  // Proxies the main suite's view may still be building: whatever is left, the event loop must keep running.
  const view = core.attachView(h, { offscreen: { width: 320, height: 180 } } as never, { silent: true, proxies: true });
  await Bun.sleep(50);
  view.close();
  const states: string[] = [];
  core.watchJobs((j) => j.kind === "export" && j.state !== "running" && states.push(j.state));
  const job = await core.export(h, { output: join(dir, "out.mp4"), from: 0, to: 1 });
  await core.close(h);
  await job.done;
  expect(states).toEqual(["done"]);
}, 120000);

test.skipIf(skip)("the rotation gizmo turns a clip by dragging a ring, one undo step; its effects are on the fx tab", async () => {
  await run("playhead.set", { time: 1 });
  await select([screen.id]);
  await run("inspector.tab", { tab: "transform" });
  await page.until("!!document.querySelector('[data-rotation-gizmo]')");
  const undoBefore = (await ui.core.history(ui.handle)).undo.length;
  // The Z ring's right-hand edge, dragged counter-clockwise.
  const [sx, sy] = await page.evaluate<[number, number]>(
    `(() => { const g = document.querySelector('[data-rotation-gizmo]').getBoundingClientRect(); const b = document.querySelector('[data-ring=z]').getBBox(); return [g.x + ((b.x + b.width) * g.width) / 112 - 1, g.y + ((b.y + b.height / 2) * g.height) / 112]; })()`,
  );
  await page.drag([sx, sy], [sx - 20, sy - 30]);
  await Bun.sleep(300);
  const degrees = ((clip(screen.id).props.transform as { rotation: number }).rotation * 180) / Math.PI;
  expect(degrees).toBeGreaterThan(20);
  expect((await ui.core.history(ui.handle)).undo.length - undoBefore).toBe(1);
  await ui.core.undo(ui.handle);

  await run("effect.add", { clip: screen.id, type: "drop-shadow" });
  const fx = clip(screen.id).effects.at(-1)!;
  await run("effect.select", { effects: [{ clip: screen.id, id: fx.id }] });
  expect((await session()).inspector).toBe("effects");
  await page.until("[...document.querySelectorAll('span')].some((s) => s.textContent === 'Drop Shadow')");
  await run("inspector.tab", { tab: "transform" });
  await Bun.sleep(200);
  expect(await page.evaluate<boolean>("[...document.querySelectorAll('span')].some((s) => s.textContent === 'Drop Shadow')")).toBe(false);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("a recording's camera and audio are linked and select together; its screen selects alone", async () => {
  await run("selection.clear");
  const camera = clips().find((c) => c.assetId === screen.assetId && c.type === "video")!;
  const audio = clips().find((c) => c.assetId === screen.assetId && c.type === "audio")!;
  expect(screen.linkId).toBeUndefined();
  expect(camera.linkId).toBeDefined();
  expect(audio.linkId).toBe(camera.linkId);
  await run("timeline.view", { start: 0, end: 10 });
  await Bun.sleep(300);
  const s = await session();
  const doc = ui.core.doc(ui.handle);
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const header = headerWidth(doc.tracks);
  // Clear of the playhead (an earlier flow leaves it at 1 s), which a click near would grab.
  const x = box.x + header + ((3 - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const rowY = (id: string) => box.y + 40 + [...doc.tracks].reverse().findIndex((t) => t.clips.some((c) => c.id === id)) * s.timeline.trackHeight + s.timeline.trackHeight / 2;
  await page.click(x, rowY(camera.id));
  await Bun.sleep(300);
  expect([...(await session()).selection].sort()).toEqual([camera.id, audio.id].sort());
  await page.click(x, rowY(screen.id));
  await Bun.sleep(300);
  expect((await session()).selection).toEqual([screen.id]);
  // ⌘-click on a partly selected linked pair selects all of it; again, deselects it.
  await run("selection.set", { clips: [camera.id], linked: false });
  await run("selection.set", { clips: [audio.id], toggle: true });
  expect([...(await session()).selection].sort()).toEqual([camera.id, audio.id].sort());
  await run("selection.set", { clips: [audio.id], toggle: true });
  expect((await session()).selection).toEqual([]);
  await run("selection.clear");
  await run("timeline.zoom", { to: "fit" });
});

test.skipIf(skip)("the Media Bin searches, filters by kind, sorts, shows a list, and marks what is on the timeline; its Import tile imports", async () => {
  await run("panel.show", { tool: "media" });
  await page.until("!!document.querySelector('[data-media-bin]')");
  const shown = () => page.evaluate<number>("document.querySelectorAll('[data-media-bin] [data-asset]').length");
  const all = await shown();
  expect(all).toBeGreaterThan(1);
  // The recording is on the timeline; the Snapshot image isn't.
  expect(await page.evaluate<boolean>(`!!document.querySelector('[data-asset="${screen.assetId}"] [data-used]')`)).toBe(true);
  await page.evaluate("document.querySelector('[data-bin-kind=image]').click()");
  await Bun.sleep(200);
  expect(await shown()).toBe(Object.values(ui.core.doc(ui.handle).assets).filter((a) => a.kind === "image").length);
  await page.evaluate("document.querySelector('[data-bin-kind=all]').click()");
  await page.click(...(await centre("[data-bin-search]")));
  await type("zzz-no-such-media");
  await Bun.sleep(200);
  expect(await shown()).toBe(0);
  await page.key("Escape", "Escape");
  await Bun.sleep(200);
  expect(await shown()).toBe(all);
  await page.evaluate("document.querySelector('[data-bin-view]').click()");
  await Bun.sleep(200);
  expect(await page.evaluate<string>("document.querySelector('[data-bin-view]').title")).toBe("Show as a grid");
  await page.evaluate("document.querySelector('[data-bin-view]').click()");
  await page.evaluate(`(() => { const el = document.querySelector('[data-bin-sort]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'name:true'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await Bun.sleep(200);
  const names = await page.evaluate<string[]>("[...document.querySelectorAll('[data-media-bin] [data-asset]')].map((e) => e.textContent.trim().toLowerCase())");
  expect(names).toEqual([...names].sort().reverse());
  await page.evaluate(`(() => { const el = document.querySelector('[data-bin-sort]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'added:false'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.evaluate("document.querySelector('[data-bin-import]').click()");
  await arrived(() => ui.menus.at(-1) === "import");
  expect(ui.menus.at(-1)).toBe("import");
});

test.skipIf(skip)("Snapshot saves the frame, adds it to the Media Bin and says so with Show in Finder; it can save to a chosen folder, never inside a project", async () => {
  const before = Object.keys(ui.core.doc(ui.handle).assets).length;
  await page.evaluate(`document.querySelector('button[title^="Snapshot"]').click()`);
  await page.until("[...document.querySelectorAll('[data-toast] button')].some((b) => b.textContent === 'Show in Finder')");
  expect(await page.evaluate<string>("document.querySelector('[data-toast]').textContent")).toMatch(/^Saved Snapshot .*\.png/);
  expect(Object.keys(ui.core.doc(ui.handle).assets).length).toBe(before + 1);
  await page.evaluate("document.querySelector('[data-toast] button[title=Dismiss]').click()");
  await page.until("!document.querySelector('[data-toast]')");
  await ui.core.undo(ui.handle);
  // A chosen folder (Settings > General > Save Snapshots To), checked as other writes are.
  const folder = mkdtempSync(join(tmpdir(), "beacon-shots-"));
  const r = await ui.core.captureFrame(ui.handle, 1, { folder });
  expect(r.path.startsWith(folder)).toBe(true);
  expect(existsSync(r.path)).toBe(true);
  await ui.core.undo(ui.handle);
  await expect(ui.core.captureFrame(ui.handle, 1, { folder: join(dir, "e2e.beproj") })).rejects.toThrow(/inside e2e\.beproj/);
  rmSync(folder, { recursive: true, force: true });
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet" });
  await page.until("(document.querySelector('[data-snapshot-folder]')?.textContent ?? '').includes(\"The project's media folder\")");
  await page.key("Escape", "Escape");
});

test.skipIf(skip)("the Export dialog warns when a muted track has audio, and Unmute unmutes only what it lists", async () => {
  const tracks = ui.core.doc(ui.handle).tracks;
  const audioTrack = tracks.find((t) => t.clips.some((c) => c.type === "audio"))!;
  const cameraTrack = tracks.find((t) => t.clips.some((c) => c.type === "video"))!;
  await run("track.set", { track: audioTrack.id, muted: true });
  await run("track.set", { track: cameraTrack.id, muted: true });
  const sheet = { name: "Muted", folder: dir, settings: DEFAULT_EXPORT, canvas: { width: 1920, height: 1080, fps: 30 } };
  ui.send("exportSheet", sheet);
  await page.until("/is muted: its audio won't be in the export/.test(document.querySelector('[data-export-muted]')?.textContent ?? '')");
  await page.evaluate("[...document.querySelectorAll('[data-export-muted] button')].find((b) => b.textContent === 'Unmute').click()");
  await page.until("!document.querySelector('[data-export-muted]')");
  const muted = (id: string) => !!ui.core.doc(ui.handle).tracks.find((t) => t.id === id)!.muted;
  // A camera clip has no audio: its muted track isn't listed and stays muted.
  expect(muted(audioTrack.id)).toBe(false);
  expect(muted(cameraTrack.id)).toBe(true);
  await run("track.set", { track: cameraTrack.id, muted: false });
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-export-muted]') && !document.body.innerText.includes('Encode audio')");
});

test.skipIf(skip)("in the Media Bin, a click selects one item, ⇧-click adds, the empty space clears it and a dragged box selects what it touches", async () => {
  await run("panel.show", { tool: "media" });
  await page.until("document.querySelectorAll('[data-media-bin] [data-asset]').length >= 2");
  const ids = await page.evaluate<string[]>("[...document.querySelectorAll('[data-media-bin] [data-asset]')].map((e) => e.dataset.asset)");
  const selected = () => page.evaluate<string[]>("[...document.querySelectorAll('[data-media-bin] [data-selected]')].map((e) => e.dataset.asset)");
  const tile = (id: string) => centre(`[data-asset="${id}"]`);
  await page.click(...(await tile(ids[0]!)));
  await Bun.sleep(150);
  expect(await selected()).toEqual([ids[0]!]);
  await page.click(...(await tile(ids[1]!)), ["shift"]);
  await Bun.sleep(150);
  expect((await selected()).sort()).toEqual([ids[0]!, ids[1]!].sort());
  // ⌫ deletes both, one undo step.
  const assets = () => Object.keys(ui.core.doc(ui.handle).assets);
  const before = assets().length;
  await page.key("Backspace", "Backspace");
  await arrived(() => assets().length === before - 2);
  expect(assets()).not.toContain(ids[0]!);
  expect(assets()).not.toContain(ids[1]!);
  await ui.core.undo(ui.handle);
  expect(assets().length).toBe(before);
  await page.until(`document.querySelectorAll('[data-media-bin] [data-asset]').length >= ${ids.length}`);
  // Below the last item: the bin's empty space.
  const empty = await page.evaluate<[number, number]>("(() => { const r = document.querySelector('[data-bin-items]').getBoundingClientRect(); return [r.x + r.width / 2, r.bottom - 6]; })()");
  await page.click(...empty);
  await Bun.sleep(150);
  expect(await selected()).toEqual([]);
  // A box from the empty space up over the first two items.
  const [x0, y0] = empty;
  const top = await page.evaluate<number>(`document.querySelector('[data-asset="${ids[0]}"]').getBoundingClientRect().top + 10`);
  const left = await page.evaluate<number>("document.querySelector('[data-bin-items]').getBoundingClientRect().left + 8");
  await page.drag([left, y0], [x0 + 100, top]);
  await Bun.sleep(150);
  expect((await selected()).length).toBeGreaterThanOrEqual(2);
  await page.click(...empty);
});

test.skipIf(skip)("an in/out range's edge drags on the ruler; elsewhere the ruler moves the playhead", async () => {
  await select([]);
  await run("timeline.view", { start: 0, end: 10 });
  await run("range.set", { in: 2, out: 6 });
  await Bun.sleep(200);
  const s = await session();
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const header = headerWidth(ui.core.doc(ui.handle).tracks);
  const xAt = (t: number) => box.x + header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const y = box.y + 12;
  await page.drag([xAt(6), y], [xAt(8), y]);
  await Bun.sleep(300);
  let range = (await session()).range!;
  expect(range.in).toBeCloseTo(2, 1);
  expect(range.out).toBeGreaterThan(7.5);
  await page.click(xAt(4), y);
  await Bun.sleep(300);
  const after = await session();
  expect(after.playhead).toBeCloseTo(4, 0);
  range = after.range!;
  expect(range.in).toBeCloseTo(2, 1);
  await run("range.clear");
  await run("timeline.zoom", { to: "fit" });
});

test.skipIf(skip)("dragging a clip above the top track drops it on a new top track", async () => {
  await select([]);
  const before = ui.core.doc(ui.handle).tracks.length;
  const target = ui.core.doc(ui.handle).tracks.at(-1)!.clips[0]!;
  const [a, b] = [target.start / 705_600_000, (target.start + target.duration) / 705_600_000];
  await run("timeline.view", { start: Math.max(0, a - 1), end: b + 1 });
  await Bun.sleep(200);
  const s = await session();
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const header = headerWidth(ui.core.doc(ui.handle).tracks);
  const x = box.x + header + (((a + b) / 2 - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const y = box.y + 40 + s.timeline.trackHeight / 2;
  await page.drag([x, y], [x, y - s.timeline.trackHeight * 1.2]);
  await Bun.sleep(300);
  const tracks = ui.core.doc(ui.handle).tracks;
  expect(tracks.length).toBe(before + 1);
  expect(tracks.at(-1)!.clips.map((c) => c.id)).toEqual([target.id]);
  await ui.core.undo(ui.handle);
  await run("timeline.zoom", { to: "fit" });
});

test.skipIf(skip)("an annotation's corner handle sizes its box, not its scale, and the opposite corner stays", async () => {
  await run("playhead.set", { time: 1 });
  await select([callout.id]);
  await page.until(`!!document.querySelector('[data-handle="se"][data-clip="${callout.id}"]')`);
  const before = clip(callout.id);
  const box = (c: Clip) => c.props.callout as { width: number; height: number };
  const tr = (c: Clip) => (c.props.transform ?? {}) as { x?: number; y?: number; scaleX?: number };
  const nw = (c: Clip) => [(tr(c).x ?? 0) - (box(c).width * (tr(c).scaleX ?? 1)) / 2, (tr(c).y ?? 0) + (box(c).height * (tr(c).scaleX ?? 1)) / 2];
  const [x, y] = await centre(`[data-handle="se"][data-clip="${callout.id}"]`);
  await page.drag([x, y], [x + 60, y + 30]);
  await Bun.sleep(300);
  const after = clip(callout.id);
  expect(box(after).width).toBeGreaterThan(box(before).width);
  expect(box(after).height).toBeGreaterThan(box(before).height);
  expect(tr(after).scaleX ?? 1).toBe(tr(before).scaleX ?? 1);
  const [a, b] = [nw(before), nw(after)];
  expect(Math.abs(a[0]! - b[0]!)).toBeLessThan(1);
  expect(Math.abs(a[1]! - b[1]!)).toBeLessThan(1);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("a video's Media Bin tile shows its proxy being made, then a P badge; deleting the proxy removes the badge and its files", async () => {
  // A fresh copy has no cached proxy, so making it is real work.
  const copy = join(dir, `like-${Date.now()}.mp4`);
  copyFileSync(join(FIXTURES, "video.mp4"), copy);
  const { assets } = await ui.core.import(ui.handle, [copy]);
  const tile = `[data-asset="${assets[0]}"]`;
  await run("panel.show", { tool: "media" });
  ui.core.attachView(ui.handle, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: true });
  await page.until(`!!document.querySelector('${tile} [data-proxy-progress]')`, 10000);
  expect(await page.evaluate<string>(`document.querySelector('[data-preparing]')?.textContent ?? ''`)).toMatch(/^Preparing media for scrubbing \d+ of \d+$/);
  await page.until(`!!document.querySelector('${tile} [data-proxy]')`, 60000);
  ui.core.detachView(ui.handle);
  const proxy = ui.core.derived<{ streams: Record<number, { path: string }> }>(ui.handle, assets[0]!, "proxy")!;
  expect(existsSync(proxy.streams[0]!.path)).toBe(true);
  expect(await ui.core.forget(ui.handle, "proxy", assets[0]!)).toBe(true);
  await page.until(`!document.querySelector('${tile} [data-proxy]')`, 5000);
  expect(existsSync(proxy.streams[0]!.path)).toBe(false);
  await ui.core.undo(ui.handle);
}, 90000);

test.skipIf(skip)("a stitched clip has a thumbnail: what its first frame shows", async () => {
  const s = clip(screen.id);
  const at = (s.start + s.duration / 2) / 705_600_000;
  await run("clip.split", { at, clips: [s.id], linked: false });
  const pieces = ui.core.doc(ui.handle).tracks.flatMap((t) => t.clips).filter((c) => c.assetId === s.assetId && c.type === s.type);
  const r = (await run("clip.stitch", { clips: pieces.map((c) => c.id) })) as { result?: unknown };
  const stitched = ui.core.doc(ui.handle).tracks.flatMap((t) => t.clips).find((c) => c.type === "stitched")!;
  expect(stitched, JSON.stringify(r)).toBeDefined();
  const png = await ui.core.thumbnail(ui.handle, stitched.id, 40);
  expect(png?.length ?? 0).toBeGreaterThan(100);
  await ui.core.undo(ui.handle);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("an audio file in the Media Bin shows its waveform", async () => {
  const copy = join(dir, `voice-${Date.now()}.m4a`);
  copyFileSync(join(FIXTURES, "audio.m4a"), copy);
  const { assets } = await ui.core.import(ui.handle, [copy]);
  await run("panel.show", { tool: "media" });
  ui.core.attachView(ui.handle, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: true });
  await page.until(`!!document.querySelector('[data-asset="${assets[0]}"] [data-waveform]')`, 60000);
  ui.core.detachView(ui.handle);
  await ui.core.undo(ui.handle);
}, 90000);

test.skipIf(skip)("Settings choose which media get proxies on their own (the rest wait for Create Proxy Video) and how quietly they are built", async () => {
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet" });
  await page.until(`!!document.querySelector('[data-auto-proxy]')`);
  await page.evaluate(`[...document.querySelectorAll('[data-auto-proxy] button')].find((b) => b.textContent.includes('Video files')).click()`);
  await arrived(() => ui.menus.at(-1) === `setAppSettings:${JSON.stringify({ exportColorSpace: "bt709", autoProxy: { recording: true, video: false }, proxyMode: "quiet" })}`);
  expect(ui.menus.at(-1)).toBe(`setAppSettings:${JSON.stringify({ exportColorSpace: "bt709", autoProxy: { recording: true, video: false }, proxyMode: "quiet" })}`);
  await page.evaluate(`(() => { const el = document.querySelector('[data-proxy-mode]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'fast'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await arrived(() => ui.menus.at(-1) === `setAppSettings:${JSON.stringify({ exportColorSpace: "bt709", autoProxy: { recording: true, video: false }, proxyMode: "fast" })}`);
  expect(ui.menus.at(-1)).toBe(`setAppSettings:${JSON.stringify({ exportColorSpace: "bt709", autoProxy: { recording: true, video: false }, proxyMode: "fast" })}`);
  await page.key("Escape", "Escape");
  // What the app does with it: no proxy is started for a video file.
  ui.core.setAutomatic((analyzer, asset) => analyzer !== "proxy" || asset.kind === "recording");
  const copy = join(dir, `like-${Date.now()}.mp4`);
  copyFileSync(join(FIXTURES, "video.mp4"), copy);
  const { assets } = await ui.core.import(ui.handle, [copy]);
  ui.core.attachView(ui.handle, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: true });
  await Bun.sleep(1500);
  expect((await ui.core.jobs()).some((j) => j.kind === "proxy" && j.asset === assets[0])).toBe(false);
  ui.core.detachView(ui.handle);
  ui.core.setAutomatic(() => true);
  await ui.core.undo(ui.handle);
}, 30000);

test.skipIf(skip)("Settings > General shows the space proxies use, and Delete All Proxy Videos deletes every one", async () => {
  // Its own cache, so the user's proxies are never touched.
  const cacheDir = join(dir, "cache");
  const core = new LocalCore({ cacheDir });
  const path = join(dir, "proxies.beproj");
  const h = await core.create({ path });
  const copy = join(dir, `like-${Date.now()}.mp4`);
  copyFileSync(join(FIXTURES, "video.mp4"), copy);
  const { assets } = await core.import(h, [copy]);
  await core.close(h);
  const other = await serveUi(path, { cacheDir });
  const p = await openPage(other.url);
  try {
    const tile = `[data-asset="${assets[0]}"]`;
    await other.core.run(other.handle, "panel.show", { tool: "media" });
    other.core.attachView(other.handle, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: true });
    await p.until(`!!document.querySelector('${tile} [data-proxy]')`, 60000);
    const used = await other.core.analysisSize("proxy");
    expect(used).toBeGreaterThan(0);
    other.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet" });
    await p.until(`/\\d+ [KMG]B used/.test(document.querySelector('[data-proxy-space]')?.textContent ?? '')`);
    await p.evaluate(`[...document.querySelectorAll('[data-proxy-space] button')].find((b) => b.textContent === 'Delete All Proxy Videos').click()`);
    await p.until(`(document.querySelector('[data-proxy-space]')?.textContent ?? '').includes('No proxy videos')`, 10000);
    await p.until(`!document.querySelector('${tile} [data-proxy]')`, 5000);
    expect(existsSync(join(cacheDir, "proxies"))).toBe(false);
    expect(other.core.derived(other.handle, assets[0]!, "proxy")).toBeUndefined();
  } finally {
    p.close();
    await other.close();
  }
}, 90000);

test.skipIf(skip)("moved media shows Missing on its Media Bin tile and builds no proxy; Locate Media finds it, one undo step", async () => {
  const like = join(FIXTURES, "video.mp4");
  const copy = join(dir, `moved-${Date.now()}.mp4`);
  copyFileSync(like, copy);
  const { assets } = await ui.core.import(ui.handle, [copy]);
  const tile = `[data-asset="${assets[0]}"]`;
  await run("panel.show", { tool: "media" });
  const moved = join(dir, `moved-elsewhere-${Date.now()}.mp4`);
  renameSync(copy, moved);
  await ui.checkMissing();
  await page.until(`!!document.querySelector('${tile} [data-missing]')`);
  expect(await ui.core.missing(ui.handle)).toEqual([assets[0]!]);
  await expect(ui.core.analyze(ui.handle, "proxy", assets[0]!)).rejects.toThrow(/is missing/);
  // Another file isn't taken for it.
  const other = join(dir, `voice-${Date.now()}.m4a`);
  copyFileSync(join(FIXTURES, "audio.m4a"), other);
  await expect(ui.core.relink(ui.handle, assets[0]!, other)).rejects.toThrow(/same kind/);
  await ui.core.relink(ui.handle, assets[0]!, moved);
  await page.until(`!document.querySelector('${tile} [data-missing]')`);
  expect(ui.core.doc(ui.handle).assets[assets[0]!]!.path).toBe(moved);
  await ui.core.undo(ui.handle);
  expect(ui.core.doc(ui.handle).assets[assets[0]!]!.path).toBe(copy);
  await ui.core.undo(ui.handle);
}, 30000);

test.skipIf(skip)("⌘S confirms the project is saved automatically, with no dialog", async () => {
  await page.key("s", "KeyS", ["meta"]);
  await page.until(`(document.querySelector('[data-saved]')?.textContent ?? '').startsWith('✓')`, 1000);
  expect(await has("[role=dialog]")).toBe(false);
  await page.until(`!(document.querySelector('[data-saved]')?.textContent ?? '').startsWith('✓')`, 3000);
});

test.skipIf(skip)("every track's header has mute, lock and eye: mute and lock toggle the track", async () => {
  const height = (await session()).timeline.trackHeight;
  await run("timeline.trackHeight", { height: 50 });
  await Bun.sleep(200);
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const [lx, ly] = headerIcons(0, 50, headerWidth(ui.core.doc(ui.handle).tracks)).lock;
  const top = () => ui.core.doc(ui.handle).tracks.at(-1)!;
  expect(top().locked ?? false).toBe(false);
  await page.click(box.x + lx, box.y + ly);
  await Bun.sleep(200);
  expect(top().locked).toBe(true);
  await page.click(box.x + lx, box.y + ly);
  await Bun.sleep(200);
  expect(top().locked ?? false).toBe(false);
  const [mx, my] = headerIcons(0, 50, headerWidth(ui.core.doc(ui.handle).tracks)).mute;
  await page.click(box.x + mx, box.y + my);
  await Bun.sleep(200);
  expect(top().muted).toBe(true);
  await ui.core.undo(ui.handle);
  expect(top().muted ?? false).toBe(false);
  await run("timeline.trackHeight", { height });
});

test.skipIf(skip)("an animation is drawn as two diamonds joined by a band; the diamond clicked turns red", async () => {
  await select([screen.id]);
  await run("playhead.set", { time: 4 });
  await run("edit.addAnimation", {});
  // The playhead's line would cover the diamond.
  await run("playhead.set", { time: 9 });
  await run("timeline.view", { start: 0, end: 12 });
  await Bun.sleep(300);
  const doc = ui.core.doc(ui.handle);
  const c = doc.tracks.flatMap((t) => t.clips).find((k) => k.id === screen.id)!;
  const anim = c.animations.at(-1)!;
  const end = (c.start + (anim.end - (c.mediaStart ?? 0))) / 705_600_000;
  const s = await session();
  const header = headerWidth(doc.tracks);
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const row = doc.tracks.length - 1 - doc.tracks.findIndex((t) => t.clips.some((k) => k.id === screen.id));
  const px = header + ((end - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const py = 40 + row * s.timeline.trackHeight + s.timeline.trackHeight / 2;
  const pixel = () => page.evaluate<number[]>(`(() => { const c = document.querySelector('canvas[data-timeline]'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(${px} * k), Math.round(${py} * k), 1, 1).data]; })()`);
  const [r0, g0] = await pixel();
  expect(r0! > 150 && g0! < 150).toBe(false);
  await page.click(box.x + px, box.y + py);
  await Bun.sleep(300);
  const [r, g, b] = await pixel();
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(130);
  expect(b).toBeLessThan(130);
  // Deselected, then selected again from Properties: no diamond was clicked this time.
  await run("animation.select", {});
  await Bun.sleep(300);
  await run("animation.select", { clip: screen.id, animation: anim.id });
  await Bun.sleep(300);
  const [r2, g2] = await pixel();
  expect(r2! > 200 && g2! < 130).toBe(false);
  await run("animation.select", {});
  await ui.core.undo(ui.handle);
  await run("timeline.zoom", { to: "fit" });
});

test.skipIf(skip)("right-click on the canvas: a clip's menu over a clip, the canvas menu elsewhere; Project Settings opens on the Project tab", async () => {
  await run("selection.clear");
  await run("playhead.set", { time: 10 });
  await Bun.sleep(300);
  const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('[data-canvas-overlay]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await page.rightClick(box.x + box.w / 2, box.y + box.h / 2);
  await Bun.sleep(300);
  // The clip under the pointer gets the menu; its recording's linked clips are selected with it.
  const sel = (await session()).selection;
  const hit = clip(ui.menus.at(-1)!);
  expect(sel[0]).toBe(hit.id);
  expect([...sel].sort()).toEqual(clips().filter((c) => c.linkId && c.linkId === hit.linkId).map((c) => c.id).sort());
  // Zoomed out, the stage around the canvas is empty.
  await run("canvas.zoom", { zoom: 20 });
  await Bun.sleep(300);
  await page.rightClick(box.x + 4, box.y + 4);
  await arrived(() => ui.menus.at(-1) === "canvas");
  expect(ui.menus.at(-1)).toBe("canvas");
  await run("canvas.zoom", { zoom: "fit" });
  // What Project Settings… does in the app.
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet", tab: "project" });
  await page.until(`!!document.querySelector('[data-canvas-settings]')`);
  await page.key("Escape", "Escape");
  await run("selection.clear");
});

test.skipIf(skip)("⌫ on a selected Media item deletes it (one undo step); after a click on the timeline it goes to the timeline instead", async () => {
  const copy = join(dir, `del-${Date.now()}.mp4`);
  copyFileSync(join(FIXTURES, "video.mp4"), copy);
  const { assets } = await ui.core.import(ui.handle, [copy]);
  const id = assets[0]!;
  await run("panel.show", { tool: "media" });
  await page.until(`!!document.querySelector('[data-asset="${id}"]')`);
  await page.click(...(await centre(`[data-asset="${id}"]`)));
  await page.key("Backspace", "Backspace");
  await page.until(`!document.querySelector('[data-asset="${id}"]')`);
  expect(ui.core.doc(ui.handle).assets[id]).toBeUndefined();
  await ui.core.undo(ui.handle);
  await page.until(`!!document.querySelector('[data-asset="${id}"]')`);
  // Clicked, then the timeline clicked: the key no longer belongs to the tile.
  await page.click(...(await centre(`[data-asset="${id}"]`)));
  await run("selection.clear");
  const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await page.click(box.x + box.w - 20, box.y + box.h - 10);
  await page.key("Backspace", "Backspace");
  await Bun.sleep(300);
  expect(ui.core.doc(ui.handle).assets[id]).toBeDefined();
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("Settings keeps focus where it is while the editor re-renders (an open dropdown stays open)", async () => {
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet" });
  await page.until(`!!document.querySelector('[data-proxy-mode]')`);
  await page.evaluate(`document.querySelector('[data-proxy-mode]').focus()`);
  // What proxy progress does while Settings is open.
  for (let i = 0; i < 3; i++) {
    ui.send("status", { text: `building ${i}` });
    ui.send("media", { preparing: { x: i / 3 } });
    await Bun.sleep(100);
  }
  expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('[data-proxy-mode]')`)).toBe(true);
  await page.key("Escape", "Escape");
});

test.skipIf(skip)("holding ⌥ over a selected clip's handles shows the crop cursor, and a ⌥-drag keeps it while cropping", async () => {
  await run("playhead.set", { time: 1 });
  await select([screen.id]);
  const handle = `[data-handle="e"][data-clip="${screen.id}"]`;
  await page.until(`!!document.querySelector('${handle}')`);
  const cursor = () => page.evaluate<string>(`document.querySelector('${handle}').style.cursor`);
  expect(await cursor()).toContain("resize");
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltLeft", altKey: true }))`);
  await page.until(`document.querySelector('${handle}').style.cursor.startsWith('url(')`);
  const [x, y] = await centre(handle);
  await page.down(x, y, ["alt"]);
  await page.move(x - 30, y, ["alt"]);
  await page.until(`[...document.querySelectorAll('div')].some((d) => d.style.cursor.startsWith('url(') && !d.dataset.handle)`);
  await page.up(x - 30, y, ["alt"]);
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltLeft", altKey: false }))`);
  await page.until(`document.querySelector('${handle}').style.cursor.includes('resize')`);
  expect(((clip(screen.id).props.crop ?? {}) as { right?: number }).right ?? 0).toBeGreaterThan(0);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("the corner above the track headers: + adds a track (one undo step), ⌄ opens the tracks menu", async () => {
  const doc = ui.core.doc(ui.handle);
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const [add, menu] = cornerButtons(headerWidth(doc.tracks));
  await page.click(box.x + add!.x + add!.w / 2, box.y + add!.y + add!.h / 2);
  await Bun.sleep(300);
  expect(ui.core.doc(ui.handle).tracks.length).toBe(doc.tracks.length + 1);
  await ui.core.undo(ui.handle);
  expect(ui.core.doc(ui.handle).tracks.length).toBe(doc.tracks.length);
  await Bun.sleep(300);
  await page.click(box.x + menu!.x + menu!.w / 2, box.y + menu!.y + menu!.h / 2);
  await arrived(() => ui.menus.at(-1) === "track:null");
  expect(ui.menus.at(-1)).toBe("track:null");
});

test.skipIf(skip)("an effect's colour parameter (one the schema marks as a colour) shows a swatch", async () => {
  await run("effect.add", { clip: screen.id, type: "drop-shadow" });
  await select([screen.id]);
  await run("inspector.tab", { tab: "effects" });
  await page.until(`[...document.querySelectorAll('button[title]')].some((b) => /^colou?r$/i.test(b.title))`);
  await ui.core.undo(ui.handle);
});
