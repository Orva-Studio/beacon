import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-lut-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A `size`³ .cube giving `f` of each colour (0–1), red fastest as the format has it. */
function cube(path: string, size: number, f: (r: number, g: number, b: number) => [number, number, number], header = "") {
  const rows: string[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) rows.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(" "));
  writeFileSync(path, `# made by the test\nTITLE "Invert"\n${header}LUT_3D_SIZE ${size}\n${rows.join("\n")}\n`);
}

async function rgba(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

/** The largest difference over every pixel's colour between `a` and what `f` makes of `b`. */
function worst(a: Uint8Array, b: Uint8Array, f: (v: number) => number) {
  let max = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) max = Math.max(max, Math.abs(a[i]! - f(b[i]!)));
  return max;
}

test.skipIf(!existsSync(VIDEO))("a .cube LUT on a clip: copied into the project (no clips placed), each colour looked up and mixed by Intensity, the preview equal to the export; broken files refused; a moved project keeps it", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const path = join(dir, "lut.beproj");
  const h = await core.create({ path });
  const video = join(dir, "video.mp4");
  copyFileSync(VIDEO, video);
  const r = await core.import(h, [video], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  const frame = async (name: string, project = core.doc(h)) => {
    await renderProject(project, core.registry, { output: { kind: "png", dir: join(dir, name) }, frames: [30], cacheDir: core.cacheDir });
    return rgba(join(dir, name, "f000030.png"));
  };
  const plain = await frame("plain");
  const before = JSON.stringify(core.doc(h).tracks);

  const invert = join(dir, "Invert.cube");
  cube(invert, 17, (r, g, b) => [1 - r, 1 - g, 1 - b]);
  const imported = await core.import(h, [invert]);
  expect(imported.clips).toEqual([]);
  const asset = core.doc(h).assets[imported.assets[0]!]!;
  expect(asset.kind).toBe("file");
  expect(asset.path).toBe(join(path, "media", "Invert.cube"));
  expect(asset.derived.lut).toEqual({ title: "Invert", size: 17, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });

  await core.run(h, "effect.add", { clip: clip.id, type: "lut" });
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects[0]!;
  // No LUT chosen yet: the clip as it is.
  expect(Buffer.from(await frame("none")).equals(Buffer.from(plain))).toBe(true);
  await core.run(h, "effect.set", { clip: clip.id, effect: fx.id, params: { lut: asset.id } });
  const inverted = await frame("inverted");
  expect(worst(inverted, plain, (v) => 255 - v)).toBeLessThanOrEqual(2);
  // At the canvas size the preview is the export, pixel for pixel.
  const view = core.attachView(h, { offscreen: { width: 1920, height: 1080 } });
  view.show(1);
  view.settle();
  expect(Buffer.from(view.flush()!).equals(Buffer.from(inverted))).toBe(true);
  core.detachView(h);
  await core.run(h, "effect.set", { clip: clip.id, effect: fx.id, params: { intensity: 0.5 } });
  expect(worst(await frame("half"), plain, () => 127.5)).toBeLessThanOrEqual(2);

  // A 1D table, or one short of entries, is refused with why.
  const flat = join(dir, "Flat.cube");
  writeFileSync(flat, "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
  await expect(core.import(h, [flat])).rejects.toThrow("Flat.cube isn't a LUT Beacon can read: it is a 1D LUT");
  const short = join(dir, "Short.cube");
  writeFileSync(short, "LUT_3D_SIZE 2\n0 0 0\n1 1 1\n");
  await expect(core.import(h, [short])).rejects.toThrow("it has 2 entries for a 2³ table");

  const after = JSON.stringify(core.doc(h).tracks);
  for (let i = 0; i < 3; i++) await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  for (let i = 0; i < 3; i++) await core.redo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(after);
  await core.close(h);
  // Moved with its folder, the project still finds its LUT (kept relative to it).
  const moved = join(dir, "moved", "lut.beproj");
  cpSync(path, moved, { recursive: true });
  rmSync(path, { recursive: true });
  const h2 = await core.open(moved);
  expect(core.doc(h2).assets[asset.id]!.path).toBe(join(moved, "media", "Invert.cube"));
  await renderProject(core.doc(h2), core.registry, { output: { kind: "png", dir: join(dir, "moved-frame") }, frames: [30], cacheDir: core.cacheDir });
  expect(worst(await rgba(join(dir, "moved-frame", "f000030.png")), plain, () => 127.5)).toBeLessThanOrEqual(2);
  await core.close(h2);
}, 120_000);

test.skipIf(!existsSync(VIDEO))("a .cube whose rows are signed (+0.5) renders as it imports; relinked to another LUT, the new one's domain is what's drawn, undoably", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-signed") });
  const h = await core.create({ path: join(dir, "signed.beproj") });
  const video = join(dir, "video-signed.mp4");
  copyFileSync(VIDEO, video);
  const r = await core.import(h, [video], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  const frame = async (name: string) => {
    await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, name) }, frames: [30], cacheDir: core.cacheDir });
    return rgba(join(dir, name, "f000030.png"));
  };
  const plain = await frame("signed-plain");

  const signed = join(dir, "Signed.cube");
  cube(signed, 9, (r, g, b) => [1 - r, 1 - g, 1 - b]);
  writeFileSync(signed, (await Bun.file(signed).text()).replace(/^(\d)/gm, "+$1"));
  const asset = (await core.import(h, [signed])).assets[0]!;
  await core.run(h, "effect.add", { clip: clip.id, type: "lut" });
  const fx = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.effects[0]!;
  await core.run(h, "effect.set", { clip: clip.id, effect: fx.id, params: { lut: asset } });
  expect(worst(await frame("signed"), plain, (v) => 255 - v)).toBeLessThanOrEqual(2);

  const wide = join(dir, "Wide.cube");
  cube(wide, 9, (r, g, b) => [1 - r, 1 - g, 1 - b], "DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n");
  await core.relink(h, asset, wide);
  expect(core.doc(h).assets[asset]!.derived.lut).toMatchObject({ domainMax: [2, 2, 2] });
  await core.undo(h);
  expect(core.doc(h).assets[asset]!.derived.lut).toMatchObject({ domainMax: [1, 1, 1] });
  await core.close(h);
}, 120_000);
