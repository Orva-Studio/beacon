import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-device-frame-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WIDTH = 640;

async function pixels(png: Uint8Array, name: string): Promise<Uint8Array> {
  const path = join(dir, `${name}.png`);
  writeFileSync(path, png);
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

/** The light a saved frame gives off: the mean of its red, green and blue as linear light (a gamma of 2). */
async function light(name: string): Promise<number> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", join(dir, `${name}.png`), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
  const px = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  return px.reduce((a, v) => a + (v / 255) ** 2, 0) / px.length;
}

/** How much detail a band of columns holds: the mean step between neighbouring pixels. */
function detail(px: Uint8Array, from: number, to: number): number {
  const height = px.length / WIDTH;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(height * 0.2); y < height * 0.8; y++)
    for (let x = Math.floor(WIDTH * from); x < WIDTH * to - 1; x++) {
      sum += Math.abs(px[y * WIDTH + x + 1]! - px[y * WIDTH + x]!);
      n++;
    }
  return sum / n;
}

test.skipIf(!existsSync(TAKE))("Monitor puts the recording on a monitor filmed head on, sharp where the focus is and softening away from it, as one undo step; a Film Look on the clip grades the whole shot, its Opacity fades all of it and its Rotation turns the camera", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const take = join(dir, "take.brec");
  cpSync(TAKE, take, { recursive: true });
  for (const j of (await core.import(h, [take], { at: 0 })).jobs) await core.cancelJob(j).catch(() => {});
  for (const t of core.doc(h).tracks) if (!t.clips.some((c) => c.type === "screen")) await core.run(h, "track.set", { track: t.id, hidden: true });
  const screen = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "screen")!;
  const flat = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "flat");

  const lift = (px: Uint8Array) => px.reduce((a, v) => a + v, 0) / px.length;
  const steps = (await core.history(h)).undo.length;
  const fx = (await core.run(h, "effect.add", { clip: screen.id, type: "device-frame", params: { drift: 0, focus: "point", focusX: 0.09, focusY: 0.1 } })).results[0] as string;
  expect((await core.history(h)).undo.length).toBe(steps + 1);
  const near = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "near");
  expect(Buffer.from(near).equals(Buffer.from(flat))).toBe(false);

  await core.run(h, "effect.set", { clip: screen.id, effect: fx, params: { focusX: 0.9, focusY: 0.9 } });
  const far = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "far");
  // The corner in shot is sharp while it is in focus, and softens once the focus is across the screen.
  expect(detail(near, 0.3, 1)).toBeGreaterThan(detail(far, 0.3, 1) * 1.5);

  // The clip's Rotation turns the camera (it did nothing on a Monitor clip): Y round the monitor.
  await core.run(h, "clip.set", { clip: screen.id, props: { transform: { rotationY: 0.4 } } });
  const turned = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "turned");
  expect(Buffer.from(turned).equals(Buffer.from(far))).toBe(false);
  await core.undo(h);

  // Pixels: close in, the screen's subpixel stripes add fine detail; at the default zoom they are too small to draw.
  const at = async (params: Record<string, unknown>, name: string) => {
    await core.run(h, "effect.set", { clip: screen.id, effect: fx, params });
    return pixels((await core.frame(h, 1, { width: WIDTH })).png, name);
  };
  // Zoom stops at 2.5, so the clip's own Scale punches the camera in the rest of the way.
  const scale = (screen.props.transform as { scaleX: number }).scaleX * 5;
  await core.run(h, "clip.set", { clip: screen.id, props: { transform: { scaleX: scale, scaleY: scale } } });
  const close = { zoom: 2.5, blur: 0, focusX: 0.06, focusY: 0.08 };
  const stripes = await at({ ...close, pixels: 1 }, "stripes");
  const plain = await at({ ...close, pixels: 0 }, "plain");
  expect(detail(stripes, 0.2, 0.8)).toBeGreaterThan(detail(plain, 0.2, 0.8) * 1.3);
  // The stripes share out each pixel's light rather than taking it away: the picture keeps most of its brightness, even
  // at full strength (at the project's own size: a frame scaled down averages display values, which darkens stripes).
  writeFileSync(join(dir, "plain-full.png"), (await core.frame(h, 1)).png);
  await core.undo(h);
  writeFileSync(join(dir, "stripes-full.png"), (await core.frame(h, 1)).png);
  await core.redo(h);
  expect(Math.abs((await light("stripes-full")) / (await light("plain-full")) - 1)).toBeLessThan(0.25);
  for (let i = 0; i < 3; i++) await core.undo(h);
  expect(Buffer.from(await at({ zoom: 2, blur: 0.6, focusX: 0.9, focusY: 0.9, pixels: 1 }, "far-stripes")).equals(Buffer.from(far))).toBe(true);
  // Glossy glass mirrors the room behind the camera: light added on the screen.
  const glass = await at({ pixels: 0.5, screen: "glossy", reflection: 1 }, "glossy");
  expect(lift(glass)).toBeGreaterThan(lift(await at({ reflection: 0 }, "no-reflection")) + 1);
  for (let i = 0; i < 3; i++) await core.undo(h);

  // The clip's Opacity fades the whole shot, room and bezel too (they hid the screen fading).
  await core.run(h, "clip.set", { clip: screen.id, props: { transform: { opacity: 0.5 } } });
  const faded = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "faded");
  expect(lift(faded)).toBeLessThan(lift(far) * 0.65);
  expect(lift(faded)).toBeGreaterThan(lift(far) * 0.35);
  await core.undo(h);

  // A Film Look on the clip grades the whole shot: the room above the monitor (not the recording) changes too.
  const room = (px: Uint8Array) => px.slice(0, WIDTH * Math.floor(px.length / WIDTH / 10));
  await core.run(h, "effect.add", { clip: screen.id, type: "film-look", params: { exposure: 1, vignette: 0, grain: 0 } });
  const graded = await pixels((await core.frame(h, 1, { width: WIDTH })).png, "graded");
  expect(lift(room(graded))).toBeGreaterThan(lift(room(far)) + 5);

  await core.undo(h);
  await core.undo(h);
  await core.undo(h);
  expect(core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === screen.id)!.effects).toEqual([]);
  expect(Buffer.from(await pixels((await core.frame(h, 1, { width: WIDTH })).png, "back")).equals(Buffer.from(flat))).toBe(true);
  await core.close(h);
}, 120_000);

