import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const BRIGHT = join(FIXTURES, "video-3.mp4");
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
  expect(loaded.params).toEqual({ strength: 1, exposure: 0.1, warmth: 1, tint: 0.02, fade: 0.1, contrast: 1.05, saturation: 1, grain: 0.1875, grainSize: 1, halation: 0.7, halationSize: 14, vignette: 0.25, splitTone: 0.25, shadowHue: 220, highlightHue: 40, highlightStrength: 1 });
  expect(loaded.notReproduced).toContain("bloom 0.45 (radius 16)");
  expect(loaded.notReproduced).toContain("camera shake 0.15");
  expect(loaded.notReproduced.some((n) => n.includes("split tone"))).toBe(false);
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects;
  expect(fx.map((e) => [e.type, e.params])).toEqual([["film-look", loaded.params]]);
  // Loaded again, the same effect takes the new look rather than a second being added.
  await core.run(h, "filmLook.load", { clips: [clip.id], look: "portra-400" });
  expect(core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects.length).toBe(1);
  await core.undo(h);

  // On this dark frame CineStill 800T's teal shadows outweigh its warmer white balance (4500 K), as in hance.
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "look") }, frames: [30, 31], cacheDir: core.cacheDir });
  const [plain, look, next] = await Promise.all([rgb(join(dir, "plain/f000030.png")), rgb(join(dir, "look/f000030.png")), rgb(join(dir, "look/f000031.png"))]);
  expect(mean(look, 2) - mean(look, 0)).toBeGreaterThan(mean(plain, 2) - mean(plain, 0) + 3);
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

test.skipIf(!existsSync(VIDEO) || !existsSync(BRIGHT))("split tone tints the shadows one hue and the highlights another; a Film Look saved before it opens with it off", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-st") });
  const path = join(dir, "split.beproj");
  const h = await core.create({ path });
  // A dark clip (all shadow) and a bright one (all highlight), one after the other.
  const copies = [VIDEO, BRIGHT].map((f, i) => {
    const copy = join(dir, `split-${i}.mp4`);
    copyFileSync(f, copy);
    return copy;
  });
  const r = await core.import(h, copies, { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clips = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "video").sort((a, b) => a.start - b.start);
  expect(clips.length).toBe(2);
  for (const c of clips) await core.run(h, "effect.add", { clip: c.id, type: "film-look", params: { grain: 0, halation: 0, vignette: 0 } });
  const { num, den } = core.doc(h).settings.fps;
  const fps = num / den;
  const frames = clips.map((c) => Math.round(ticksToSeconds(c.start) * fps) + 30);
  // Blue less red, over the dark clip's frame and the bright one's.
  const blueness = async (name: string) => {
    await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, name) }, frames, cacheDir: core.cacheDir });
    return Promise.all(frames.map(async (f) => {
      const px = await rgb(join(dir, name, `f${String(f).padStart(6, "0")}.png`));
      return mean(px, 2) - mean(px, 0);
    }));
  };
  const [darkBefore, brightBefore] = await blueness("st-off");
  for (const c of clips) {
    const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((x) => x.id === c.id)!.effects[0]!;
    await core.run(h, "effect.set", { clip: c.id, effect: fx.id, params: { splitTone: 1, shadowHue: 210, highlightHue: 30, highlightStrength: 1 } });
  }
  const [dark, bright] = await blueness("st-on");
  // Teal shadows, orange highlights.
  expect(dark!).toBeGreaterThan(darkBefore! + 10);
  expect(bright!).toBeLessThan(brightBefore! - 10);
  await core.close(h);

  // Saved by Beacon before split tone and tint: the effect without them, the feature at version 1.
  const file = join(path, "project.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const saved = doc.tracks.flatMap((t: { clips: { id: string; effects: { params: Record<string, number> }[] }[] }) => t.clips).find((c: { id: string }) => c.id === clips[0]!.id).effects[0];
  for (const k of ["tint", "splitTone", "shadowHue", "highlightHue", "highlightStrength"]) delete saved.params[k];
  doc.features["film-look"] = 1;
  writeFileSync(file, JSON.stringify(doc));
  const again = await core.open(path);
  expect(core.doc(again).tracks.flatMap((t) => t.clips).find((c) => c.id === clips[0]!.id)!.effects[0]!.params).toMatchObject({ tint: 0, splitTone: 0, shadowHue: 30, highlightHue: 210, highlightStrength: 0.5, grain: 0 });
  await core.close(again);
}, 120_000);

