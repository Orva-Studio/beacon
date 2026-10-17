import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";
import { DerivedData } from "@beacon/render";
import { projectDuration, ticksToSeconds, type Clip } from "@beacon/model";
import { openPage } from "./browser";
import { serveUi } from "./serve";
import { clipBox, cornerButtons, headerIcons, headerWidth } from "../../packages/ui/src/timeline-layout";
import { DEFAULT_EXPORT } from "../../packages/ui/src/export-defaults";

/**
 * The editor's flows, driven in headless Chromium against a LocalCore (no window, no screen): what was
 * rehearsed by hand each session, kept so it can't quietly break. A real recording, read only.
 */
const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const skip = ![RECORDING, join(FIXTURES, "video.mp4"), join(FIXTURES, "audio.m4a")].every(existsSync);

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
  await page.click(...(await centre('[aria-label="Standalone project"]')));
  await page.until(`document.querySelector('[aria-label="Standalone project"]').getAttribute('aria-checked') === 'true'`);
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
  expect(ui.menus).toContain("newProjectStandalone");
});

test.skipIf(skip)("opened without a project, the start screen offers New Project, the last four projects with when each was opened, and Open…", async () => {
  const path = join(dir, "start.beproj");
  const core = new LocalCore();
  await core.close(await core.create({ path }));
  const now = Date.now();
  const recent = [
    { path, name: "start", opened: now - 5 * 60_000 },
    { path: "/Users/someone/Movies/Beacon/Launch.beproj", name: "Launch", opened: now - 3 * 3_600_000, thumb: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    { path: "/Users/someone/Movies/Beacon/Tutorial.beproj", name: "Tutorial", opened: now - 26 * 3_600_000 },
    { path: "/Users/someone/Movies/Beacon/Old.beproj", name: "Old", opened: new Date(2025, 2, 3, 12).getTime() },
    { path: "/Users/someone/Movies/Beacon/Fifth.beproj", name: "Fifth", opened: new Date(2025, 1, 1).getTime() },
  ];
  const start = await serveUi(path, { closed: true, recent });
  const view = await openPage(start.url);
  try {
    const rows = `[...document.querySelectorAll('[data-recent]')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`;
    await view.until("!!document.querySelector('[data-start-screen]')");
    const shown = await view.evaluate<string[]>(rows);
    expect(shown.slice(0, 3)).toEqual(["start 5 minutes ago", "Launch 3 hours ago", "Tutorial yesterday"]);
    // Each shows the project as it was last left, when the app has a picture of it.
    expect(await view.evaluate<boolean[]>(`[...document.querySelectorAll('[data-recent]')].map((r) => !!r.querySelector('img'))`)).toEqual([false, true, false, false]);
    // Older ones by date, in the Mac's format.
    expect(shown[3]).toMatch(/^Old .*\b3\b.*2025$/);
    // Nothing to go back to: Escape leaves it open.
    await view.key("Escape", "Escape");
    await Bun.sleep(100);
    expect(await view.evaluate<boolean>("!!document.querySelector('[data-start-screen]')")).toBe(true);
    // New Project replaces it; cancelled, it is back.
    await view.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'New Project').click()`);
    await view.until("!document.querySelector('[data-start-screen]') && document.body.innerText.includes('Standalone project')");
    await view.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click()`);
    await view.until("!!document.querySelector('[data-start-screen]')");
    // The list follows Open Recent as the app changes it.
    start.send("recent", recent.slice(1));
    await view.until(`${rows}.length === 4 && ${rows}[0].startsWith('Launch')`);
    start.send("recent", recent);
    await view.until(`${rows}[0].startsWith('start ')`);
    await view.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Open…').click()`);
    await arrived(() => start.menus.includes("openDialog"));
    expect(start.menus).toContain("openDialog");
    await view.until("!document.querySelector('[data-start-screen]')");
  } finally {
    view.close();
    await start.close();
  }
  // A click on a recent project opens it, and the editor shows it.
  const again = await serveUi(path, { closed: true, recent });
  const page2 = await openPage(again.url);
  try {
    await page2.until("!!document.querySelector('[data-start-screen]')");
    await page2.click(...(await page2.evaluate<[number, number]>(`(() => { const r = document.querySelector('[data-recent="${path}"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`)));
    await page2.until(`!document.querySelector('[data-start-screen]') && !!document.querySelector('[title="Rename the project"]')`);
    expect(again.menus).toContain(`openRecent:${path}`);
  } finally {
    page2.close();
    await again.close();
  }
}, 30000);

test.skipIf(skip)("Save As asks for a name, a folder and standalone; a name that is taken keeps the dialog open with why", async () => {
  ui.send("saveAsSheet", { name: "Episode 12 copy", folder: "/Users/someone/Projects", standalone: false });
  await page.until("document.body.innerText.includes('Save As')");
  expect(await page.evaluate<string>(`document.body.innerText`)).toContain("~/Projects");
  await type("Taken");
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Save').click()`);
  await page.until("document.body.innerText.includes('Taken.beproj already exists')");
  await page.evaluate(`[...document.querySelectorAll('[tabindex="-1"]')].find((d) => d.innerText.includes('Save As')).querySelector('input').focus()`);
  await type("Episode 12 to share");
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Choose…').click()`);
  await page.until("document.body.innerText.includes('~/Shared')");
  await page.click(...(await centre('[aria-label="Standalone project"]')));
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Save').click()`);
  await page.until("!document.body.innerText.includes('Save As')");
  expect(ui.menus).toContain("saveAs:/Users/someone/Shared/Episode 12 to share (standalone)");
});

test.skipIf(skip)("the speech model is downloaded only when the user agrees, with progress; Not Now is remembered; Settings offers it again", async () => {
  const model = { id: "whisper-model", title: "Whisper large-v3-turbo speech model", description: "Transcripts are made on this Mac.", bytes: 574_041_195, present: false };
  const button = (label: string) => `[...document.querySelectorAll('button')].find((b) => b.textContent === '${label}')`;
  ui.send("resourceSheet", model);
  await page.until("document.body.innerText.includes('Download the Whisper large-v3-turbo speech model?')");
  expect(await page.evaluate<string>("document.querySelector('[data-resource]').innerText")).toContain("about 574 MB");
  await page.evaluate(`${button("Not Now")}.click()`);
  await page.until("!document.querySelector('[data-resource]')");
  await arrived(() => ui.menus.includes("declineResource:whisper-model"));
  expect(ui.menus).toContain("declineResource:whisper-model");
  expect(ui.menus).not.toContain("fetchResource:whisper-model");

  // Settings › General offers it again; downloading shows progress, Cancel stops it, Hide leaves it running.
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet", resources: [model], preferences: await ui.core.preferences() });
  await page.until(`!!${button("Download Speech Model…")}`);
  await page.evaluate(`${button("Download Speech Model…")}.click()`);
  await page.until("!!document.querySelector('[data-resource]')");
  await page.evaluate(`${button("Download")}.click()`);
  await arrived(() => ui.menus.includes("fetchResource:whisper-model"));
  ui.send("resourceJob", { id: "job-download", state: "running", progress: 0.42 });
  await page.until("document.querySelector('[data-resource-progress]')?.innerText.includes('42%')");
  await page.evaluate(`${button("Cancel Download")}.click()`);
  await arrived(() => ui.menus.includes("cancelJob:job-download"));
  ui.send("resourceJob", { id: "job-download", state: "failed", progress: 0.42, error: "cancelled" });
  await page.until(`!!${button("Download")}`);
  await page.evaluate(`${button("Download")}.click()`);
  ui.send("resourceJob", { id: "job-download", state: "running", progress: 0.9 });
  await page.until("document.querySelector('[data-resource-progress]')?.innerText.includes('90%')");
  ui.send("resourceJob", { id: "job-download", state: "done", progress: 1 });
  await page.until("!document.querySelector('[data-resource]')");
});

