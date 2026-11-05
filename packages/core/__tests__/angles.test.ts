import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { clipEnd, ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const IMAGE = join(FIXTURES, "image.png");
const UHD = join(FIXTURES, "video-2.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-angles-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A test video `w`×`h`, `seconds` long, as a model would make it. */
function footage(name: string, w: number, h: number, seconds = 4) {
  const out = join(dir, name);
  // Beacon's FFmpeg has no lavfi or x264: grey frames getting lighter, through VideoToolbox.
  if (!existsSync(out)) {
    const frames = seconds * 4;
    const raw = new Uint8Array(w * h * frames);
    for (let f = 0; f < frames; f++) raw.fill(40 + f * 10, f * w * h, (f + 1) * w * h);
    Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", "4", "-i", "-", "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", out], { stdin: raw });
  }
  return out;
}

const uploads: { name: string; type: string }[] = [];
const predictions: { model: string; input: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.slice("/replicate".length);
    if (path.startsWith("/files/") && req.method === "GET") return new Response(Bun.file(join(dir, path.slice("/files/".length))));
    if (req.headers.get("authorization") !== "Bearer replicate-token") return Response.json({ detail: "Invalid token" }, { status: 401 });
    if (path === "/files" && req.method === "POST") {
      const file = (await req.formData()).get("content") as File;
      uploads.push({ name: file.name, type: file.type });
      writeFileSync(join(dir, `up-${file.name}`), new Uint8Array(await file.arrayBuffer()));
      return Response.json({ urls: { get: `${url.origin}/replicate/files/up-${file.name}` } });
    }
    const posted = path.match(/^\/models\/([\w.-]+\/[\w.-]+)\/predictions$/);
    if (posted) {
      const { input } = (await req.json()) as { input: Record<string, unknown> };
      predictions.push({ model: posted[1]!, input });
      const id = `pred-${predictions.length}`;
      return Response.json({ id, status: "processing", urls: { get: `${url.origin}/replicate/predictions/${id}` } });
    }
    const m = path.match(/^\/predictions\/pred-(\d+)$/);
    const p = m && predictions[Number(m[1]) - 1];
    if (!p) return new Response("not found", { status: 404 });
    if (String(p.input.prompt ?? "").includes("[e005]")) return Response.json({ id: m![0], status: "failed", error: "E005: The input or output was flagged as sensitive" });
    const out = p.model === "bytedance/video-upscaler" ? footage("1920x1080.mp4", 1920, 1080) : footage("854x480.mp4", 854, 480);
    return Response.json({ id: m![0], status: "succeeded", output: `${url.origin}/replicate/files/${out.split("/").at(-1)}` });
  },
});
process.env.BEACON_REPLICATE_URL = `${server.url.origin}/replicate`;
process.env.BEACON_REPLICATE_POLL_MS = "10";