test("a .hlook of your own: what it leaves out is hance's default, and what Film Look can't do, or only partly, is listed", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-b") });
  const h = await core.create({ path: join(dir, "read.beproj") });
  const file = join(dir, "mine.hlook");
  writeFileSync(file, JSON.stringify({ hance_version: "0.3.1", name: "Mine", params: { fade: 0.3, "white-balance": 2000, tint: -50, "split-tone-amount": 0.4, "split-tone-pivot": 0.5, "grain-iso": 800, sparkle: 3 } }));
  const look = (await core.query(h, "filmLook.read", { path: file })) as Look;
  expect(look.name).toBe("Mine");
  expect(look.params).toMatchObject({ fade: 0.3, warmth: 2, tint: -0.5, grain: 0.25, halation: 0.25, halationSize: 4, vignette: 0.25, contrast: 1, splitTone: 0.4, shadowHue: 30, highlightHue: 210, highlightStrength: 0.5 });
  expect(look.notReproduced).toEqual([
    "white balance 2000 K (Film Look's warmth reaches 2500–10500 K)",
    "chromatic aberration 0.3",
    "bloom 0.25 (radius 10)",
    "split tone pivot 0.5 (Film Look's is 0.3)",
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

test.skipIf(!existsSync(VIDEO))("a look previewed on the canvas shows what applying it would, and never reaches the document, the undo history or an export; ending it, or playing, shows the clip as it is", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-pv") });
  const h = await core.create({ path: join(dir, "preview.beproj") });
  const copy = join(dir, "video-pv.mp4");
  copyFileSync(VIDEO, copy);
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  await core.run(h, "effect.add", { clip: clip.id, type: "film-look", params: { strength: 0 } });
  const fx = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects[0]!;
  const look = ((await core.query(h, "filmLook.looks", {})) as { id: string; params: Record<string, unknown> }[]).find((l) => l.id === "cinestill-800t")!;

  const view = core.attachView(h, { offscreen: { width: 1920, height: 1080 } }, { silent: true, proxies: false });
  view.show(1);
  view.settle();
  const plain = Buffer.from(view.flush()!);
  const doc = JSON.stringify(core.doc(h));
  const history = JSON.stringify(await core.history(h));

  await core.previewEffect(h, { clip: clip.id, effect: fx().id, params: look.params });
  const previewed = Buffer.from(view.flush()!);
  expect(previewed.equals(plain)).toBe(false);
  expect(JSON.stringify(core.doc(h))).toBe(doc);
  expect(JSON.stringify(await core.history(h))).toBe(history);
  // An export made meanwhile renders the document, not the preview.
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "pv-export") }, frames: [30], cacheDir: core.cacheDir });
  expect(Buffer.from(await rgb(join(dir, "pv-export/f000030.png"))).equals(plain)).toBe(true);

  await core.previewEffect(h, null);
  expect(Buffer.from(view.flush()!).equals(plain)).toBe(true);

  // Applied, the canvas is what the preview showed.
  await core.run(h, "effect.set", { clip: clip.id, effect: fx().id, params: look.params });
  expect(Buffer.from(view.flush()!).equals(previewed)).toBe(true);
  await core.undo(h);
  expect(Buffer.from(view.flush()!).equals(plain)).toBe(true);

  // Playing ends a preview; so does its effect going away.
  await core.previewEffect(h, { clip: clip.id, effect: fx().id, params: look.params });
  await core.run(h, "playback.play", {});
  await core.run(h, "playback.pause", {});
  await core.run(h, "playhead.set", { time: 1 });
  view.settle();
  expect(Buffer.from(view.flush()!).equals(plain)).toBe(true);
  await core.previewEffect(h, { clip: clip.id, effect: fx().id, params: look.params });
  await core.run(h, "effect.remove", { clip: clip.id, effect: fx().id });
  await expect(core.previewEffect(h, { clip: clip.id, effect: "gone", params: {} })).rejects.toThrow(/no effect/);
  core.detachView(h);
  await core.close(h);
}, 120_000);

test.skipIf(!existsSync(VIDEO))("Paste Properties gives a clip the copied clip's effects: a Film Look the copy didn't have is removed, one undo step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "paste-cache") });
  const h = await core.create({ path: join(dir, "paste.beproj") });
  const copy = join(dir, "paste.mp4");
  copyFileSync(VIDEO, copy);
  for (const at of [0, 20]) for (const j of (await core.import(h, [copy], { at })).jobs) await core.cancelJob(j).catch(() => {});
  const [a, b] = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "video");
  await core.run(h, "filmLook.load", { clips: [a!.id, b!.id], look: "cinestill-800t" });
  await core.run(h, "effect.add", { clip: b!.id, type: "round-corners" });
  const effects = (id: string) => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.effects.map((e) => e.type);
  await core.run(h, "effect.remove", { clip: a!.id, effect: core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === a!.id)!.effects[0]!.id });
  expect(effects(a!.id)).toEqual([]);
  const before = JSON.stringify(core.doc(h).tracks);
  await core.run(h, "properties.copy", { clip: a!.id });
  await core.run(h, "selection.set", { clips: [b!.id] });
  await core.run(h, "edit.pasteProperties", {});
  expect(effects(b!.id)).toEqual([]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
});