test.skipIf(skip)("Settings › Transcripts picks the transcriber; OpenAI's waits for a key, says the audio is uploaded, and removing the key goes back to Whisper", async () => {
  const model = { id: "whisper-model", title: "Whisper large-v3-turbo speech model", description: "", bytes: 574_041_195, present: false };
  const button = (label: string) => `[...document.querySelectorAll('button')].find((b) => b.textContent === '${label}')`;
  const pick = (value: string) => page.evaluate(`(() => { const s = document.querySelector('[data-transcriber]'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const value = async () => (await ui.core.preferences()).find((p) => p.id === "transcriber")!.value;
  // Changing the transcriber transcribes the project's media again: not here (OpenAI's would be sent the test key).
  ui.core.setAutomatic((analyzer) => analyzer !== "transcript");
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet", resources: [model], preferences: await ui.core.preferences() });
  await page.until("document.querySelector('[data-transcriber]')?.value === 'whisper'");
  expect(await has("[data-resource-row]")).toBe(true);
  // Apple's needs nothing: chosen at once, and the model isn't offered.
  await pick("apple");
  await arrived(() => ui.menus.includes("setPreference:transcriber=apple"));
  await page.until("!document.querySelector('[data-resource-row]')");
  expect(await value()).toBe("apple");
  // OpenAI's waits for its key, and says where the audio goes.
  await pick("openai");
  await page.until("!!document.querySelector('[data-api-key=\"unset\"]')");
  expect(await page.evaluate<string>(`document.querySelector('[data-api-key]').closest('[tabindex="-1"]').innerText`)).toContain("uploaded to OpenAI");
  expect(await value()).toBe("apple");
  expect(ui.menus).not.toContain("setPreference:transcriber=openai");
  await page.click(...(await centre('[data-api-key="unset"] input')));
  await type("sk-test-123");
  await page.evaluate(`${button("Save and Use")}.click()`);
  await page.until("!!document.querySelector('[data-api-key=\"set\"]')");
  expect(ui.menus).toContain("setSecret:openai-api-key=set");
  expect(await value()).toBe("openai");
  // An agent can't choose an option whose key is missing; without its key, OpenAI's goes back to Whisper.
  await page.evaluate(`${button("Remove")}.click()`);
  await page.until("document.querySelector('[data-transcriber]')?.value === 'whisper'");
  expect(await value()).toBe("whisper");
  await expect(ui.core.setPreference("transcriber", "openai")).rejects.toThrow(/only the user can add/);
  await page.evaluate(`${button("Done")}.click()`);
  await page.until("!document.querySelector('[data-transcriber]')");
  ui.core.setAutomatic(() => true);
}, 20000);

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

test.skipIf(skip)("the Media Bin searches, filters by kind, sorts and shows a list; its Import tile imports", async () => {
  await run("panel.show", { tool: "media" });
  await page.until("!!document.querySelector('[data-media-bin]')");
  const shown = () => page.evaluate<number>("document.querySelectorAll('[data-media-bin] [data-asset]').length");
  const all = await shown();
  expect(all).toBeGreaterThan(1);
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

test.skipIf(skip)("Record lists the sources with their devices, counts down, and asks for what was chosen", async () => {
  const sheet = {
    permissions: { screen: "granted", camera: "denied", microphone: "granted" },
    displays: [{ id: 1, width: 1800, height: 1169 }],
    cameras: [{ id: "cam-1", name: "Elgato 4K X" }, { id: "cam-2", name: "MacBook Pro Camera" }],
    microphones: [{ id: "mic-1", name: "Blue Yeti" }, { id: "mic-2", name: "MacBook Pro Microphone" }],
    sources: { screen: { fps: 60 }, microphone: { id: "mic-1" }, systemAudio: true },
  };
  ui.send("recordSheet", sheet);
  await page.until("!!document.querySelector('[data-record]')");
  const on = (label: string) => page.evaluate<boolean>(`document.querySelector('[data-source="${label}"]').checked`);
  expect([await on("Screen"), await on("Camera"), await on("Microphone"), await on("System audio")]).toEqual([true, false, true, true]);
  await page.evaluate(`document.querySelector('[data-source="Camera"]').click()`);
  await page.until("!!document.querySelector('[data-permission=camera]')");
  await page.evaluate(`document.querySelector('[data-source="System audio"]').click()`);
  const before = ui.menus.length;
  await page.evaluate("document.querySelector('[data-record-start]').click()");
  await page.until("!!document.querySelector('[data-countdown]')");
  await page.until("!document.querySelector('[data-countdown]') && !document.querySelector('[data-record]')", 6000);
  const asked = ui.menus.slice(before).find((m) => m.startsWith("startRecording:"))!;
  expect(JSON.parse(asked.slice("startRecording:".length))).toEqual({ screen: { display: 1, fps: 60 }, microphone: { id: "mic-1" }, camera: { id: "cam-1" } });
});

test.skipIf(skip)("Record previews the chosen screen and camera with the size each records at, and both audio levels, and stops when closed", async () => {
  const sheet = {
    permissions: { screen: "granted", camera: "granted", microphone: "granted" },
    displays: [{ id: 1, width: 1800, height: 1169, pixelWidth: 3600, pixelHeight: 2338 }],
    cameras: [{ id: "cam-1", name: "Elgato 4K X", width: 3840, height: 2160, fps: 30 }, { id: "cam-2", name: "MacBook Pro Camera", width: 1280, height: 720, fps: 30 }],
    microphones: [{ id: "mic-1", name: "Blue Yeti" }],
    sources: { screen: { display: 1, fps: 60 }, systemAudio: true, camera: { id: "cam-1" }, microphone: { id: "mic-1" } },
  };
  const before = ui.menus.length;
  ui.send("recordSheet", sheet);
  await page.until(
    "!!document.querySelector('[data-preview=Screen]') && !!document.querySelector('[data-preview=Camera]') && document.querySelector('[aria-label=\"Microphone level\"]')?.dataset.level === '-20' && document.querySelector('[aria-label=\"System audio level\"]')?.dataset.level === '-30'",
  );
  expect(await page.evaluate<string>("document.querySelector('[data-preview=Camera]').src")).toStartWith("data:image/jpeg;base64,");
  const size = (label: string) => page.evaluate<string>(`document.querySelector('[data-record-size=${label}]')?.textContent ?? ''`);
  expect([await size("Screen"), await size("Camera")]).toEqual(["3600 × 2338 · 60 fps", "3840 × 2160 · 30 fps"]);
  const previews = () => ui.menus.slice(before).filter((m) => m.startsWith("recordPreview:")).map((m) => JSON.parse(m.slice("recordPreview:".length)));
  expect(previews().at(-1)).toEqual({ screen: { display: 1 }, systemAudio: true, camera: { id: "cam-1" }, microphone: { id: "mic-1" } });
  // Another camera is previewed instead.
  await page.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'cam-2')); s.value = 'cam-2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await arrived(() => previews().at(-1)?.camera?.id === "cam-2");
  await page.until(`document.querySelector('[data-record-size=Camera]')?.textContent === '1280 × 720 · 30 fps'`);
  // A source turned off shows as off.
  await page.evaluate(`document.querySelector('[data-source="Screen"]').click()`);
  await page.until("!document.querySelector('[data-preview=Screen]') && document.querySelector('[data-record-monitors]').textContent.includes('Off')");
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-record]')");
  await arrived(() => JSON.stringify(previews().at(-1)) === "{}");
  expect(previews().at(-1)).toEqual({});
});

test.skipIf(skip)("Record moves a remembered display, camera or microphone that was unplugged to one that is there", async () => {
  const sheet = {
    permissions: { screen: "granted", camera: "granted", microphone: "granted" },
    displays: [{ id: 1, width: 1800, height: 1169 }],
    cameras: [{ id: "cam-1", name: "Elgato 4K X" }],
    microphones: [{ id: "mic-1", name: "Blue Yeti" }],
    sources: { screen: { display: 5, fps: 30 }, camera: { id: "gone" }, microphone: { id: "gone" } },
  };
  const before = ui.menus.length;
  ui.send("recordSheet", sheet);
  await page.until("!!document.querySelector('[data-record]')");
  const previews = () => ui.menus.slice(before).filter((m) => m.startsWith("recordPreview:")).map((m) => JSON.parse(m.slice("recordPreview:".length)));
  await arrived(() => previews().length > 0);
  expect(previews()[0]).toEqual({ screen: { display: 1 }, camera: { id: "cam-1" }, microphone: { id: "mic-1" } });
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-record]')");
});

test.skipIf(skip)("Record lists displays at the size each records at, and follows a display unplugged and plugged back while open", async () => {
  const big = { id: 5, width: 3360, height: 1890, pixelWidth: 3840, pixelHeight: 2160 };
  const laptop = { id: 1, width: 1800, height: 1169, pixelWidth: 3326, pixelHeight: 2160 };
  const devices = { permissions: { screen: "granted", camera: "granted", microphone: "granted" }, cameras: [], microphones: [], outputs: [] };
  const before = ui.menus.length;
  ui.send("recordSheet", { ...devices, displays: [big, laptop], sources: { screen: { display: 5, fps: 60 } } });
  await page.until("!!document.querySelector('[data-record]')");
  const options = () => page.evaluate<string[]>("[...document.querySelector('[data-record] select').options].map((o) => o.textContent)");
  expect(await options()).toEqual(["Display 1 (3840 × 2160)", "Display 2 (3326 × 2160)"]);
  const previews = () => ui.menus.slice(before).filter((m) => m.startsWith("recordPreview:")).map((m) => JSON.parse(m.slice("recordPreview:".length)));
  await arrived(() => previews().at(-1)?.screen?.display === 5);
  ui.send("recordDevices", { ...devices, displays: [laptop] });
  await arrived(() => previews().at(-1)?.screen?.display === 1);
  expect(await options()).toEqual(["Display 1 (3326 × 2160)"]);
  expect(await page.evaluate<string>("document.querySelector('[data-record-size=Screen]')?.textContent ?? ''")).toBe("3326 × 2160 · 60 fps");
  ui.send("recordDevices", { ...devices, displays: [big, laptop] });
  await page.until("document.querySelector('[data-record] select').options.length === 2");
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-record]')");
  // With the dialog closed, a change doesn't open it.
  ui.send("recordDevices", { ...devices, displays: [laptop] });
  await Bun.sleep(200);
  expect(await page.evaluate<boolean>("!!document.querySelector('[data-record]')")).toBe(false);
});

test.skipIf(skip)("The Record button at the top left opens the Record dialog, as File › Record… does, and hides while narrating", async () => {
  await page.until("!!document.querySelector('[data-record-button]')");
  const left = (selector: string) => page.evaluate<number>(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().left`);
  // First in the title bar, after the window's own buttons.
  expect(await page.evaluate<boolean>("document.querySelector('[data-titlebar]').firstElementChild.matches('[data-record-button]')")).toBe(true);
  expect(await left("[data-record-button]")).toBeLessThan(await left("[data-titlebar] button:not([data-record-button])"));
  const before = ui.menus.length;
  await page.evaluate("document.querySelector('[data-record-button]').click()");
  await arrived(() => ui.menus.slice(before).includes("openRecord"));
  expect(ui.menus.slice(before)).toContain("openRecord");
  ui.send("narrating", { started: Date.now(), from: 0, until: 5 });
  await page.until("!document.querySelector('[data-record-button]') && !!document.querySelector('[data-narrating]')");
  ui.send("narrating", null);
  await page.until("!!document.querySelector('[data-record-button]') && !document.querySelector('[data-narrating]')");
});

test.skipIf(skip)("The Narration panel records a narration itself, as Camtasia's does: microphone and level, the timeline's sound off by default, a countdown, Stop", async () => {
  ui.setNarrationDevices({
    permissions: { screen: "granted", camera: "granted", microphone: "granted" },
    displays: [],
    cameras: [],
    microphones: [{ id: "mic-1", name: "Blue Yeti" }, { id: "mic-2", name: "MacBook Pro Microphone" }],
    outputs: [],
    sources: { microphone: { id: "mic-2" } },
    hear: false,
  });
  await run("range.clear");
  await run("playhead.set", { time: 1 });
  const before = ui.menus.length;
  await run("panel.show", { tool: "narration" });
  await page.until("document.querySelector('[data-narration-panel] select')?.value === 'mic-2'");
  expect(await page.evaluate<boolean>("document.querySelector('[data-narration-hear]').checked")).toBe(false);
  // Its level, previewed while idle.
  await arrived(() => ui.menus.slice(before).includes(`recordPreview:${JSON.stringify({ microphone: { id: "mic-2" } })}`));
  await page.until("document.querySelector('[data-narration-panel] [role=meter]')?.dataset.level === '-20'");
  await page.evaluate("document.querySelector('[data-narration-start]').click()");
  await page.until("/Starting in 3/.test(document.querySelector('[data-narration-countdown]')?.textContent ?? '')");
  await page.until("!document.querySelector('[data-narration-countdown]')", 6000);
  const asked = ui.menus.slice(before).find((m) => m.startsWith("startNarration:"))!;
  expect(JSON.parse(asked.slice("startNarration:".length))).toEqual({ microphone: { id: "mic-2" }, hear: false });
  ui.send("narrating", { started: Date.now(), from: 1, until: 5 });
  await page.until("!!document.querySelector('[data-narration-stop-panel]')");
  const at = ui.menus.length;
  await page.evaluate("document.querySelector('[data-narration-stop-panel]').click()");
  await arrived(() => ui.menus.slice(at).includes("stopNarration"));
  ui.send("narrating", null);
  await page.until("!!document.querySelector('[data-narration-start]')");
  await run("panel.show", { tool: null });
}, 30000);

