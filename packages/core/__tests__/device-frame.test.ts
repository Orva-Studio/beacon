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

  // The clip's Opacity fades the whole shot, room and bezel too (they hid the screen fading).
  const lift = (px: Uint8Array) => px.reduce((a, v) => a + v, 0) / px.length;
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
