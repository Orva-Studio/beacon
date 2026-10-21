import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-remove-bg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rgba(file: string, ...args: string[]): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", ...args, "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

/** The pixel at (x, y) of a 1920-wide frame. */
const at = (px: Uint8Array, x: number, y: number) => [...px.slice((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 3)];
const near = (a: number[], b: number[], tolerance: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tolerance);

/** The wall behind the person in `take.brec`'s camera, and the person's chest. */
const WALL: [number, number] = [60, 60];
const CHEST: [number, number] = [960, 900];

async function take(core: LocalCore, name: string) {
  const copy = join(dir, `${name}.brec`);
  cpSync(TAKE, copy, { recursive: true });
  const h = await core.create({ path: join(dir, `${name}.beproj`) });
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const camera = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  return { h, camera };
}

test.skipIf(!existsSync(TAKE))("Remove Background on a camera take: the person is found once (a matte job), and the wall gives way to a colour, the clips below or a blur of itself, the person unchanged; the preview shows what the export renders", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const { h, camera } = await take(core, "rb");
  const frame = async (name: string) => {
    await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, name) }, frames: [30], cacheDir: core.cacheDir });
    return rgba(join(dir, name, "f000030.png"));
  };
  const plain = await frame("plain");
  const before = JSON.stringify(core.doc(h).tracks);

  // Adding the effect starts the matte job; until it is done the clip shows as it is.
  await core.run(h, "effect.add", { clip: camera.id, type: "remove-background" });
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === camera.id)!.effects[0]!;
  await (await core.analyze(h, "matte", camera.assetId!)).done;
  // The camera only: the take's screen (video stream 0) has no person to find.
  const matte = core.derived<{ streams: Record<number, { path: string; width: number; height: number }> }>(h, camera.assetId!, "matte")!;
  expect(Object.keys(matte.streams)).toEqual(["1"]);
  expect([matte.streams[1]!.width, matte.streams[1]!.height]).toEqual([1280, 720]);

  await core.run(h, "effect.set", { clip: camera.id, effect: fx.id, params: { background: "color", color: [0, 1, 0, 1] } });
  const green = await frame("green");
  expect(near(at(green, ...WALL), [0, 255, 0], 2)).toBe(true);
  expect(near(at(green, ...CHEST), at(plain, ...CHEST), 3)).toBe(true);
  // At the canvas size the preview is the export, pixel for pixel.
  const view = core.attachView(h, { offscreen: { width: 1920, height: 1080 } });
  view.show(1);
  view.settle();
  expect(Buffer.from(view.flush()!).equals(Buffer.from(green))).toBe(true);
  core.detachView(h);

  // Transparent: what is under the wall is the screen recording, as with the camera hidden.
  await core.run(h, "effect.set", { clip: camera.id, effect: fx.id, params: { background: "transparent" } });
  const clear = await frame("clear");
  const cameraTrack = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === camera.id))!;
  await core.run(h, "track.set", { track: cameraTrack.id, hidden: true });
  const below = await frame("below");
  await core.undo(h);
  expect(near(at(clear, ...WALL), at(below, ...WALL), 2)).toBe(true);
  expect(near(at(clear, ...CHEST), at(plain, ...CHEST), 3)).toBe(true);

  // Blurred: the clip's own wall behind the person, not the screen, softened.
  await core.run(h, "effect.set", { clip: camera.id, effect: fx.id, params: { background: "blur", blur: 1 } });
  const blur = await frame("blur");
  expect(near(at(blur, ...WALL), at(below, ...WALL), 10)).toBe(false);
  expect(near(at(blur, ...WALL), at(plain, ...WALL), 40)).toBe(true);
  expect(near(at(blur, ...CHEST), at(plain, ...CHEST), 3)).toBe(true);

  for (let i = 0; i < 4; i++) await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 180_000);

test.skipIf(!existsSync(TAKE))("an export started before the person is found waits for the matte rather than rendering the clip without it", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-export") });
  const { h, camera } = await take(core, "rb-export");
  await core.run(h, "effect.add", { clip: camera.id, type: "remove-background" });
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === camera.id)!.effects[0]!;
  await core.run(h, "effect.set", { clip: camera.id, effect: fx.id, params: { background: "color", color: [0, 1, 0, 1] } });
  const out = join(dir, "export.mp4");
  await (await core.export(h, { output: out, from: 0, to: 1 })).done;
  const px = await rgba(out, "-ss", "0.5");
  expect(near(at(px, ...WALL), [0, 255, 0], 12)).toBe(true);
  await core.close(h);
}, 180_000);