async function project(name: string, media: string) {
  const secrets = new Map([["replicate-api-token", "replicate-token"]]);
  const core = new LocalCore({ cacheDir: join(dir, `cache-${name}`), configDir: join(dir, `config-${name}`), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
  const h = await core.create({ path: join(dir, `${name}.beproj`) });
  const copy = join(dir, `${name}-${media.split("/").at(-1)}`);
  cpSync(media, copy, { recursive: true });
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  return { core, h };
}

const clipOf = (core: LocalCore, h: string, id: string) => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

test.skipIf(!existsSync(TAKE) || !existsSync(IMAGE))("a camera angle: added over the camera on an Angles track, priced, then generated from the camera and its own sound with the room photos, Seedance then the upscaler, and shown in its clip in one undo step", async () => {
  const { core, h } = await project("gen", TAKE);
  const camera = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  const cameraTrack = core.doc(h).tracks.findIndex((t) => t.clips.includes(camera));
  await core.run(h, "playhead.set", { time: 0.2 });
  await core.run(h, "angles.add", {});
  const angles = core.doc(h).tracks[cameraTrack + 1]!;
  expect(angles.name).toBe("Angles");
  const angle = angles.clips[0]!;
  expect(angle.type).toBe("angle");
  expect((await core.session(h)).selection).toEqual([angle.id]);
  expect((await core.session(h)).inspector).toBe("angle");

  // Seedance's 4 s at its 480p price; no close-up crop from this camera (it is shown bigger than it is).
  expect(await core.query(h, "angle.estimate", { clip: angle.id })).toMatchObject({ seconds: 4, cost: 1.72, crop: false, camera: camera.id });

  // A room photo on the track, a note of the user's own.
  copyFileSync(IMAGE, join(dir, "room.png"));
  const img = await core.import(h, [join(dir, "room.png")]);
  await core.run(h, "angles.room", { track: angles.id, photos: [img.assets[0]] });
  await core.run(h, "clip.set", { clip: angle.id, props: { angle: { view: "three-quarter-right", note: "keep the plant in" } } });

  // Over the limit per generation (shared with B-roll), nothing is sent.
  await core.setPreference("brollLimit", "1");
  await expect(core.run(h, "angle.generate", { clip: angle.id })).rejects.toThrow("over the $1.00 limit per generation");
  await core.setPreference("brollLimit", "0");
  expect(predictions).toHaveLength(0);

  const steps = (await core.history(h)).undo.length;
  const started = await core.run(h, "angle.generate", { clip: angle.id });
  const job = (started.results[0] as { job: string }).job;
  for (let s = "running"; s === "running"; await Bun.sleep(50)) s = (await core.job(job)).state;
  expect((await core.job(job)).error).toBeUndefined();

  expect(uploads.map((u) => u.type.replace("x-wav", "wav")).sort()).toEqual(["audio/wav", "image/png", "video/mp4"]);
  const [seedance, upscale] = predictions;
  expect(seedance!.model).toBe("bytedance/seedance-2.5");
  expect(seedance!.input).toMatchObject({ duration: -1, aspect_ratio: "adaptive", resolution: "480p", generate_audio: false });
  expect((seedance!.input.reference_videos as string[]).length).toBe(1);
  expect((seedance!.input.reference_audios as string[]).length).toBe(1);
  expect((seedance!.input.reference_images as string[]).length).toBe(1);
  const prompt = String(seedance!.input.prompt);
  for (const said of ["35 degrees to the speaker's right", "lips move exactly to [Audio1]", "[Image1] is a photo of this same room", "Also: keep the plant in", "Handheld"]) expect(prompt).toContain(said);
  expect(upscale!.model).toBe("bytedance/video-upscaler");
  expect(upscale!.input).toMatchObject({ scene: "aigc", target_resolution: "1080p", processing_type: "standard", video: expect.stringContaining("854x480.mp4") });

  const made = clipOf(core, h, angle.id);
  expect(made.assetId).toBeDefined();
  expect((made.props.angle as { takes: unknown[] }).takes).toHaveLength(1);
  expect(made.mediaStart).toBe(0);
  const asset = core.doc(h).assets[made.assetId!]!;
  expect(asset.path).toContain("/media/Angles/");
  expect(asset.derived.angle).toMatchObject({ view: "three-quarter-right", cost: 1.72, seconds: 4 });
  expect(readdirSync(join(dir, "gen.beproj", "media", "Angles")).sort()).toEqual(["Three-quarter, right.json", "Three-quarter, right.mp4"]);
  // Shown where the camera is: 1920 wide footage at the camera's scale for its width.
  const camWidth = (core.doc(h).assets[camera.assetId!]!.derived.media as { streams: { kind: string; width?: number }[] }).streams.filter((x) => x.kind === "video")[(camera.props.media as { stream?: number } | undefined)?.stream ?? 0]!.width!;
  expect((made.props.transform as { scaleX: number }).scaleX).toBeCloseTo(((camera.props.transform as { scaleX: number }).scaleX * camWidth) / 1920, 4);
  expect((await core.history(h)).undo.length).toBe(steps + 1);

  // Settings › AI's Upscaled to: 4K asks the upscaler for 4k. The interview's second camera, three-quarter on.
  await core.setPreference("angleResolution", "4k");
  await core.run(h, "clip.set", { clip: angle.id, props: { angle: { view: "three-quarter-left" } } });
  const again = ((await core.run(h, "angle.generate", { clip: angle.id })).results[0] as { job: string }).job;
  for (let s = "running"; s === "running"; await Bun.sleep(50)) s = (await core.job(again)).state;
  expect(predictions.at(-1)!.input).toMatchObject({ target_resolution: "4k" });
  expect(String(predictions.at(-2)!.input.prompt)).toContain("a second interview camera 35 degrees to the speaker's left");
  await core.setPreference("angleResolution", "1080p");
  await core.close(h);
}, 120_000);

test.skipIf(!existsSync(TAKE))("Seedance refusing a take says so plainly, offering another stretch or a crop", async () => {
  const { core, h } = await project("refuse", TAKE);
  await core.run(h, "playhead.set", { time: 0.2 });
  await core.run(h, "angles.add", {});
  const angle = (await core.session(h)).selection[0]!;
  await core.run(h, "clip.set", { clip: angle, props: { angle: { note: "[e005]" } } });
  const started = await core.run(h, "angle.generate", { clip: angle });
  const job = (started.results[0] as { job: string }).job;
  for (let s = "running"; s === "running"; await Bun.sleep(50)) s = (await core.job(job)).state;
  expect((await core.session(h)).features.angles).toMatchObject({ making: [], errors: { [angle]: expect.stringContaining("Seedance declined this take") } });
  expect(clipOf(core, h, angle).assetId).toBeUndefined();
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(UHD))("a close-up from a 4K camera in a 1080p project is a crop of its own frames: free, nothing sent, in step with the camera", async () => {
  const { core, h } = await project("crop", UHD);
  const sent = predictions.length;
  const camera = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  await core.run(h, "playhead.set", { time: 2 });
  await core.run(h, "angles.add", {});
  const angle = (await core.session(h)).selection[0]!;
  expect(await core.query(h, "angle.estimate", { clip: angle })).toMatchObject({ crop: true });
  const before = Buffer.from((await core.frame(h, 2.5, { width: 320 })).png).toString("base64");
  await core.run(h, "angle.crop", { clip: angle });
  const c = clipOf(core, h, angle);
  expect(c.assetId).toBe(camera.assetId);
  expect(c.mediaStart).toBe(camera.start === 0 ? Math.round(2 * 705_600_000) : c.mediaStart);
  expect((c.props.angle as { view: string; crop: boolean })).toMatchObject({ view: "closeup", crop: true });
  expect((c.props.transform as { scaleX: number }).scaleX).toBeCloseTo((camera.props.transform as { scaleX: number }).scaleX * 1.6, 4);
  expect(Buffer.from((await core.frame(h, 2.5, { width: 320 })).png).toString("base64")).not.toBe(before);
  expect(predictions.length).toBe(sent);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(TAKE))("New Angle Here on a camera clip makes the angle of that clip: at the playhead when it is on the clip, else from the clip's start; never of a non-camera clip", async () => {
  const { core, h } = await project("here", TAKE);
  const camera = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "video")!;
  const start = ticksToSeconds(camera.start);
  const end = ticksToSeconds(clipEnd(camera));
  const angleOf = async () => clipOf(core, h, (await core.session(h)).selection[0]!);
  await core.run(h, "playhead.set", { time: start + 1 });
  await core.run(h, "angles.add", { camera: camera.id });
  let a = await angleOf();
  expect(a.type).toBe("angle");
  expect(ticksToSeconds(a.start)).toBeCloseTo(start + 1, 1);
  expect(ticksToSeconds(a.duration)).toBeCloseTo(Math.min(3, end - start - 1), 1);
  await core.run(h, "playhead.set", { time: end + 5 });
  await core.run(h, "angles.add", { camera: camera.id });
  a = await angleOf();
  expect(ticksToSeconds(a.start)).toBeCloseTo(start, 1);
  const other = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type !== "video" && c.type !== "angle")!;
  await expect(core.run(h, "angles.add", { camera: other.id })).rejects.toThrow("New Angle Here is for a camera clip");
  await core.close(h);
}, 60_000);
