import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds, type Asset } from "@beacon/model";
import type { BrollReview } from "@beacon/features";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-broll-"));

/** Test footage as Replicate would send it: 8 s, silent, in each shape. */
const footage = (w: number, h: number) => {
  const out = join(dir, `${w}x${h}.mp4`);
  // Beacon's FFmpeg has no lavfi or x264: grey frames getting lighter, through VideoToolbox.
  if (!existsSync(out)) {
    const frames = 8 * 4;
    const raw = new Uint8Array(w * h * frames);
    for (let f = 0; f < frames; f++) raw.fill(40 + f * 6, f * w * h, (f + 1) * w * h);
    Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", "4", "-i", "-", "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", out], { stdin: raw });
  }
  return out;
};

/**
 * OpenAI's Responses API and Replicate, standing in for the real ones (which charge). The planner answers with
 * shots that overlap and run long, as a model can, for Beacon to tile; Replicate makes footage in the shape asked,
 * a prompt saying "[hold]" stays processing until cancelled, and one saying "[refuse]" fails.
 */
const plans: Record<string, unknown>[] = [];
const predictions: Record<string, unknown>[] = [];
const cancelled: string[] = [];
const state = new Map<string, { input: Record<string, unknown>; polls: number }>();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = req.headers.get("authorization");
    if (url.pathname === "/openai/responses") {
      if (key !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      const body = (await req.json()) as Record<string, unknown>;
      plans.push(body);
      const asked = JSON.stringify(body.input);
      // "[late]": answered after the test has moved on; "[nested]": a shot inside another, as a model can write.
      if (asked.includes("[late]")) await Bun.sleep(300);
      const shots = asked.includes("[nested]")
        ? [
            { start: 0, end: 8, prompt: "A wide shot", why: "a" },
            { start: 2, end: 4, prompt: "Inside the first", why: "b" },
            { start: 3, end: 12, prompt: "The rest", why: "c" },
          ]
        : [
            { start: 0.5, end: 5, prompt: "A city skyline at dusk, slow aerial push-in", why: "the city" },
            { start: 4.8, end: 16, prompt: "Hands typing on a laptop, shallow focus", why: "the work" },
          ];
      return Response.json({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ research: "Found: the city", shots }) }] }] });
    }
    if (!url.pathname.startsWith("/replicate/")) return new Response("not found", { status: 404 });
    const path = url.pathname.slice("/replicate".length);
    if (path.startsWith("/files/")) return new Response(Bun.file(join(dir, path.slice("/files/".length))));
    if (key !== "Bearer replicate-token") return Response.json({ detail: "Invalid token" }, { status: 401 });
    if (path === "/models/google/veo-3.1-fast")
      return Response.json({
        latest_version: {
          openapi_schema: {
            components: {
              schemas: {
                Input: { properties: { prompt: { type: "string" }, aspect_ratio: { allOf: [{ $ref: "#/components/schemas/aspect_ratio" }] }, duration: { allOf: [{ $ref: "#/components/schemas/duration" }] }, resolution: { type: "string" }, generate_audio: { type: "boolean" }, seed: { type: "integer" } } },
                aspect_ratio: { enum: ["16:9", "9:16"] },
                duration: { enum: [4, 6, 8] },
              },
            },
          },
        },
      });
    if (path === "/models/google/veo-3.1-fast/predictions") {
      const { input } = (await req.json()) as { input: Record<string, unknown> };
      predictions.push(input);
      const id = `pred-${predictions.length}`;
      state.set(id, { input, polls: 0 });
      return Response.json({ id, status: "starting", urls: { get: `${url.origin}/replicate/predictions/${id}`, cancel: `${url.origin}/replicate/predictions/${id}/cancel` } });
    }
    const m = path.match(/^\/predictions\/(pred-\d+)(\/cancel)?$/);
    const p = m && state.get(m[1]!);
    if (!p) return new Response("not found", { status: 404 });
    if (m![2]) {
      cancelled.push(m![1]!);
      return Response.json({ id: m![1], status: "canceled" });
    }
    const prompt = String(p.input.prompt);
    if (prompt.includes("[hold]") || p.polls++ < 1) return Response.json({ id: m![1], status: "processing" });
    if (prompt.includes("[refuse]")) return Response.json({ id: m![1], status: "failed", error: "the model refused the prompt" });
    const [w, h] = p.input.aspect_ratio === "9:16" ? [360, 640] : [640, 360];
    footage(w, h);
    return Response.json({ id: m![1], status: "succeeded", output: `${url.origin}/replicate/files/${w}x${h}.mp4` });
  },
});
process.env.BEACON_OPENAI_URL = `${server.url.origin}/openai`;
process.env.BEACON_REPLICATE_URL = `${server.url.origin}/replicate`;
process.env.BEACON_REPLICATE_POLL_MS = "10";
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** What the transcript job would have made for `asset`, written where the cache keeps it: a word every half second. */
function transcribed(core: LocalCore, asset: Asset) {
  const def = core.registry.jobAnalyzers.get("transcript")!;
  const file = new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, def);
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  const words = Array.from({ length: 60 }, (_, i) => ({ text: i % 8 === 7 ? "city." : "word", start: i * 0.5, end: i * 0.5 + 0.4, p: 1 }));
  writeFileSync(file, JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: [[0, 30]] } } }));
}