test.skipIf(!existsSync(TAKE))("Monitor's Pixels add no beats where a recording pixel is only a few output pixels wide (the close shots people use most)", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-moire"), configDir: join(dir, "config-moire") });
  const h = await core.create({ path: join(dir, "moire.beproj") });
  const take = join(dir, "moire.brec");
  cpSync(TAKE, take, { recursive: true });
  for (const j of (await core.import(h, [take], { at: 0 })).jobs) await core.cancelJob(j).catch(() => {});
  for (const t of core.doc(h).tracks) if (!t.clips.some((c) => c.type === "screen")) await core.run(h, "track.set", { track: t.id, hidden: true });
  const screen = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "screen")!;
  const fx = (await core.run(h, "effect.add", { clip: screen.id, type: "device-frame", params: { drift: 0, zoom: 2.5, blur: 0, focus: "point", focusX: 0.5, focusY: 0.5, reflection: 0, pixels: 1 } })).results[0] as string;
  const base = (screen.props.transform as { scaleX: number }).scaleX;
  const rgb = async (pixels: number) => {
    await core.run(h, "effect.set", { clip: screen.id, effect: fx, params: { pixels } });
    writeFileSync(join(dir, "moire.png"), (await core.frame(h, 1)).png);
    const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", join(dir, "moire.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
    return new Uint8Array(await new Response(p.stdout).arrayBuffer());
  };
  // About 2.5 and 3.5 output pixels per recording pixel, where a plain average over each pixel beat at 13% and 17%.
  for (const m of [2.2, 3]) {
    await core.run(h, "clip.set", { clip: screen.id, props: { transform: { scaleX: base * m, scaleY: base * m } } });
    const [a, b] = [await rgb(1), await rgb(0)];
    const width = core.doc(h).settings.width;
    const height = a.length / 3 / width;
    // Each column's light with the grid over its light without, across the middle of the screen: the picture cancels,
    // leaving the stripes and any bands they beat into.
    const ratio: number[] = [];
    for (let x = Math.floor(width * 0.3); x < width * 0.7; x++) {
      let sa = 0;
      let sb = 0;
      for (let y = Math.floor(height * 0.3); y < height * 0.7; y++)
        for (let k = 0; k < 3; k++) {
          const i = (y * width + x) * 3 + k;
          sa += (a[i]! / 255) ** 2;
          sb += (b[i]! / 255) ** 2;
        }
      ratio.push(sa / Math.max(sb, 1e-6));
    }
    const n = ratio.length;
    const mean = ratio.reduce((s, v) => s + v, 0) / n;
    const amp = (k: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        re += (ratio[i]! - mean) * Math.cos((2 * Math.PI * k * i) / n);
        im += (ratio[i]! - mean) * Math.sin((2 * Math.PI * k * i) / n);
      }
      return (2 * Math.hypot(re, im)) / n / mean;
    };
    // Bands 5 to 30 pixels apart: slower than the stripes (under 4.5 px apart here), faster than the picture's own shapes.
    let worst = 0;
    for (let k = Math.ceil(n / 30); k <= n / 5; k++) worst = Math.max(worst, amp(k));
    expect(worst).toBeLessThan(0.04);
  }
  await core.close(h);
}, 120_000);