test.skipIf(skip)("The microphone alone is voice narration: it plays the timeline from the playhead or through the range, its sound off by default; Stop and Discard end it", async () => {
  const devices = {
    permissions: { screen: "granted", camera: "granted", microphone: "granted" },
    displays: [{ id: 1, width: 1800, height: 1169 }],
    cameras: [{ id: "cam-1", name: "Elgato 4K X" }],
    microphones: [{ id: "mic-1", name: "Blue Yeti" }, { id: "mic-2", name: "MacBook Pro Microphone" }],
    outputs: [],
  };
  await run("range.clear");
  await run("playhead.set", { time: 2 });
  const before = ui.menus.length;
  // Tools › Voice Narration… opens the dialog on its Narration choice.
  ui.send("recordSheet", { ...devices, mode: "narration", sources: { screen: { fps: 60 }, microphone: { id: "mic-2" }, systemAudio: true } });
  await page.until("!!document.querySelector('[data-narration]')");
  expect(await has("[data-record-monitors]")).toBe(false);
  const on = (label: string) => page.evaluate<boolean>(`document.querySelector('[data-source="${label}"]').checked`);
  expect([await on("Screen"), await on("Camera"), await on("Microphone"), await on("System audio")]).toEqual([false, false, true, false]);
  expect(await page.evaluate<string>("document.querySelector('[data-source=Microphone]').closest('[data-narration] > *').querySelector('select').value")).toBe("mic-2");
  expect(await page.evaluate<boolean>("document.querySelector('[data-hear]').checked")).toBe(false);
  await page.until("/from the playhead \\(0:02\\)/.test(document.querySelector('[data-narration-span]').textContent)");
  // Only the microphone is previewed, for its level.
  const previews = () => ui.menus.slice(before).filter((m) => m.startsWith("recordPreview:")).map((m) => JSON.parse(m.slice("recordPreview:".length)));
  await arrived(() => previews().at(-1)?.microphone?.id === "mic-2");
  expect(previews().at(-1)).toEqual({ microphone: { id: "mic-2" } });
  await run("range.set", { in: 1, out: 3 });
  await page.until("document.querySelector('[data-narration-span]').textContent.includes('the range 0:01–0:03')");
  await page.evaluate("document.querySelector('[data-record-start]').click()");
  await page.until("/plays from 0:01/.test(document.querySelector('[data-countdown]')?.textContent ?? '')");
  await page.until("!document.querySelector('[data-countdown]') && !document.querySelector('[data-record]')", 6000);
  const asked = ui.menus.slice(before).find((m) => m.startsWith("startNarration:"))!;
  expect(JSON.parse(asked.slice("startNarration:".length))).toEqual({ microphone: { id: "mic-2" }, hear: false });
  expect(ui.menus.slice(before).some((m) => m.startsWith("startRecording:"))).toBe(false);

  // From File › Record…, unticking all but the microphone makes it a narration; hearing the timeline warns about speakers.
  ui.send("recordSheet", { ...devices, sources: { screen: { fps: 60 }, microphone: { id: "mic-1" } } });
  await page.until("!!document.querySelector('[data-record-monitors]') && !document.querySelector('[data-narration]')");
  await page.evaluate(`document.querySelector('[data-source="Screen"]').click()`);
  await page.until("!!document.querySelector('[data-narration]') && !document.querySelector('[data-record-monitors]')");
  await page.evaluate("document.querySelector('[data-hear]').click()");
  await page.until("document.querySelector('[data-narration]').textContent.includes('Use headphones')");
  await page.evaluate(`document.querySelector('[data-source="Screen"]').click()`);
  await page.until("!!document.querySelector('[data-record-monitors]') && !document.querySelector('[data-hear]')");
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-record]')");

  // With nothing after the playhead, it records there and nothing plays.
  await run("range.clear");
  await run("playhead.jump", { to: "end" });
  const end = ui.menus.length;
  ui.send("recordSheet", { ...devices, mode: "narration", hear: true, sources: { microphone: { id: "mic-1" } } });
  await page.until("document.querySelector('[data-narration-span]')?.textContent.includes('records at the playhead') ?? false");
  expect(await has("[data-hear]")).toBe(false);
  await page.evaluate("document.querySelector('[data-record-start]').click()");
  await page.until("/Records at /.test(document.querySelector('[data-countdown]')?.textContent ?? '')");
  await page.until("!document.querySelector('[data-countdown]') && !document.querySelector('[data-record]')", 6000);
  const still = ui.menus.slice(end).find((m) => m.startsWith("startNarration:"))!;
  expect(JSON.parse(still.slice("startNarration:".length))).toEqual({ microphone: { id: "mic-1" }, hear: false });

  // While it records, the title bar shows it with Stop and Discard.
  ui.send("narrating", { started: Date.now() - 7000, from: 1, until: 3 });
  await page.until("/Narrating 0:0[78]/.test(document.querySelector('[data-narrating]')?.textContent ?? '')");
  const at = ui.menus.length;
  await page.evaluate("document.querySelector('[data-narration-stop]').click()");
  await page.evaluate("document.querySelector('[data-narration-discard]').click()");
  await arrived(() => ui.menus.slice(at).length >= 2);
  expect(ui.menus.slice(at)).toEqual(["stopNarration", "stopNarration:discard"]);
  ui.send("narrating", null);
  await page.until("!document.querySelector('[data-narrating]')");
  await run("range.clear");
}, 30000);

test.skipIf(skip)("The title bar drags the window, and its name, buttons and menus still click", async () => {
  // Electrobun moves the window on a mousedown in an element with its drag class, unless a no-drag region is nearer.
  const regions = await page.evaluate<{ bar: boolean; plain: string; controls: string[] }>(`(() => {
    const bar = document.querySelector('[data-titlebar]');
    const region = (el) => getComputedStyle(el).getPropertyValue('--electrobun-app-region').trim();
    return { bar: bar.classList.contains('electrobun-webkit-app-region-drag'), plain: region(bar.querySelector('span') ?? bar), controls: [...bar.querySelectorAll('button, select, input')].map(region) };
  })()`);
  expect(regions.bar).toBe(true);
  expect(regions.plain).toBe("");
  expect(regions.controls.length).toBeGreaterThan(1);
  expect(new Set(regions.controls)).toEqual(new Set(["no-drag"]));
});