async function waitJob(core: LocalCore, id: string) {
  for (;;) {
    const j = await core.job(id);
    if (j.state === "done") return j.result;
    if (j.state === "failed") throw new Error(j.error);
    await Bun.sleep(20);
  }
}

const jobOf = (r: { results: unknown[] }) => (r.results.at(-1) as { job: string }).job;

test.skipIf(!existsSync(AUDIO))("B-roll: planned from the range's words with research, generated through Replicate in the region's shape, kept in media/B-roll, placed over the shots in a region in one undo step that undoes exactly", async () => {
  const secrets = new Map<string, string>();
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const audio = join(dir, "talk.m4a");
  copyFileSync(AUDIO, audio);
  const imported = await core.import(h, [audio], { at: 0 });
  for (const j of imported.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, Object.values(core.doc(h).assets)[0]!);
  const review = async () => (await core.session(h)).features.broll as BrollReview | undefined;
  // The canvas, as the app's window shows it, two seconds in: the talk alone has no picture.
  const view = core.attachView(h, { offscreen: { width: 480, height: 270 } }, { silent: true, proxies: false });
  const canvas = () => {
    view.show(2);
    view.settle();
    return Buffer.from(view.flush()!);
  };
  const plain = canvas();

  await expect(core.run(h, "broll.review", {})).rejects.toThrow(/drag a range on the ruler/);
  await core.run(h, "range.set", { in: 1, out: 13 });
  await core.run(h, "broll.review", { guide: "keep it abstract" });
  expect(await review()).toMatchObject({ from: 1, to: 13, guide: "keep it abstract", research: true, region: null, shots: [] });

  // No OpenAI key: the job fails, and the review says why rather than planning forever.
  await expect(waitJob(core, jobOf(await core.run(h, "broll.plan", {})))).rejects.toThrow(/no OpenAI API key: add one in Settings › Transcripts/);
  expect((await review())!.planning).toBeUndefined();
  expect((await review())!.error).toMatch(/no OpenAI API key/);

  secrets.set("openai-api-key", "openai-key");
  // The top half of the canvas, as for a Short's B-roll above the face: taller than wide, so 9:16.
  const { width, height } = core.doc(h).settings;
  const region: [number, number, number, number] = [width / 4, 0, width / 2, height];
  await waitJob(core, jobOf(await core.run(h, "broll.plan", { region })));
  const sent = plans.at(-1)!;
  expect(sent).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" }, tools: [{ type: "web_search" }] });
  expect(JSON.stringify(sent.input)).toContain("keep it abstract");
  expect(JSON.stringify(sent.input)).toContain("9:16");
  // Tiled: from the range's start to its end, back to back, none over Veo's 8 s.
  const planned = (await review())!;
  expect(planned.notes).toBe("Found: the city");
  expect(planned.planning).toBeUndefined();
  expect(planned.shots[0]!.start).toBe(1);
  expect(planned.shots.at(-1)!.end).toBe(13);
  for (const [i, s] of planned.shots.entries()) {
    if (i) expect(s.start).toBe(planned.shots[i - 1]!.end);
    expect(s.end - s.start).toBeLessThanOrEqual(8);
  }
  const estimate = (await core.query(h, "broll.estimate", {})) as { total: number; model: string };
  expect(estimate.model).toBe("Veo 3.1 Fast");
  expect(estimate.total).toBeGreaterThan(0);

  // Over the limit set in Settings › AI, nothing is sent.
  await core.setPreference("brollLimit", String(estimate.total / 2));
  await expect(core.run(h, "broll.generate", {})).rejects.toThrow(/over the \$[\d.]+ limit per generation/);
  await core.setPreference("brollLimit", "0");

  await expect(waitJob(core, jobOf(await core.run(h, "broll.generate", {})))).rejects.toThrow(/no Replicate API token: add one in Settings › AI/);
  expect((await review())!.shots.every((s) => !s.making && /Replicate API token/.test(s.error ?? ""))).toBe(true);
  secrets.set("replicate-api-token", "replicate-token");

  const steps = (await core.history(h)).undo.length;
  await waitJob(core, jobOf(await core.run(h, "broll.generate", {})));
  // Silent, in the region's shape, each shot at the shortest length that covers it, only fields the model has.
  for (const input of predictions) {
    expect(input).toMatchObject({ aspect_ratio: "9:16", generate_audio: false, resolution: "1080p" });
    expect([4, 6, 8]).toContain(input.duration as number);
    expect(Object.keys(input).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "prompt", "resolution"]);
  }
  const made = (await review())!;
  expect(made.shots.every((s) => s.candidate && !s.making && !s.error)).toBe(true);
  // Kept with the project as they arrive, each with what made it; nothing in the document or its history yet.
  const folder = join(dir, "p.beproj", "media", "B-roll");
  const files = readdirSync(folder);
  expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(made.shots.length);
  const sidecar = JSON.parse(readFileSync(join(folder, files.find((f) => f.endsWith(".json"))!), "utf8"));
  expect(sidecar).toMatchObject({ model: "google/veo-3.1-fast", aspect: "9:16", resolution: "1080p" });
  expect((await core.history(h)).undo.length).toBe(steps);
  expect(Object.keys(core.doc(h).assets)).toHaveLength(1);

  // A shot made again with a new prompt; one Replicate can't make keeps what it had and says why.
  const first = made.shots[0]!;
  await core.run(h, "broll.shot", { shot: first.id, prompt: "[refuse] a street" });
  await expect(waitJob(core, jobOf(await core.run(h, "broll.generate", { shots: [first.id] })))).rejects.toThrow(/the model refused the prompt/);
  const kept = (await review())!.shots[0]!;
  expect(kept.candidate?.path).toBe(first.candidate!.path);
  expect(kept.error).toMatch(/the model refused the prompt/);

  // Shown in place on the canvas while the review is open, without being in the document; unticked, it goes.
  const previewed = canvas();
  expect(previewed.equals(plain)).toBe(false);
  expect((await core.history(h)).undo.length).toBe(steps);
  for (const s of made.shots) await core.run(h, "broll.shot", { shot: s.id, use: false });
  expect(canvas().equals(plain)).toBe(true);
  for (const s of made.shots) await core.run(h, "broll.shot", { shot: s.id, use: true });
  expect(canvas().equals(previewed)).toBe(true);

  const before = core.doc(h);
  await core.run(h, "broll.apply", {});
  const history = (await core.history(h)).undo;
  expect(history.length - steps).toBe(1);
  expect(history.at(-1)).toBe("Add B-roll");
  expect(await review()).toBeUndefined();
  const doc = core.doc(h);
  const talk = doc.tracks.findIndex((t) => t.clips.some((c) => c.assetId === Object.keys(before.assets)[0]));
  const track = doc.tracks[talk + 1]!;
  expect(track.name).toBe("B-roll");
  expect(track.clips.map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)])).toEqual(made.shots.map((s) => [s.start, s.end]));
  // Covering the region, centred in it, cropped to it: 360×640 footage into a 960×1080 box (on a 1920×1080 canvas).
  for (const c of track.clips) {
    const t = c.props.transform as { x: number; y: number; scaleX: number };
    const crop = c.props.crop as { left: number; right: number; top: number; bottom: number };
    const k = Math.max(region[2] / 360, region[3] / 640);
    expect(t.scaleX).toBeCloseTo(k);
    expect(t.x).toBeCloseTo(region[0] + region[2] / 2 - width / 2);
    expect((360 - crop.left - crop.right) * k).toBeCloseTo(region[2]);
    expect((640 - crop.top - crop.bottom) * k).toBeCloseTo(region[3]);
    expect(doc.assets[c.assetId!]!.derived.broll).toMatchObject({ model: "Veo 3.1 Fast" });
  }
  // Applied, the canvas is what the preview showed; undone, as it was.
  expect(canvas().equals(previewed)).toBe(true);
  await core.undo(h);
  expect(core.doc(h)).toEqual(before);
  expect(canvas().equals(plain)).toBe(true);
  core.detachView(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("B-roll: a generation cancelled is cancelled on Replicate too, and the shot is no longer shown as being made", async () => {
  const secrets = new Map([["openai-api-key", "openai-key"], ["replicate-api-token", "replicate-token"]]);
  const core = new LocalCore({ cacheDir: join(dir, "cache-2"), configDir: join(dir, "config-2"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
  const h = await core.create({ path: join(dir, "cancel.beproj") });
  const audio = join(dir, "talk-2.m4a");
  copyFileSync(AUDIO, audio);
  const imported = await core.import(h, [audio], { at: 0 });
  for (const j of imported.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, Object.values(core.doc(h).assets)[0]!);
  // A plan answered after its review's range changed is dropped; the review isn't left planning.
  await core.run(h, "range.set", { in: 0, out: 12 });
  const late = jobOf(await core.run(h, "broll.plan", { guide: "[late]" }));
  await core.run(h, "broll.review", { from: 1, to: 9 });
  await waitJob(core, late);
  expect((await core.session(h)).features.broll).toMatchObject({ from: 1, to: 9, shots: [] });
  expect(((await core.session(h)).features.broll as BrollReview).planning).toBeUndefined();
  // A shot planned inside another is dropped, not overlapped (it would be paid for twice).
  await waitJob(core, jobOf(await core.run(h, "broll.plan", { from: 0, to: 12, guide: "[nested]" })));
  expect(((await core.session(h)).features.broll as BrollReview).shots.map((s) => [s.start, s.end])).toEqual([
    [0, 8],
    [8, 12],
  ]);
  await core.run(h, "broll.close", {});
  await core.run(h, "range.set", { in: 0, out: 4 });
  await waitJob(core, jobOf(await core.run(h, "broll.plan", { research: false, guide: "" })));
  expect(plans.at(-1)!.tools).toBeUndefined();
  const shot = ((await core.session(h)).features.broll as BrollReview).shots[0]!;
  await core.run(h, "broll.shot", { shot: shot.id, prompt: "[hold] a pan" });
  const job = jobOf(await core.run(h, "broll.generate", {}));
  for (let i = 0; i < 100 && !predictions.some((p) => p.prompt === "[hold] a pan"); i++) await Bun.sleep(20);
  await core.cancelJob(job);
  await expect(waitJob(core, job)).rejects.toThrow(/cancelled/);
  for (let i = 0; i < 100 && !cancelled.length; i++) await Bun.sleep(20);
  expect(cancelled.length).toBeGreaterThan(0);
  const after = ((await core.session(h)).features.broll as BrollReview).shots[0]!;
  expect(after).toMatchObject({ making: false });
  expect(after.error).toBeUndefined();
  expect(readdirSync(join(dir, "cancel.beproj", "media", "B-roll")).filter((f) => f.endsWith(".mp4"))).toEqual([]);
}, 60_000);
