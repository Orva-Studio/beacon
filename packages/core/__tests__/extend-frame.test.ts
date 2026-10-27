import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const IMAGE = join(FIXTURES, "image.png");
const dir = mkdtempSync(join(tmpdir(), "beacon-extend-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const seconds = (ticks: number) => ticks / 705_600_000;

async function gray(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

test.skipIf(!existsSync(RECORDING) || !existsSync(IMAGE))("a recording's first frame held before it: with room made its linked clips move with it, at 0 without room it's refused, inside a group not before the group's window", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "extend.beproj") });
  const r = await core.import(h, [RECORDING], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const video = all().find((c) => c.linkId && ["screen", "camera", "video"].includes(c.type))!;
  const partners = () => all().filter((c) => c.linkId === video.linkId);
  expect(partners().length).toBeGreaterThan(1);
  expect(seconds(video.start)).toBe(0);
  const before = JSON.stringify(core.doc(h).tracks);

  await expect(core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start" })).rejects.toThrow(/start/);
  const still = (await core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start", ripple: true })).results[0] as string;
  const held = all().find((c) => c.id === still)!;
  expect([seconds(held.start), seconds(held.duration), held.mediaStart ?? 0]).toEqual([0, 1, video.mediaStart ?? 0]);
  for (const c of partners()) expect(seconds(c.start)).toBe(1);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);

  // Grouped with an image 3 s before it, the group's start then trimmed to 2.5 s: a frame held from 2 s would be hidden.
  await core.run(h, "timeline.insertSpace", { at: 0, duration: 3 });
  await core.run(h, "track.add", { name: "Image" });
  const track = core.doc(h).tracks.find((t) => t.name === "Image")!.id;
  const img = await core.import(h, [IMAGE], { at: 0, track });
  const image = all().find((c) => c.assetId === img.assets[0])!;
  const group = (await core.run(h, "clip.group", { clips: [image.id, ...partners().map((c) => c.id)] })).results[0] as string;
  await core.run(h, "clip.trim", { clip: group, start: 2.5 });
  await expect(core.run(h, "clip.extendFrame", { clip: video.id, duration: 1, edge: "start" })).rejects.toThrow(/group/);
  await core.run(h, "clip.extendFrame", { clip: video.id, duration: 0.5, edge: "start" });
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(RECORDING))("a held frame looks as the clip does there: zoomed in at its end, the still is zoomed in; its first frame, before the zoom, isn't", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "zoomed.beproj") });
  const r = await core.import(h, [RECORDING], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const screen = all().find((c) => c.type === "screen")!;
  const scale = (id: string) => (all().find((c) => c.id === id)!.props.transform as { scaleX: number }).scaleX;
  const base = scale(screen.id);
  await core.run(h, "zoom.to", { clip: screen.id, at: 2, center: { x: 400, y: 300 }, factor: 2 });
  await core.run(h, "timeline.insertSpace", { at: 0, duration: 1 });

  const end = (await core.run(h, "clip.extendFrame", { clip: screen.id, duration: 1 })).results[0] as string;
  expect(scale(end)).toBeCloseTo(base * 2, 5);
  expect(all().find((c) => c.id === end)!.animations).toEqual([]);
  const start = (await core.run(h, "clip.extendFrame", { clip: screen.id, duration: 1, edge: "start" })).results[0] as string;
  expect(scale(start)).toBeCloseTo(base, 5);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(RECORDING))("a stitched clip's frame held after it, and before it: its piece's frame there, in the stitched clip's look, drawn as the clip's edge is; undone in one step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "stitched.beproj") });
  const r = await core.import(h, [RECORDING], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const all = () => core.doc(h).tracks.flatMap((t) => t.clips);
  const screen = all().find((c) => c.type === "screen")!;
  await core.run(h, "clip.unlink", { clips: [screen.id] });
  // The screen alone: the camera over it moves, and would be what's compared.
  for (const c of all()) if (c.id !== screen.id) await core.run(h, "clip.remove", { clip: c.id }).catch(() => {});
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === screen.id))!.id;
  // Two pieces of it, 1 s apart in the recording, side by side, stitched; then trimmed to end at 3 s.
  const [right] = (await core.run(h, "clip.split", { at: 1, clips: [screen.id], linked: false })).results[0] as string[];
  const [later] = (await core.run(h, "clip.split", { at: 2, clips: [right!], linked: false })).results[0] as string[];
  await core.run(h, "clip.remove", { clip: right!, ripple: true });
  const pieces = core.doc(h).tracks.find((t) => t.id === track)!.clips.map((c) => c.id);
  expect(pieces).toEqual([screen.id, later!]);
  const stitched = (await core.run(h, "clip.stitch", { clips: pieces })).results[0] as string;
  await core.run(h, "clip.trim", { clip: stitched, end: 3 });
  await core.run(h, "timeline.insertSpace", { at: 0, duration: 1 });
  const before = JSON.stringify(core.doc(h).tracks);
  const stitchedClip = all().find((c) => c.id === stitched)!;
  expect(stitchedClip.type).toBe("stitched");

  const end = (await core.run(h, "clip.extendFrame", { clip: stitched, duration: 1 })).results[0] as string;
  const held = all().find((c) => c.id === end)!;
  expect(held).toMatchObject({ type: "still", assetId: screen.assetId });
  // The recording's time of the stitched clip's last frame: 1 s skipped, so 4 s minus a frame, not its inner 3 s.
  expect(seconds(held.mediaStart!)).toBeCloseTo(4 - 1 / 30, 2);
  expect(held.props.media).toEqual(screen.props.media);
  const start = (await core.run(h, "clip.extendFrame", { clip: stitched, duration: 1, edge: "start" })).results[0] as string;
  expect(seconds(all().find((c) => c.id === start)!.mediaStart!)).toBeCloseTo(seconds(screen.mediaStart ?? 0), 3);
  // Drawn as the clip's edge: its last frame, at 3.967 s, and the still after it, at 4.5 s.
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "stitched") }, frames: [119, 135], cacheDir: core.cacheDir });
  // Not to the pixel: the stitched clip is drawn through its own canvas, so resampled once more.
  const [a, b] = await Promise.all([gray(join(dir, "stitched/f000119.png")), gray(join(dir, "stitched/f000135.png"))]);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  expect(sum / a.length).toBeLessThan(0.5);
  await core.undo(h);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 120_000);