test.skipIf(skip)("Check Sync: says what to do, shows the camera, beeps through speakers (not headphones), tests the beep, flashes the chosen screen, and saves the delay; the Record dialog shows and checks it", async () => {
  const displays = [{ id: 5, width: 3360, height: 1890 }, { id: 1, width: 1800, height: 1169 }];
  const outputs = [
    { id: "bt", name: "WH-XB900N", kind: "bluetooth", speakers: false, default: true },
    { id: "yeti-out", name: "Yeti Stereo Microphone", kind: "usb", speakers: false, default: false },
    { id: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers", kind: "built-in", speakers: true, default: false },
  ];
  const devices = { displays, display: 5, outputs, cameras: [{ id: "elgato", name: "Elgato Cam Link 4K" }], microphones: [{ id: "yeti", name: "Yeti Stereo Microphone" }], camera: "elgato", microphone: "yeti" };
  const app = { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet" };
  const before = ui.menus.length;
  ui.send("settingsSheet", { ...app, tab: "recording", devices });
  await page.until("!!document.querySelector('[data-recording-settings] [data-camera-sync]')");
  expect(await page.evaluate<string>("document.querySelector('[data-sync-status]').textContent")).toContain("Not checked");
  await page.evaluate("document.querySelector('[data-check-sync]').click()");
  // Setup: what to do, the camera, a test beep the microphone hears, the screen to flash.
  await page.until("!!document.querySelector('[data-sync-setup] [data-preview=Camera]') && document.querySelector('[data-sync-setup]').textContent.includes('volume')");
  // The Mac's sound goes to Bluetooth headphones: the beeps play through its speakers instead, and say so.
  expect(await page.evaluate<string>("document.querySelector('[data-sync-output]').value")).toBe("BuiltInSpeakerDevice");
  expect(await page.evaluate<string>("document.querySelector('[data-sync-setup]').textContent")).toContain("WH-XB900N (Bluetooth headphones): Beacon plays the beeps through MacBook Pro Speakers");
  await page.evaluate("document.querySelector('[data-test-beep]').click()");
  await page.until("document.querySelector('[data-sync-setup]').closest('[tabindex]').textContent.includes('Heard the beep')");
  await page.evaluate("(() => { const s = document.querySelector('[data-sync-display]'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await page.evaluate("document.querySelector('[data-start-sync]').click()");
  await page.until("document.querySelector('[data-sync-result]')?.textContent.includes('112 ms behind')");
  expect(ui.menus.slice(before)).toEqual(expect.arrayContaining(["testBeep>BuiltInSpeakerDevice", "checkSync:elgato|yeti@1>BuiltInSpeakerDevice"]));
  const saved = () => ui.menus.slice(before).filter((m) => m.startsWith("setAppSettings:")).map((m) => JSON.parse(m.slice("setAppSettings:".length)));
  await arrived(() => saved().at(-1)?.cameraSync?.["elgato|yeti"]?.cameraLateMs === 112);
  expect(saved().at(-1).cameraSync["elgato|yeti"]).toMatchObject({ cameraLateMs: 112, checked: { flashes: 6, spreadMs: 4 } });
  await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Done' && b.closest('[tabindex]')?.querySelector('[data-sync-result]')).click()");
  await page.until("!document.querySelector('[data-sync-result]') && document.querySelector('[data-sync-status]').textContent.includes('6 flashes')");
  // Typed: it is saved without a measurement.
  await page.evaluate("[...document.querySelectorAll('[data-camera-sync] span')].find((s) => s.textContent === '112 ms').click()");
  await page.until("document.activeElement?.tagName === 'INPUT'");
  await type("90");
  await page.key("Enter", "Enter");
  await arrived(() => saved().at(-1)?.cameraSync?.["elgato|yeti"]?.cameraLateMs === 90);
  expect(saved().at(-1).cameraSync["elgato|yeti"]).toEqual({ cameraLateMs: 90 });
  await page.evaluate("document.querySelector('[aria-label=Close]').click()");
  await page.until("!document.querySelector('[data-recording-settings]')");
  // The Record dialog shows the pair's delay (not typed there) and opens the same check.
  ui.send("recordSheet", {
    permissions: { screen: "granted", camera: "granted", microphone: "granted" },
    displays,
    cameras: devices.cameras,
    microphones: devices.microphones,
    outputs,
    sources: { camera: { id: "elgato" }, microphone: { id: "yeti" } },
    cameraSync: { "elgato|yeti": { cameraLateMs: 90 } },
  });
  await page.until("!!document.querySelector('[data-record] [data-camera-sync]')");
  expect(await page.evaluate<boolean>("[...document.querySelectorAll('[data-record] [data-camera-sync] span')].some((s) => s.textContent === '90 ms')")).toBe(true);
  await page.evaluate("document.querySelector('[data-record] [data-check-sync]').click()");
  await page.until("!!document.querySelector('[data-sync-setup]')");
  await page.evaluate("document.querySelector('[data-start-sync]').click()");
  await page.until("!!document.querySelector('[data-sync-result]')");
  await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Done' && b.closest('[tabindex]')?.querySelector('[data-sync-result]')).click()");
  await page.until("!document.querySelector('[data-sync-result]') && document.querySelector('[data-record] [data-sync-status]').textContent.includes('6 flashes')");
  await page.evaluate("document.querySelector('[data-record]').closest('[tabindex]').querySelector('[aria-label=Close]').click()");
  await page.until("!document.querySelector('[data-record]')");
}, 20000);

test.skipIf(skip)("after a take, its name is offered to type over; Enter renames its media", async () => {
  const take = Object.values(ui.core.doc(ui.handle).assets).find((a) => a.kind === "recording")!;
  ui.send("recordedSheet", { asset: take.id, name: "2026-10-14 09.53.12", duration: 75 });
  await page.until("document.activeElement?.matches('[data-recorded-name]') && document.activeElement.selectionEnd > 0");
  // macOS would otherwise capitalise a name's first letter.
  expect(await page.evaluate<string[]>("['autocapitalize', 'autocorrect'].map((a) => document.activeElement.getAttribute(a))")).toEqual(["off", "off"]);
  await type("Intro take");
  await page.key("Enter", "Enter");
  await page.until("!document.querySelector('[data-recorded]')");
  await arrived(() => ui.core.doc(ui.handle).assets[take.id]!.name === "Intro take");
  expect(ui.core.doc(ui.handle).assets[take.id]!.name).toBe("Intro take");
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("the recording panel shows a grip, the time, a chip per source (red once it stops, the camera amber while black or frozen), and rolling waveforms of both levels; – hides it, Stop stops", async () => {
  const panel = await openPage(`${ui.url}?panel=screen,camera,microphone,systemAudio`);
  try {
    await panel.until("!!document.querySelector('[data-record-panel]')");
    const before = ui.menus.length;
    for (let i = 0; i < 5; i++) {
      ui.send("recordPreview", { microphone: { db: -18 - i, peak: -6 }, systemAudio: { db: -40, peak: -20 } });
      await Bun.sleep(30);
    }
    await panel.until("[...document.querySelectorAll('canvas[data-history]')].length === 2 && [...document.querySelectorAll('canvas[data-history]')].every((c) => Number(c.dataset.history) >= 4)");
    expect(await panel.evaluate<boolean>("!!document.querySelector('[data-record-panel] img')")).toBe(false);
    const chips = () => panel.evaluate<string>("[...document.querySelectorAll('[data-source-live]')].map((c) => c.textContent + ':' + c.dataset.sourceLive).join(' ')");
    expect(await chips()).toBe("Screen:live Camera:live Mic:live System:live");
    ui.send("recordPreview", { microphone: { db: -20, peak: -6 }, live: { screen: true, camera: false, microphone: true, systemAudio: true } });
    await panel.until("document.querySelector('[data-source=camera]')?.dataset.sourceLive === 'stopped'");
    expect(await chips()).toBe("Screen:live Camera:stopped Mic:live System:live");
    // Frames coming, but black: amber, and back to green when the picture returns.
    ui.send("recordPreview", { live: { screen: true, camera: true, microphone: true, systemAudio: true }, picture: { camera: "black" } });
    await panel.until("document.querySelector('[data-source=camera]')?.dataset.sourceLive === 'black'");
    expect(await panel.evaluate<string>("document.querySelector('[data-source=camera] span').className")).toContain("bg-warning");
    ui.send("recordPreview", { live: { screen: true, camera: true, microphone: true, systemAudio: true }, picture: { camera: null } });
    await panel.until("document.querySelector('[data-source=camera]')?.dataset.sourceLive === 'live'");
    expect(await panel.evaluate<string>("document.querySelector('[data-record-time]').textContent")).toMatch(/^0:0\d$/);
    expect(await panel.evaluate<boolean>("!!document.querySelector('[data-record-grip]')")).toBe(true);
    await panel.evaluate("document.querySelector('[data-record-hide]').click()");
    await arrived(() => ui.menus.slice(before).includes("hidePanel"));
    await panel.evaluate("document.querySelector('[data-record-stop]').click()");
    await arrived(() => ui.menus.slice(before).includes("stopRecording"));
    expect(ui.menus.slice(before)).toEqual(expect.arrayContaining(["hidePanel", "stopRecording"]));
  } finally {
    panel.close();
  }
});

test.skipIf(skip)("hovering a video in the Media Bin scrubs it: the frame and time under the pointer, back to its thumbnail on leaving", async () => {
  await run("panel.show", { tool: "media" });
  const take = Object.values(ui.core.doc(ui.handle).assets).find((a) => a.kind === "recording")!;
  const tile = `[data-asset="${take.id}"] [data-scrub], [data-asset="${take.id}"] > div:first-child`;
  await page.until(`!!document.querySelector('${tile}')`);
  const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('${tile}').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const time = () => page.evaluate<string>(`document.querySelector('[data-asset="${take.id}"] [data-scrub-time]').textContent`);
  const whole = await time();
  await page.hover(box.x + box.w * 0.75, box.y + box.h / 2);
  await page.until(`!!document.querySelector('[data-asset="${take.id}"] [data-scrub-frame]')`, 15000);
  const late = await time();
  await page.hover(box.x + box.w * 0.1, box.y + box.h / 2);
  await page.until(`document.querySelector('[data-asset="${take.id}"] [data-scrub-time]').textContent !== ${JSON.stringify(late)}`);
  expect(late).not.toBe(whole);
  await page.hover(box.x + box.w / 2, box.y - 40);
  await page.until(`!document.querySelector('[data-asset="${take.id}"] [data-scrub-frame]')`);
  expect(await time()).toBe(whole);
}, 30000);

test.skipIf(skip)("every tile in the effect and annotation panels shows its picture", async () => {
  for (const tool of ["visualEffects", "annotations", "audioEffects"]) {
    await run("panel.show", { tool });
    await page.until("document.querySelectorAll('[data-art]').length > 0");
    const missing = await page.evaluate<string[]>(
      "[...document.querySelectorAll('.panel-card .grid > button')].filter((b) => { const a = b.querySelector('[data-art]'); return !a || getComputedStyle(a).backgroundImage === 'none'; }).map((b) => b.textContent)",
    );
    expect({ tool, missing }).toEqual({ tool, missing: [] });
  }
});

test.skipIf(skip)("a click selects a panel's tile and its star adds it to Favorites; a double-click applies it to the selection; Favorites reorder by dropping one tile on another", async () => {
  const tile = (item: string) => `[data-item="${item}"]`;
  const star = (item: string) => page.evaluate<string | null>(`document.querySelector('${tile(item)} [data-star]')?.dataset.star ?? null`);
  const outlined = (item: string) => page.evaluate<boolean>(`document.querySelector('${tile(item)}').className.includes('ring-tile-selected')`);
  await run("panel.show", { tool: "annotations" });
  await page.until(`!!document.querySelector('${tile("annotation:blur")}')`);
  expect(await page.evaluate<string>("document.body.innerText")).toContain("Drag onto media, or double-click to apply to the selection");
  // A favourite shows its gold star; another tile shows none until selected.
  expect(await star("annotation:text")).toBe("on");
  expect(await star("annotation:blur")).toBe(null);
  const before = clips().length;
  await page.click(...(await centre(tile("annotation:blur"))));
  await page.until(`!!document.querySelector('${tile("annotation:blur")} [data-star="off"]')`);
  expect(await outlined("annotation:blur")).toBe(true);
  expect(clips().length).toBe(before);
  await page.click(...(await centre(`${tile("annotation:blur")} [data-star]`)));
  await page.until(`!!document.querySelector('${tile("annotation:blur")} [data-star="on"]')`);
  expect((await ui.core.favorites()).at(-1)).toBe("annotation:blur");
  await page.screenshot(join(dir, "favorite-starred.png"));
  await page.click(...(await centre(`${tile("annotation:blur")} [data-star]`)));
  await page.until(`!!document.querySelector('${tile("annotation:blur")} [data-star="off"]')`);
  expect(await ui.core.favorites()).not.toContain("annotation:blur");

  // A double-click applies it to the selected clip, one undo step.
  await select([screen.id]);
  await run("panel.show", { tool: "visualEffects" });
  await page.until(`!!document.querySelector('${tile("effect:drop-shadow")}')`);
  await page.dblclick(...(await centre(tile("effect:drop-shadow"))));
  await arrived(() => clip(screen.id).effects.some((e) => e.type === "drop-shadow"));
  expect(clip(screen.id).effects.filter((e) => e.type === "drop-shadow").length).toBe(1);
  await ui.core.undo(ui.handle);
  expect(clip(screen.id).effects.some((e) => e.type === "drop-shadow")).toBe(false);

  // The Favorites panel in the list's order; a change from elsewhere (an agent) shows.
  await run("panel.show", { tool: "favorites" });
  const shown = () => page.evaluate<string[]>("[...document.querySelectorAll('[data-favorites] [data-item]')].map((e) => e.dataset.item)");
  await page.until("document.querySelectorAll('[data-favorites] [data-item]').length > 2");
  expect(await shown()).toEqual(await ui.core.favorites());
  await ui.core.favoriteAdd("audio:fade-in", 0);
  await page.until(`document.querySelector('[data-favorites] [data-item]').dataset.item === "audio:fade-in"`);
  // Dropped on the third tile, the first takes its place.
  const [first, , third] = await shown();
  await page.drag(await centre(tile(first!)), await centre(tile(third!)));
  await page.until(`document.querySelectorAll('[data-favorites] [data-item]')[2].dataset.item === ${JSON.stringify(first)}`);
  expect((await ui.core.favorites())[2]).toBe(first!);
  expect(clips().length).toBe(before);
  await page.screenshot(join(dir, "favorites-panel.png"));
  // Un-starred in the panel, it leaves it.
  await page.click(...(await centre(`${tile("audio:fade-in")} [data-star]`)));
  await page.until(`!document.querySelector('[data-favorites] ${tile("audio:fade-in")}')`);
  expect(await ui.core.favorites()).not.toContain("audio:fade-in");
  await select([]);
});

test.skipIf(skip)("Settings › Shortcuts lists every action, searchable; pressing keys rebinds one, a key taken asks first and moves it; the keys work at once; Reset All puts them back", async () => {
  const keysOf = async (id: string) => (await ui.core.shortcuts()).find((s) => s.id === id)!.keys;
  const row = (id: string) => `[data-shortcut="${id}"]`;
  const rowKeys = (id: string) => page.evaluate<string>(`document.querySelector('${row(id)} [data-shortcut-keys]')?.textContent ?? ''`);
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet", tab: "shortcuts" });
  await page.until("!!document.querySelector('[data-shortcuts]')");
  expect(await page.evaluate<number>("document.querySelectorAll('[data-shortcut]').length")).toBe((await ui.core.shortcuts()).length);
  await page.click(...(await centre("[data-shortcuts-search]")));
  await type("split");
  await page.until(`!!document.querySelector('${row("edit.split")}') && !document.querySelector('${row("edit.duplicate")}')`);
  expect(await rowKeys("edit.split")).toBe("⌘T");
  // A key Duplicate has: asked first; Cancel changes nothing.
  await page.click(...(await centre(`${row("edit.split")} [data-shortcut-keys]`)));
  await page.until("document.activeElement?.hasAttribute('data-recording')");
  await page.key("d", "KeyD", ["meta"]);
  await page.until("!!document.querySelector('[data-shortcut-clash]')");
  expect(await page.evaluate<string>("document.querySelector('[data-shortcut-clash]').textContent")).toContain("⌘D is Duplicate's shortcut");
  await page.screenshot(join(dir, "shortcuts-clash.png"));
  await page.click(...(await centre("[data-clash-replace]")));
  await page.until(`document.querySelector('${row("edit.split")} [data-shortcut-keys]').textContent === "⌘D"`);
  expect(await keysOf("edit.split")).toEqual([{ key: "d", modifiers: ["command"] }]);
  expect(await keysOf("edit.duplicate")).toEqual([]);
  expect(await page.evaluate<boolean>(`!!document.querySelector('${row("edit.split")} [data-shortcut-reset]')`)).toBe(true);
  // Escape while recording stops without changing anything.
  await page.click(...(await centre(`${row("edit.split")} [data-shortcut-keys]`)));
  await page.until("document.activeElement?.hasAttribute('data-recording')");
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-recording]') && !!document.activeElement?.hasAttribute('data-shortcut-keys')");
  expect(await keysOf("edit.split")).toEqual([{ key: "d", modifiers: ["command"] }]);
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-shortcuts]')");

  // The window's keys follow: ⌘D splits, ⌘T no longer does.
  await select([screen.id]);
  await run("playhead.set", { time: 3 });
  await Bun.sleep(200);
  const count = clips().length;
  await page.key("t", "KeyT", ["meta"]);
  await Bun.sleep(300);
  expect(clips().length).toBe(count);
  await page.key("d", "KeyD", ["meta"]);
  await arrived(() => clips().length > count);
  expect(clips().length).toBeGreaterThan(count);
  await ui.core.undo(ui.handle);
  expect(await page.evaluate<string>("[...document.querySelectorAll('button')].find((b) => b.title.startsWith('Split'))?.title ?? ''")).toBe("Split (⌘D)");

  // An agent's change shows in the open list; Reset All puts every key back.
  ui.send("settingsSheet", { exportColorSpace: "bt709", autoProxy: { recording: true, video: true }, proxyMode: "quiet", tab: "shortcuts" });
  await page.until("!!document.querySelector('[data-shortcuts]')");
  await ui.core.shortcutSet("edit.addMarker", [{ key: "m", modifiers: ["option"] }]);
  await page.until(`document.querySelector('${row("edit.addMarker")} [data-shortcut-keys]')?.textContent === "⌥M"`);
  await page.screenshot(join(dir, "shortcuts.png"));
  await page.click(...(await centre("[data-shortcuts-reset-all]")));
  await page.until(`document.querySelector('${row("edit.split")} [data-shortcut-keys]').textContent === "⌘T"`);
  expect((await ui.core.shortcuts()).filter((s) => !s.standard)).toEqual([]);
  await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Done').click()");
  await page.until("!document.querySelector('[data-shortcuts]')");
  await select([]);
}, 30000);

test.skipIf(skip)("the command palette opens on ⌘K and adds what the panels do by name or description: annotations at the playhead, effects on the selected clips, AI tools' reviews; favourites first; its key can be changed", async () => {
  const open = () => page.until("!!document.querySelector('[data-palette]')");
  const shown = () => page.evaluate<string[]>("[...document.querySelectorAll('[data-entry]')].map((e) => e.dataset.entry)");
  const clear = () => page.evaluate("(() => { const i = document.querySelector('[data-palette-search]'); i.select(); document.execCommand('delete'); })()");
  await page.key("k", "KeyK", ["meta"]);
  await open();
  // Favourites first, in their order; then every annotation, effect and AI tool, and nothing else.
  const favorites = await ui.core.favorites();
  const all = await shown();
  expect(all.slice(0, favorites.length)).toEqual(favorites);
  expect(all).toContain("annotation:blur");
  expect(all).toContain("audio:fade-out");
  expect(all.slice(-3)).toEqual(["ai:silences", "ai:fillers", "ai:captions"]);
  expect(all.some((e) => e.startsWith("app.") || e.includes("playhead"))).toBe(false);
  await page.screenshot(join(dir, "palette.png"));

  // An annotation goes in at the playhead.
  await type("rectangle");
  await page.until("document.querySelector('[data-entry]')?.dataset.entry === 'annotation:rectangle'");
  await run("playhead.set", { time: 2 });
  const before = clips().length;
  await page.key("Enter", "Enter");
  await page.until("!document.querySelector('[data-palette]')");
  await arrived(() => clips().length > before);
  const added = clips().find((c) => c.type === "callout" && !c.props.caption && ticksToSeconds(c.start) === 2);
  expect(added).toBeDefined();
  await ui.core.undo(ui.handle);

  // An effect found by what it does goes on the selected clip; arrows choose.
  await select([screen.id]);
  await page.key("k", "KeyK", ["meta"]);
  await open();
  await type("shadow");
  await page.until("document.querySelector('[data-entry]')?.dataset.entry === 'effect:drop-shadow'");
  await page.key("Enter", "Enter");
  await arrived(() => clip(screen.id).effects.some((e) => e.type === "drop-shadow"));
  expect(clip(screen.id).effects.some((e) => e.type === "drop-shadow")).toBe(true);
  await ui.core.undo(ui.handle);
  await page.key("k", "KeyK", ["meta"]);
  await open();
  await type("um");
  await page.until("[...document.querySelectorAll('[data-entry]')].some((e) => e.dataset.entry === 'ai:fillers')");
  await clear();
  await type("pauses");
  await page.until("document.querySelector('[data-entry]')?.dataset.entry === 'ai:silences'");
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-palette]')");
  await select([]);

  // Tab and ⇧Tab move through the list; focus stays in the palette, so the editor's Tab (select the next clip) doesn't act behind it.
  await page.key("k", "KeyK", ["meta"]);
  await open();
  const chosen = () => page.evaluate<string>("document.querySelector('[aria-selected=true]').dataset.entry");
  const first = await chosen();
  for (let i = 0; i < 3; i++) await page.key("Tab", "Tab");
  await page.key("Tab", "Tab", ["shift"]);
  expect(await chosen()).toBe((await shown())[2]!);
  expect(first).not.toBe(await chosen());
  expect(await page.evaluate<boolean>("!!document.activeElement?.hasAttribute('data-palette-search')")).toBe(true);
  expect((await session()).selection).toEqual([]);
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-palette]')");

  // Rebound, the new key opens it and ⌘K no longer does.
  await ui.core.shortcutSet("app.palette", [{ key: "p", modifiers: ["shift", "command"] }]);
  await Bun.sleep(300);
  await page.key("k", "KeyK", ["meta"]);
  await Bun.sleep(300);
  expect(await has("[data-palette]")).toBe(false);
  await page.key("P", "KeyP", ["meta", "shift"]);
  await open();
  await page.key("Escape", "Escape");
  await page.until("!document.querySelector('[data-palette]')");
  await ui.core.shortcutReset();
}, 30000);

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

test.skipIf(skip)("the ruler moves the playhead past the last clip, and an edit leaves it there", async () => {
  await select([]);
  await run("timeline.zoom", { to: "fit" });
  await Bun.sleep(200);
  const s = await session();
  const end = Math.max(...clips().map((c) => ticksToSeconds(c.start + c.duration)));
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const header = headerWidth(ui.core.doc(ui.handle).tracks);
  const xAt = (t: number) => box.x + header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const past = end + (s.timeline.end - end) * 0.6;
  await page.click(xAt(past), box.y + 12);
  await Bun.sleep(300);
  expect((await session()).playhead).toBeCloseTo(past, 1);
  await run("marker.add", { time: 1, name: "" });
  await Bun.sleep(200);
  expect((await session()).playhead).toBeCloseTo(past, 1);
  await ui.core.undo(ui.handle);
  // Held at the right edge, the playhead keeps going and the view follows it.
  const y = box.y + 12;
  await page.down(xAt(past), y);
  await page.move(box.x + box.w - 6, y);
  await Bun.sleep(1000);
  const followed = await session();
  expect(followed.playhead).toBeGreaterThan(s.timeline.end + 1);
  expect(followed.timeline.end).toBeCloseTo(followed.playhead, 0);
  // Back out of the edge, still held: the view stops.
  await page.move(box.x + box.w / 2, y);
  await Bun.sleep(300);
  const settled = (await session()).timeline.start;
  await Bun.sleep(500);
  expect((await session()).timeline.start).toBe(settled);
  await page.up(box.x + box.w / 2, y);
  await run("timeline.zoom", { to: "fit" });
  await run("playhead.set", { time: 1 });
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

test.skipIf(skip)("⌘S confirms the project is saved automatically for a moment, with no dialog; otherwise the title bar says nothing", async () => {
  expect(await has("[data-saved]")).toBe(false);
  await page.key("s", "KeyS", ["meta"]);
  await page.until(`(document.querySelector('[data-saved]')?.textContent ?? '').startsWith('✓')`, 1000);
  expect(await has("[role=dialog]")).toBe(false);
  await page.until(`!document.querySelector('[data-saved]')`, 3000);
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

test.skipIf(skip)("a colour label (Add Color Label) draws a stripe along the top of the selected clips, keeping their kind's colour; Default removes it; one undo step", async () => {
  await select([screen.id]);
  await run("timeline.view", { start: 0, end: 20 });
  await Bun.sleep(200);
  const doc = () => ui.core.doc(ui.handle);
  const s = await session();
  const row = doc().tracks.length - 1 - doc().tracks.findIndex((t) => t.clips.some((k) => k.id === screen.id));
  const box = clipBox(row, s.timeline.trackHeight);
  const x = headerWidth(doc().tracks) + 200;
  const pixel = (dy: number) =>
    page.evaluate<number[]>(`(() => { const c = document.querySelector('canvas[data-timeline]'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(${x} * k), Math.round(${box.y + dy} * k), 1, 1).data].slice(0, 3); })()`);
  const body = await pixel(box.h - 4);
  await run("edit.label", { color: "red" });
  expect((clip(screen.id).props.label as { color: string }).color).toBe("red");
  await page.until(`(() => { const c = document.querySelector('canvas[data-timeline]'); const k = c.width / c.getBoundingClientRect().width; const [r, g, b] = c.getContext('2d').getImageData(Math.round(${x} * k), Math.round(${box.y + 3} * k), 1, 1).data; return r > 200 && g < 120 && b < 120; })()`);
  // Below the stripe, the clip is still its kind's colour.
  expect(await pixel(box.h - 4)).toEqual(body);
  await page.screenshot(join(dir, "label.png"));
  await run("edit.label", { color: null });
  expect((clip(screen.id).props.label as { color: string | null }).color).toBe(null);
  await ui.core.undo(ui.handle);
  await ui.core.undo(ui.handle);
  expect(clip(screen.id).props.label).toBeUndefined();
  await select([]);
  expect(run("edit.label", { color: "blue" })).rejects.toThrow("select clips first");
});

test.skipIf(skip)("a clip dropped after a drag stays where it was dropped while the move is applied, never back where it was for a frame", async () => {
  await select([]);
  await run("timeline.view", { start: 0, end: 20 });
  await Bun.sleep(200);
  const doc = () => ui.core.doc(ui.handle);
  const c = clip(callout.id);
  const s = await session();
  const row = doc().tracks.length - 1 - doc().tracks.findIndex((t) => t.clips.some((k) => k.id === callout.id));
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const header = headerWidth(doc().tracks);
  const xAt = (t: number) => header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const { y, h } = clipBox(row, s.timeline.trackHeight);
  const start = ticksToSeconds(c.start);
  const end = ticksToSeconds(c.start + c.duration);
  // A point of the clip's body clear of its name and badges, and where it is dragged to (past its end).
  const [ox, oy] = [xAt(end - 0.6), y + h - 6];
  const by = end - start + 2;
  // Every frame from the release on: whether that point is the clip's colour (it fades while dragged).
  const sample = `(() => { const c = document.querySelector('canvas[data-timeline]'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(${ox} * k), Math.round(${oy} * k), 1, 1).data].slice(0, 3).join(); })()`;
  const body = await page.evaluate<string>(sample);
  ui.faults.runDelay = 60;
  try {
    await page.down(box.x + ox, box.y + oy);
    for (let i = 1; i <= 10; i++) {
      await page.move(box.x + xAt(end - 0.6 + (by * i) / 10), box.y + oy);
      await Bun.sleep(16);
    }
    await page.evaluate(`window.__frames = []; (function tick() { window.__frames.push(${sample}); if (window.__frames.length < 40) requestAnimationFrame(tick); })()`);
    await page.up(box.x + xAt(end - 0.6 + by), box.y + oy);
    await arrived(() => ticksToSeconds(clip(callout.id).start) > start + 1);
    await page.until("window.__frames.length >= 40");
  } finally {
    ui.faults.runDelay = 0;
  }
  const frames = await page.evaluate<string[]>("window.__frames");
  expect(ticksToSeconds(clip(callout.id).start)).toBeCloseTo(start + by, 1);
  // Before: faded while dragged. After the release it must never be drawn there in full again.
  expect(frames.filter((f) => f === body).length).toBe(0);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("trimming a clip's end, its fx badge rides the edge being dragged, not where the end was", async () => {
  await select([]);
  await run("effect.add", { clip: screen.id, type: "drop-shadow" });
  const doc = ui.core.doc(ui.handle);
  const c = doc.tracks.flatMap((t) => t.clips).find((k) => k.id === screen.id)!;
  const end = ticksToSeconds(c.start + c.duration);
  await run("timeline.view", { start: Math.max(0, end - 8), end: end + 2 });
  // Past the badge's flash for a new effect.
  await Bun.sleep(1800);
  const s = await session();
  const header = headerWidth(doc.tracks);
  const box = await page.evaluate<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  const row = doc.tracks.length - 1 - doc.tracks.findIndex((t) => t.clips.some((k) => k.id === screen.id));
  const xAt = (t: number) => header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  const top = clipBox(row, s.timeline.trackHeight).y;
  // The badge's left part, clear of its "fx": 6 px in from the edge, 20 wide, 14 high, 4 down.
  const yellow = async (right: number) => {
    const [r, g, b] = await page.evaluate<number[]>(`(() => { const c = document.querySelector('canvas[data-timeline]'); const k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(${right - 6 - 17} * k), Math.round(${top + 4 + 3} * k), 1, 1).data]; })()`);
    return r! > 200 && g! > 160 && b! < 120;
  };
  expect(await yellow(xAt(end))).toBe(true);
  const y = box.y + top + s.timeline.trackHeight / 2;
  const to = end - 3;
  await page.down(box.x + xAt(end) - 2, y);
  await page.move(box.x + xAt(end - 1.5), y);
  await page.move(box.x + xAt(to) - 2, y);
  await Bun.sleep(200);
  expect([await yellow(xAt(to)), await yellow(xAt(end))]).toEqual([true, false]);
  await page.key("Escape", "Escape");
  await page.up(box.x + xAt(to) - 2, y);
  await Bun.sleep(200);
  expect(ticksToSeconds(ui.core.doc(ui.handle).tracks.flatMap((t) => t.clips).find((k) => k.id === screen.id)!.duration)).toBeCloseTo(ticksToSeconds(c.duration), 3);
  await ui.core.undo(ui.handle);
  await run("timeline.zoom", { to: "fit" });
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

test.skipIf(skip)("Drop Shadow's angle shows in degrees and its opacity as a percentage", async () => {
  await run("effect.add", { clip: screen.id, type: "drop-shadow" });
  await select([screen.id]);
  await run("inspector.tab", { tab: "effects" });
  const spans = "[...document.querySelectorAll('span')].map((s) => s.textContent)";
  await page.until(`${spans}.includes('315.0°') && ${spans}.includes('40%')`);
  await page.evaluate(`[...document.querySelectorAll('span')].find((s) => s.textContent === '315.0°').click()`);
  await page.until("document.activeElement?.tagName === 'INPUT'");
  await type("90");
  await page.key("Enter", "Enter");
  await Bun.sleep(300);
  const fx = clip(screen.id).effects.find((e) => e.type === "drop-shadow")!;
  expect(fx.params.angle as number).toBeCloseTo(Math.PI / 2, 5);
  await ui.core.undo(ui.handle);
  await ui.core.undo(ui.handle);
});

test.skipIf(skip)("Remove Silences reviews on the timeline: marks to cut and keep, a click flips one, Apply cuts what it said in one undo step; Cancel cuts nothing", async () => {
  await select([]);
  await run("timeline.zoom", { to: "fit" });
  await run("panel.show", { tool: "ai" });
  await page.until("!!document.querySelector('[data-ai=silences]')");
  await page.evaluate("document.querySelector('[data-ai=silences]').click()");
  await page.until("!!document.querySelector('[data-silence-review]')");
  // The recording's transcript may still be being made in the background.
  await page.until("/shorter\\.$/.test(document.querySelector('[data-silences-summary]')?.textContent ?? '')", 120_000);
  type Found = { silences: { start: number; end: number; cut: boolean }[]; saved: number };
  const review = async () => (await session()).features.transcript as { silences?: { min: number; keep: number; keepActive: boolean; flipped: number[] } } | undefined;
  const found = async () => (await ui.core.query(ui.handle, "transcript.silences", (await review())!.silences)) as Found;
  // Its settings are sliders: clicked along, the review follows.
  const track = (i: number) => page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelectorAll('[data-silence-review] .bg-groove')[${i}].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cutOver = await track(0);
  await page.click(cutOver.x + cutOver.w * (1 / 4.8), cutOver.y + cutOver.h / 2);
  for (let i = 0; i < 50 && (await review())?.silences?.min !== 1.2; i++) await Bun.sleep(50);
  const leave = await track(1);
  await page.click(leave.x + leave.w / 2, leave.y + leave.h / 2);
  for (let i = 0; i < 50 && (await review())?.silences?.keep !== 1; i++) await Bun.sleep(50);
  expect([(await review())?.silences?.min, (await review())?.silences?.keep]).toEqual([1.2, 1]);
  await run("silences.review", { min: 0.6, keep: 0.3 });
  await page.until("/shorter\\.$/.test(document.querySelector('[data-silences-summary]')?.textContent ?? '')");
  // An edit while the review is open: the marks and summary describe the timeline as it is now, not as it was.
  const counts = async () => {
    const f = await found();
    const cut = f.silences.filter((x) => x.cut).length;
    return `${f.silences.length} silences: ${cut} to cut, ${f.silences.length - cut} kept.`;
  };
  const shows = (text: string) => page.until(`(document.querySelector('[data-silences-summary]')?.textContent ?? '').startsWith(${JSON.stringify(text)})`);
  const reviewed = await counts();
  await shows(reviewed);
  await run("timeline.rippleDelete", { ranges: [{ start: 0, end: 30 }] });
  const edited = await counts();
  expect(edited).not.toBe(reviewed);
  await shows(edited);
  await ui.core.undo(ui.handle);
  await shows(reviewed);
  const first = await found();
  // The widest silence to cut, clicked in the middle of its band on the timeline: kept now.
  const target = first.silences.filter((x) => x.cut).sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
  const s = await session();
  const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const header = headerWidth(ui.core.doc(ui.handle).tracks);
  const xAt = (t: number) => box.x + header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
  await page.click(xAt((target.start + target.end) / 2), box.y + box.h - 20);
  for (let i = 0; i < 50 && !(await review())?.silences?.flipped.length; i++) await Bun.sleep(50);
  const flipped = await found();
  expect(flipped.silences.find((x) => x.start === target.start)!.cut).toBe(false);
  expect(flipped.saved).toBeLessThan(first.saved);
  const length = () => ticksToSeconds(projectDuration(ui.core.doc(ui.handle)));
  const before = length();
  const undo = (await ui.core.history(ui.handle)).undo.length;
  await page.evaluate("document.querySelector('[data-silences-apply]').click()");
  await page.until("!document.querySelector('[data-silence-review]')");
  await arrived(() => length() < before);
  expect(before - length()).toBeCloseTo(flipped.saved, 2);
  expect((await ui.core.history(ui.handle)).undo.length - undo).toBe(1);
  expect((await review())?.silences).toBeUndefined();
  await ui.core.undo(ui.handle);
  expect(length()).toBeCloseTo(before, 3);
  // Opened again and cancelled: nothing cut.
  await page.evaluate("document.querySelector('[data-ai=silences]').click()");
  await page.until("!!document.querySelector('[data-silences-cancel]')");
  await page.evaluate("document.querySelector('[data-silences-cancel]').click()");
  await page.until("!document.querySelector('[data-silence-review]')");
  expect(length()).toBeCloseTo(before, 3);
  await run("panel.show", { tool: null });
}, 150_000);

test.skipIf(skip)("Remove Filler Words reviews on the timeline: each filler marked, a click keeps one, Apply cuts the rest in one undo step; one at a time, Cut This One cuts only one; Cancel cuts nothing; one review at a time", async () => {
  // The fixtures' transcripts have no fillers: a copy of the talk with its real transcript, a few words made fillers,
  // in a cache of its own.
  type Transcript = { streams: Record<number, { words: { text: string }[] }> };
  const talk = await ui.core.import(ui.handle, [join(FIXTURES, "audio.m4a")]);
  let transcript: Transcript | undefined;
  for (const end = Date.now() + 120_000; !(transcript = ui.core.derived<Transcript>(ui.handle, talk.assets[0]!, "transcript")) && Date.now() < end; ) await Bun.sleep(250);
  await ui.core.undo(ui.handle);
  const cacheDir = join(dir, "fillers-cache");
  const core = new LocalCore({ cacheDir });
  const path = join(dir, "fillers.beproj");
  const h = await core.create({ path });
  const copy = join(dir, `talk-${Date.now()}.m4a`);
  copyFileSync(join(FIXTURES, "audio.m4a"), copy);
  const { assets } = await core.import(h, [copy]);
  const asset = core.doc(h).assets[assets[0]!]!;
  await core.close(h);
  const edited = structuredClone(transcript!);
  for (const [i, text] of [[30, "Um,"], [90, "uh,"], [91, "uh"], [150, "Hmm."]] as const) edited.streams[0]!.words[i]!.text = text;
  mkdirSync(join(cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify(edited));
  const other = await serveUi(path, { cacheDir });
  const p = await openPage(other.url);
  try {
    const go = (command: string, args: unknown = {}) => other.core.run(other.handle, command, args);
    const review = async () => ((await other.core.session(other.handle)).features.transcript as { fillers?: { flipped: number[] }; silences?: object } | undefined);
    type Found = { fillers: { start: number; end: number; text: string; cut: boolean }[]; saved: number };
    const found = async () => (await other.core.query(other.handle, "transcript.fillers", (await review())?.fillers ?? {})) as Found;
    await go("panel.show", { tool: "ai" });
    await p.until("!!document.querySelector('[data-ai=fillers]')");
    await p.evaluate("document.querySelector('[data-ai=fillers]').click()");
    await p.until("!!document.querySelector('[data-filler-review]')");
    await p.until("/shorter\\.$/.test(document.querySelector('[data-fillers-summary]')?.textContent ?? '')", 30_000);
    const first = await found();
    expect(first.fillers.map((f) => f.text)).toEqual(["Um,", "uh, uh", "Hmm."]);
    expect(await p.evaluate<string>("document.querySelector('[data-fillers-summary]').textContent")).toStartWith("3 filler words: 3 to cut, 0 kept.");
    // The second filler, shown wide and clicked in the middle of its mark: kept now.
    const target = first.fillers[1]!;
    await go("timeline.view", { start: target.start - 2, end: target.end + 2 });
    const s = await other.core.session(other.handle);
    const box = await p.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('canvas[data-timeline]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const header = headerWidth(other.core.doc(other.handle).tracks);
    const xAt = (t: number) => box.x + header + ((t - s.timeline.start) / (s.timeline.end - s.timeline.start)) * (box.w - header);
    await p.click(xAt((target.start + target.end) / 2), box.y + box.h - 20);
    for (let i = 0; i < 50 && !(await review())?.fillers?.flipped.length; i++) await Bun.sleep(50);
    const flipped = await found();
    expect(flipped.fillers.map((f) => f.cut)).toEqual([true, false, true]);
    await p.until("(document.querySelector('[data-fillers-summary]')?.textContent ?? '').startsWith('3 filler words: 2 to cut, 1 kept.')");
    const length = () => ticksToSeconds(projectDuration(other.core.doc(other.handle)));
    const before = length();
    const undo = (await other.core.history(other.handle)).undo.length;
    await p.evaluate("document.querySelector('[data-fillers-apply]').click()");
    await p.until("!document.querySelector('[data-filler-review]')");
    await arrived(() => length() < before);
    expect(before - length()).toBeCloseTo(flipped.saved, 2);
    expect((await other.core.history(other.handle)).undo.length - undo).toBe(1);
    expect((await review())?.fillers).toBeUndefined();
    // What was cut is gone from the transcript; the kept one is still there.
    const left = ((await other.core.query(other.handle, "transcript.get", { format: "words" })) as { text: string }[]).map((w) => w.text);
    expect([left.includes("Um,"), left.includes("Hmm."), left.filter((t) => t.startsWith("uh")).length]).toEqual([false, false, 2]);
    await other.core.undo(other.handle);
    expect(length()).toBeCloseTo(before, 3);
    // One at a time: › goes to the first, ⌥-click on the last's mark goes to it, ‹ steps back; Cut This One cuts only
    // that one, one undo step, and the review stays open on the next.
    await p.evaluate("document.querySelector('[data-ai=fillers]').click()");
    await p.until("!!document.querySelector('[data-one-next]')");
    const at = () => p.evaluate<string>("document.querySelector('[data-one-at]')?.textContent ?? ''");
    await p.evaluate("document.querySelector('[data-one-next]').click()");
    await p.until("(document.querySelector('[data-one-at]')?.textContent ?? '').endsWith('1 of 3')");
    expect(await p.evaluate<string>("document.querySelector('[data-one-item]').textContent")).toContain("“Um,”");
    expect((await other.core.session(other.handle)).playhead).toBeCloseTo(Math.max(0, first.fillers[0]!.start - 1), 1);
    const last = first.fillers[2]!;
    await go("timeline.view", { start: last.start - 2, end: last.end + 2 });
    const s2 = await other.core.session(other.handle);
    const xAt2 = (t: number) => box.x + header + ((t - s2.timeline.start) / (s2.timeline.end - s2.timeline.start)) * (box.w - header);
    await p.click(xAt2((last.start + last.end) / 2), box.y + box.h - 20, ["alt"]);
    await p.until("(document.querySelector('[data-one-at]')?.textContent ?? '').endsWith('3 of 3')");
    expect((await review())?.fillers?.flipped).toEqual([]);
    await p.evaluate("document.querySelector('[data-one-prev]').click()");
    await p.until("(document.querySelector('[data-one-at]')?.textContent ?? '').endsWith('2 of 3')");
    const second = first.fillers[1]!;
    const steps = (await other.core.history(other.handle)).undo.length;
    await p.evaluate("document.querySelector('[data-one-cut]').click()");
    await arrived(() => length() < before);
    expect(before - length()).toBeCloseTo(second.end - second.start, 1);
    expect((await other.core.history(other.handle)).undo.length - steps).toBe(1);
    await p.until("(document.querySelector('[data-one-at]')?.textContent ?? '').endsWith('2 of 2')");
    expect(await at()).toEndWith("2 of 2");
    expect(await p.evaluate<string>("document.querySelector('[data-one-item]').textContent")).toContain("“Hmm.”");
    expect(await p.evaluate<boolean>("!!document.querySelector('[data-filler-review]')")).toBe(true);
    await other.core.undo(other.handle);
    expect(length()).toBeCloseTo(before, 3);
    await p.evaluate("document.querySelector('[data-fillers-cancel]').click()");
    await p.until("!document.querySelector('[data-filler-review]')");
    // Opened again: Remove Silences replaces it in the properties panel, and Cancel cuts nothing.
    await p.evaluate("document.querySelector('[data-ai=fillers]').click()");
    await p.until("!!document.querySelector('[data-fillers-cancel]')");
    await p.evaluate("document.querySelector('[data-ai=silences]').click()");
    await p.until("!!document.querySelector('[data-silence-review]') && !document.querySelector('[data-filler-review]')");
    expect((await review())?.fillers).toBeUndefined();
    await p.evaluate("document.querySelector('[data-ai=fillers]').click()");
    await p.until("!!document.querySelector('[data-fillers-cancel]') && !document.querySelector('[data-silence-review]')");
    await p.evaluate("document.querySelector('[data-fillers-cancel]').click()");
    await p.until("!document.querySelector('[data-filler-review]')");
    expect(length()).toBeCloseTo(before, 3);
  } finally {
    p.close();
    await other.close();
  }
}, 180_000);

test.skipIf(skip)("Captions makes caption clips from the transcript and shows the first; its text is edited in place and a style change restyles every caption, each one undo step", async () => {
  await select([]);
  await run("panel.show", { tool: "ai" });
  for (const end = Date.now() + 120_000; !((await ui.core.query(ui.handle, "transcript.get", { format: "words" })) as unknown[]).length && Date.now() < end; ) await Bun.sleep(500);
  await page.until("!!document.querySelector('[data-ai=captions]')");
  const captions = () => clips().filter((c) => c.type === "caption");
  const undo = async () => (await ui.core.history(ui.handle)).undo.length;
  const steps = await undo();
  await page.evaluate("document.querySelector('[data-ai=captions]').click()");
  await arrived(() => captions().length > 0);
  expect(captions().length).toBeGreaterThan(10);
  expect(ui.core.doc(ui.handle).tracks.at(-1)!.name).toBe("Captions");
  expect(await undo()).toBe(steps + 1);
  const first = captions()[0]!;
  expect((await session()).selection).toEqual([first.id]);
  await page.until("!!document.querySelector('textarea')");
  // Retyped and confirmed with Return: the caption says it, with its words' times kept when the count is the same.
  const before = (first.props.caption as { words: { text: string; start: number }[] }).words;
  await page.evaluate("document.querySelector('textarea').focus()");
  await type(before.map((w, i) => (i === 0 ? "Fixed" : w.text)).join(" "));
  await page.key("Enter", "Enter");
  await arrived(() => (clip(first.id).props.caption as { words: { text: string }[] }).words[0]!.text === "Fixed");
  const after = (clip(first.id).props.caption as { words: { text: string; start: number }[] }).words;
  expect(after.map((w) => w.start)).toEqual(before.map((w) => w.start));
  // Top restyles all of them in one step.
  const edits = await undo();
  await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Top').click()");
  const look = () => ui.core.doc(ui.handle).tracks.find((t) => t.name === "Captions")!.props!.captionStyle as { anchorY: string };
  await arrived(() => look().anchorY === "top");
  expect(look().anchorY).toBe("top");
  expect(await undo()).toBe(edits + 1);
  for (let n = (await undo()) - steps; n > 0; n--) await ui.core.undo(ui.handle);
  expect(captions().length).toBe(0);
  await run("panel.show", { tool: null });
}, 150_000);

test.skipIf(skip)("Border is a property of video and images on the Visual tab, not an effect tile; annotations don't have it", async () => {
  await run("panel.show", { tool: "visualEffects" });
  await page.until("document.querySelectorAll('[data-art]').length > 0");
  expect(await has("[data-art=border]")).toBe(false);
  const label = `[...document.querySelectorAll('span')].some((s) => s.textContent === 'Border')`;
  await select([screen.id]);
  await run("inspector.tab", { tab: "transform" });
  await page.until(label);
  const steps = (await ui.core.history(ui.handle)).undo.length;
  await run("clip.set", { clips: [screen.id], props: { border: { thickness: 12 } } });
  expect(clip(screen.id).props.border).toEqual({ thickness: 12, color: [1, 1, 1, 1] });
  await ui.core.undo(ui.handle);
  expect((await ui.core.history(ui.handle)).undo.length).toBe(steps);
  await select([callout.id]);
  await run("inspector.tab", { tab: "transform" });
  await Bun.sleep(300);
  expect(await page.evaluate<boolean>(label)).toBe(false);
  await select([]);
  await run("panel.show", { tool: null });
});

const MIC = join(FIXTURES, "take.brec/microphone.wav");
const MODEL = join(homedir(), "Library/Caches/Beacon/models/ggml-large-v3-turbo-q5_0.bin");

test.skipIf(skip || !existsSync(MIC) || !existsSync(MODEL))("Captions asked for before the transcript exists start it, say so with its progress, and are made when it is done", async () => {
  // Imported where the speech model isn't, so no transcript is made; then opened where it is.
  const path = join(dir, "untranscribed.beproj");
  const bare = new LocalCore({ cacheDir: join(dir, "bare-cache") });
  const h = await bare.create({ path });
  expect((await bare.import(h, [MIC])).needs).toEqual(["whisper-model"]);
  await bare.close(h);
  const cacheDir = join(dir, "model-cache");
  mkdirSync(join(cacheDir, "models"), { recursive: true });
  symlinkSync(MODEL, join(cacheDir, "models", "ggml-large-v3-turbo-q5_0.bin"));
  const other = await serveUi(path, { cacheDir });
  const p = await openPage(other.url);
  try {
    await p.until("document.querySelectorAll('[data-asset]').length >= 1", 15000);
    await other.core.run(other.handle, "panel.show", { tool: "ai" });
    await p.until("!!document.querySelector('[data-ai=captions]')");
    await p.evaluate("document.querySelector('[data-ai=captions]').click()");
    await p.until("/Transcribing/.test(document.querySelector('[data-captions-waiting]')?.textContent ?? '')", 5000);
    const captions = () => other.core.doc(other.handle).tracks.flatMap((t) => t.clips).filter((c) => c.type === "caption");
    await arrived(() => captions().length > 0, 60_000);
    expect(captions().length).toBeGreaterThan(0);
    await p.until("!document.querySelector('[data-captions-waiting]')");
    expect((await other.core.session(other.handle)).selection).toEqual([captions()[0]!.id]);
  } finally {
    p.close();
    await other.close();
  }
}, 90_000);

test.skipIf(skip)("a caption on the canvas: dragging moves every caption (snapping to the middle), a side handle narrows its lines, and a double-click types into it", async () => {
  for (const end = Date.now() + 120_000; !((await ui.core.query(ui.handle, "transcript.get", { format: "words" })) as unknown[]).length && Date.now() < end; ) await Bun.sleep(500);
  const ids = (await run("captions.create", {})).results[0] as string[];
  const style = () => ui.core.doc(ui.handle).tracks.find((t) => t.clips.some((c) => c.id === ids[0]))!.props!.captionStyle as { anchorY: string; offsetY: number; offsetX: number; maxWidth: number };
  const first = clip(ids[0]!);
  const words = () => (clip(ids[0]!).props.caption as { words: { text: string; start: number }[] }).words;
  await run("playhead.set", { time: ticksToSeconds(first.start + first.duration / 2) });
  await select([first.id]);
  await page.until(`!!document.querySelector('[data-handle="e"][data-clip="${first.id}"]')`);
  // Captions have side handles only: no corners, no rotation.
  expect(await has(`[data-handle="se"][data-clip="${first.id}"]`)).toBe(false);
  expect(await has(`[data-handle="rotate"][data-clip="${first.id}"]`)).toBe(false);
  const [ex, ey] = await centre(`[data-handle="e"][data-clip="${first.id}"]`);
  const [wx] = await centre(`[data-handle="w"][data-clip="${first.id}"]`);
  const steps = (await ui.core.history(ui.handle)).undo.length;
  // Up by a third of the canvas: still kept to the bottom, further in, one undo step for every caption.
  const before = style().offsetY;
  await page.drag([(ex + wx) / 2, ey], [(ex + wx) / 2 + 3, ey - 120]);
  await arrived(() => style().offsetY > before + 50);
  expect(style().anchorY).toBe("bottom");
  // Snapped back to the centre across.
  expect(style().offsetX).toBe(0);
  expect((await ui.core.history(ui.handle)).undo.length).toBe(steps + 1);
  // The right handle dragged in narrows the lines.
  await page.until(`!!document.querySelector('[data-handle="e"][data-clip="${first.id}"]')`);
  const [hx, hy] = await centre(`[data-handle="e"][data-clip="${first.id}"]`);
  await page.drag([hx, hy], [hx - 20, hy]);
  await arrived(() => style().maxWidth < 0.8);
  expect(style().maxWidth).toBeLessThan(0.8);
  // Double-clicked: typed in place, the words keep their times.
  const [cx, cy] = await page.evaluate<[number, number]>(`(() => { const g = [...document.querySelectorAll('[data-clip="${first.id}"]')].map(e => e.getBoundingClientRect()); return [(g[0].x + g[1].x) / 2 + g[0].width / 2, g[0].y + g[0].height / 2]; })()`);
  await page.evaluate(`(() => { const el = document.elementFromPoint(${cx}, ${cy}); for (const t of ['pointerdown','mousedown']) el.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: ${cx}, clientY: ${cy}, button: 0, detail: 2, pointerId: 1 })); })()`);
  await page.until(`document.activeElement?.getAttribute('aria-label') === 'Text'`);
  const times = words().map((w) => w.start);
  const typed = ["Edited", ...words().slice(1).map((w) => w.text)].join(" ");
  await page.evaluate(`document.execCommand('insertText', false, ${JSON.stringify(typed)})`);
  await arrived(() => words()[0]!.text === "Edited");
  expect(words().map((w) => w.start)).toEqual(times);
  await page.key("Escape", "Escape");
  for (let n = (await ui.core.history(ui.handle)).undo.length - steps + 1; n > 0; n--) await ui.core.undo(ui.handle);
  expect(clips().filter((c) => c.type === "caption").length).toBe(0);
});

test.skipIf(skip)("⌥-dragging a caption places it on its own; ⌥⇧ places it and those after it; Use shared puts it back", async () => {
  for (const end = Date.now() + 120_000; !((await ui.core.query(ui.handle, "transcript.get", { format: "words" })) as unknown[]).length && Date.now() < end; ) await Bun.sleep(500);
  const ids = (await run("captions.create", {})).results[0] as string[];
  const steps = (await ui.core.history(ui.handle)).undo.length;
  const own = (id: string) => clip(id).props.captionPlace as { offsetY: number } | undefined;
  const shared = () => ui.core.doc(ui.handle).tracks.find((t) => t.clips.some((c) => c.id === ids[0]))!.props!.captionStyle as { offsetY: number };
  const dragUp = async (id: string, mods: ("alt" | "shift")[]) => {
    const c = clip(id);
    await run("playhead.set", { time: ticksToSeconds(c.start + c.duration / 2) });
    await select([id]);
    await page.until(`!!document.querySelector('[data-handle="e"][data-clip="${id}"]')`);
    const [ex, ey] = await centre(`[data-handle="e"][data-clip="${id}"]`);
    const [wx] = await centre(`[data-handle="w"][data-clip="${id}"]`);
    await page.drag([(ex + wx) / 2, ey], [(ex + wx) / 2 + 3, ey - 120], mods);
  };
  const before = shared().offsetY;
  await dragUp(ids[2]!, ["alt"]);
  await arrived(() => (own(ids[2]!)?.offsetY ?? 0) > before + 50);
  expect(own(ids[2]!)!.offsetY).toBeGreaterThan(before + 50);
  expect(shared().offsetY).toBe(before);
  expect(own(ids[3]!)).toBeUndefined();
  await page.until("!!document.querySelector('[data-caption-own]')");
  // From the sixth on, all of them.
  await dragUp(ids[5]!, ["alt", "shift"]);
  await arrived(() => !!own(ids.at(-1)!));
  expect(ids.slice(5).every((id) => !!own(id))).toBe(true);
  expect(own(ids[4]!)).toBeUndefined();
  // Put back: it follows the shared place again.
  await select([ids[2]!]);
  await page.until("!!document.querySelector('[data-caption-own] button')");
  await page.evaluate("document.querySelector('[data-caption-own] button').click()");
  await arrived(() => !own(ids[2]!));
  expect(own(ids[2]!)).toBeUndefined();
  for (let n = (await ui.core.history(ui.handle)).undo.length - steps + 1; n > 0; n--) await ui.core.undo(ui.handle);
  expect(clips().filter((c) => c.type === "caption").length).toBe(0);
});

test.skipIf(skip)("Delete acts on what was selected last: a range made after a clip is selected deletes the range; a clip clicked after the range deletes the clip", async () => {
  const before = clips().length;
  await select([callout.id]);
  await run("range.set", { in: 0.5, out: 1 });
  expect((await session()).selection).toEqual([]);
  await run("edit.delete");
  // The range went from the callout's track; the callout itself is still there either side of it.
  const track = ui.core.doc(ui.handle).tracks.find((t) => t.clips.some((c) => c.id === callout.id))!;
  expect(track.clips.some((c) => ticksToSeconds(c.start) <= 0.75 && ticksToSeconds(c.start + c.duration) > 0.75)).toBe(false);
  expect(clip(callout.id)).toBeDefined();
  await ui.core.undo(ui.handle);
  // The other way round: the clip, chosen last, goes; the range stays.
  await run("range.set", { in: 0.5, out: 1 });
  await select([callout.id]);
  await run("edit.delete");
  expect(clips().some((c) => c.id === callout.id)).toBe(false);
  expect((await session()).range).not.toBeNull();
  await ui.core.undo(ui.handle);
  await run("range.clear");
  expect(clips().length).toBe(before);
});
