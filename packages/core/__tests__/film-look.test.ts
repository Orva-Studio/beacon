import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-film-look-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rgb(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

const mean = (px: Uint8Array, c: number) => {
  let n = 0;
  for (let i = c; i < px.length; i += 4) n += px[i]!;
  return n / (px.length / 4);
};

type Look = { name: string; params: Record<string, number>; notReproduced: string[] };

test.skipIf(!existsSync(VIDEO))("a hance look on a clip: its values on Film Look's sliders, what it can't do listed, one undo step; the preview shows what the export renders", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "look.beproj") });
  const copy = join(dir, "video.mp4");
  copyFileSync(VIDEO, copy);
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "plain") }, frames: [30], cacheDir: core.cacheDir });

  const before = JSON.stringify(core.doc(h).tracks);
  const loaded = (await core.run(h, "filmLook.load", { clips: [clip.id], look: "cinestill-800t" })).results[0] as Look;
  expect(loaded.name).toBe("CineStill 800T");
  expect(loaded.params).toEqual({ strength: 1, exposure: 0.1, warmth: 1, fade: 0.1, contrast: 1.05, saturation: 1, grain: 0.1875, grainSize: 1, halation: 0.7, halationSize: 14, vignette: 0.25 });
  expect(loaded.notReproduced).toContain("bloom 0.45 (radius 16)");
  expect(loaded.notReproduced).toContain("camera shake 0.15");
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects;
  expect(fx.map((e) => [e.type, e.params])).toEqual([["film-look", loaded.params]]);
  // Loaded again, the same effect takes the new look rather than a second being added.
  await core.run(h, "filmLook.load", { clips: [clip.id], look: "portra-400" });
  expect(core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects.length).toBe(1);
  await core.undo(h);

  // Warmer, as CineStill 800T is in hance (its white balance at 4500 K).
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "look") }, frames: [30, 31], cacheDir: core.cacheDir });
  const [plain, look, next] = await Promise.all([rgb(join(dir, "plain/f000030.png")), rgb(join(dir, "look/f000030.png")), rgb(join(dir, "look/f000031.png"))]);
  expect(mean(look, 0) - mean(look, 2)).toBeGreaterThan(mean(plain, 0) - mean(plain, 2) + 3);
  // At the canvas size the preview is the export, pixel for pixel, grain included (seeded by the frame).
  const view = core.attachView(h, { offscreen: { width: 1920, height: 1080 } });
  view.show(1);
  view.settle();
  expect(Buffer.from(view.flush()!).equals(Buffer.from(look))).toBe(true);
  core.detachView(h);
  // The grain moves from frame to frame.
  expect(Buffer.from(next).equals(Buffer.from(look))).toBe(false);

  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 120_000);

test("a .hlook of your own: what it leaves out is hance's default, and what Film Look can't do, or only partly, is listed", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-b") });
  const h = await core.create({ path: join(dir, "read.beproj") });
  const file = join(dir, "mine.hlook");
  writeFileSync(file, JSON.stringify({ hance_version: "0.3.1", name: "Mine", params: { fade: 0.3, "white-balance": 2000, "split-tone-amount": 0.4, "grain-iso": 800, sparkle: 3 } }));
  const look = (await core.query(h, "filmLook.read", { path: file })) as Look;
  expect(look.name).toBe("Mine");
  expect(look.params).toMatchObject({ fade: 0.3, warmth: 2, grain: 0.25, halation: 0.25, halationSize: 4, vignette: 0.25, contrast: 1 });
  expect(look.notReproduced).toEqual([
    "white balance 2000 K (Film Look's warmth reaches 2500–10500 K)",
    "chromatic aberration 0.3",
    "bloom 0.25 (radius 10)",
    "split tone 0.4 (shadows 30°, highlights 210°)",
    "camera shake 0.25",
    'sparkle 3 (unknown to Film Look)',
  ]);
  writeFileSync(file, "not json");
  await expect(core.query(h, "filmLook.read", { path: file })).rejects.toThrow(/isn't a \.hlook/);
  expect(((await core.query(h, "filmLook.looks", {})) as unknown[]).length).toBe(41);
  await core.close(h);
});

test("a .hlook path that isn't a small regular file is refused without reading it (a pipe would block)", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-c") });
  const h = await core.create({ path: join(dir, "pipe.beproj") });
  const fifo = join(dir, "look.fifo");
  Bun.spawnSync(["/usr/bin/mkfifo", fifo]);
  await expect(core.query(h, "filmLook.read", { path: fifo })).rejects.toThrow(/not a file/);
  await expect(core.query(h, "filmLook.read", { path: dir })).rejects.toThrow(/not a file/);
  const big = join(dir, "big.hlook");
  writeFileSync(big, Buffer.alloc(2 << 20, 32));
  await expect(core.query(h, "filmLook.read", { path: big })).rejects.toThrow(/2 MB/);
  await core.close(h);
});
