import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds, type Asset, type Clip } from "@beacon/model";
import { regionOfClip, type BrollProps, type BrollState } from "@beacon/features";
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
    // With sound, as a model whose schema has no audio switch sends it: Beacon must take it off.
    Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", "4", "-i", "-", "-i", AUDIO, "-map", "0:v", "-map", "1:a", "-t", "8", "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-c:a", "aac", out], { stdin: raw });
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
      // "[silent]": nothing comes back.
      if (asked.includes("[silent]")) return new Promise<Response>(() => {});
      // "[stream]": answered as OpenAI streams, event by event, slowly enough for each stage to be seen.
      if (asked.includes("[stream]")) {
        const events = [
          { type: "response.created" },
          { type: "response.reasoning_summary_text.delta" },
          { type: "response.web_search_call.in_progress" },
          { type: "response.web_search_call.completed" },
          { type: "response.output_text.delta", delta: "{" },
          { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ research: "", shots: [{ start: 0, end: 100, prompt: "Streamed", why: "s" }] }) }] }] } },
        ];
        const body = new ReadableStream({
          async start(c) {
            for (const e of events) {
              c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
              await Bun.sleep(150);
            }
            c.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      // "[late]": answered after the test has moved on; "[nested]": a shot inside another, as a model can write.
      if (asked.includes("[late]")) await Bun.sleep(300);
      const shots = asked.includes("[frames]")
        ? [
            { start: 0, end: 4.02, prompt: "One", why: "a" },
            { start: 4.02, end: 8.04, prompt: "Two", why: "b" },
            { start: 8.04, end: 12.1, prompt: "Three", why: "c" },
          ]
        : asked.includes("[long]")
        ? [{ start: 0, end: 12, prompt: "One long shot", why: "all" }]
        : asked.includes("[nested]")
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
    // FLUX 3 as its page describes it: its length a string, "auto" or "5"-"20", any shape or "auto".
    if (path === "/models/black-forest-labs/flux-3")
      return Response.json({
        latest_version: {
          openapi_schema: {
            components: {
              schemas: {
                Input: { properties: { prompt: { type: "string" }, aspect_ratio: { allOf: [{ $ref: "#/components/schemas/aspect_ratio" }] }, duration: { type: "string", allOf: [{ $ref: "#/components/schemas/duration" }] }, resolution: { type: "string" }, generate_audio: { type: "boolean" }, draft: { type: "boolean" } } },
                aspect_ratio: { enum: ["auto", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"] },
                duration: { enum: ["auto", ...Array.from({ length: 16 }, (_, i) => String(i + 5))] },
              },
            },
          },
        },
      });
    // The other models: no schema read, so the table's.
    if (/^\/models\/[\w.-]+\/[\w.-]+$/.test(path)) return Response.json({});
    const posted = path.match(/^\/models\/([\w.-]+\/[\w.-]+)\/predictions$/);
    if (posted) {
      const { input } = (await req.json()) as { input: Record<string, unknown> };
      predictions.push({ ...input, model: posted[1] });
      // "[late-start]": started, but answered after the job is cancelled.
      if (String(input.prompt).includes("[late-start]")) await Bun.sleep(400);
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
    // "[steps]": slow enough at each stage to be seen; "[flaky]": the first two checks fail, as a busy server's can.
    if (prompt.includes("[steps]")) await Bun.sleep(120);
    if (prompt.includes("[flaky]") && p.polls < 2) {
      p.polls++;
      return new Response("busy", { status: 503 });
    }
    if (prompt.includes("[hold]") || p.polls++ < (prompt.includes("[steps]") ? 3 : 1)) return Response.json({ id: m![1], status: p.polls === 1 && prompt.includes("[steps]") ? "starting" : "processing" });
    if (prompt.includes("[refuse]")) return Response.json({ id: m![1], status: "failed", error: "the model refused the prompt" });
    const [w, h] = p.input.aspect_ratio === "9:16" ? [360, 640] : [640, 360];
    footage(w, h);
    return Response.json({ id: m![1], status: "succeeded", output: `${url.origin}/replicate/files/${w}x${h}.mp4` });
  },
});
process.env.BEACON_OPENAI_URL = `${server.url.origin}/openai`;
process.env.BEACON_REPLICATE_URL = `${server.url.origin}/replicate`;
process.env.BEACON_REPLICATE_POLL_MS = "10";
// Apple's on-device model, standing in for beacon-writer: keeps each request to read, writes one scene; "[apple-off]"
// answers as a Mac with Apple Intelligence off does.
const writer = join(dir, "beacon-writer");
writeFileSync(writer, `#!/bin/sh\ncp "$1" "${join(dir, "last-request.json")}"\nif grep -q "apple-off" "$1"; then echo "Apple Intelligence is off: turn it on in System Settings" >&2; exit 2; fi\necho '{"prompt":"An on-device scene","why":"device"}'\n`, { mode: 0o755 });
process.env.BEACON_WRITER = writer;
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


/** A project with the fixture's talk, transcribed (a word every half second), and keys as given. */
async function talk(name: string, keys: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(keys));
  const core = new LocalCore({ cacheDir: join(dir, `cache-${name}`), configDir: join(dir, `config-${name}`), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const h = await core.create({ path: join(dir, `${name}.beproj`) });
  const audio = join(dir, `${name}.m4a`);
  copyFileSync(AUDIO, audio);
  const imported = await core.import(h, [audio], { at: 0 });
  for (const j of imported.jobs) await core.cancelJob(j).catch(() => {});
  transcribed(core, Object.values(core.doc(h).assets)[0]!);
  const brolls = () => core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "broll");
  const state = async () => (await core.session(h)).features.broll as BrollState | undefined;
  return { core, h, secrets, brolls, state };
}

const props = (c: Clip) => c.props.broll as BrollProps;

/** Gives a clip a style of the user's own whose wording is `text`: the planner's guide, so the stand-in reads it. */
async function styled(core: LocalCore, h: string, clip: string, text: string) {
  await core.setPreference("brollStyles", JSON.stringify([{ id: "s1", name: "Test", text }]));
  await core.run(h, "clip.set", { clip, props: { broll: { style: "s1" } } });
}

test.skipIf(!existsSync(AUDIO))("B-roll is a clip: added over the range in a region, planned from the words under it (split into shots), its footage made through Replicate and shown in it in place, every take kept to pick again; an empty one shows nothing; all undoes exactly", async () => {
  const { core, h, secrets, brolls, state } = await talk("main");
  // The canvas, as the app's window shows it, two seconds in: the talk alone has no picture.
  const view = core.attachView(h, { offscreen: { width: 480, height: 270 } }, { silent: true, proxies: false });
  const canvas = () => {
    view.show(2);
    view.settle();
    return Buffer.from(view.flush()!);
  };
  const plain = canvas();
  const start = core.doc(h);
  const steps = (await core.history(h)).undo.length;

  // Over the range, in the canvas's middle half (taller than wide, so Veo makes it 9:16), above the talk.
  const { width, height } = start.settings;
  const region: [number, number, number, number] = [width / 4, 0, width / 2, height];
  await core.run(h, "range.set", { in: 1, out: 13 });
  await core.run(h, "broll.add", { region });
  const [clip] = brolls();
  expect(clip).toBeDefined();
  expect([ticksToSeconds(clip!.start), ticksToSeconds(clip!.start + clip!.duration)]).toEqual([1, 13]);
  const doc = core.doc(h);
  const row = (id: string) => doc.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
  expect(doc.tracks[row(clip!.id)]!.name).toBe("B-roll");
  expect(row(clip!.id)).toBe(row(doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "audio")!.id) + 1);
  expect(regionOfClip(clip!, doc, core.registry)).toEqual(region);
  expect((await core.session(h)).selection).toEqual([clip!.id]);
  expect((await core.session(h)).range).toBeNull();
  expect((await core.history(h)).undo.at(-1)).toBe("Add B-roll");
  // Empty, it draws nothing: an export shows nothing there.
  expect(canvas().equals(plain)).toBe(true);

  // Planned on this Mac by default: Beacon cuts the 12 s into two shots of Veo's length at a pause, and Apple's
  // model writes each one's scene in the clip's style, with no key.
  await styled(core, h, clip!.id, "keep it abstract");
  await waitJob(core, jobOf(await core.run(h, "broll.plan", {})));
  expect(brolls().map((c) => props(c).prompt)).toEqual(["An on-device scene", "An on-device scene"]);
  // Cut at the pause nearest the middle: two shots of about 6 s, together the 12.
  const halves = brolls().map((c) => ticksToSeconds(c.duration));
  expect(halves.every((d) => Math.abs(d - 6) < 0.5)).toBe(true);
  expect(halves[0]! + halves[1]!).toBeCloseTo(12);
  expect(readFileSync(join(dir, "last-request.json"), "utf8")).toContain("keep it abstract");
  await core.undo(h);
  // Apple Intelligence off: the clip says so, and what to do.
  await styled(core, h, clip!.id, "[apple-off]");
  await expect(waitJob(core, jobOf(await core.run(h, "broll.plan", {})))).rejects.toThrow(/Apple Intelligence is off/);
  expect((await state())!.planning).toEqual([]);
  expect((await state())!.errors[clip!.id]).toMatch(/Apple Intelligence is off/);
  await styled(core, h, clip!.id, "keep it abstract");

  // OpenAI as the planner: it needs its key first.
  await expect(core.setPreference("brollPlanner", "openai")).rejects.toThrow(/needs the OpenAI API key/);
  secrets.set("openai-api-key", "openai-key");
  await core.setPreference("brollPlanner", "openai");
  await waitJob(core, jobOf(await core.run(h, "broll.plan", {})));
  const sent = plans.at(-1)!;
  expect(sent).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" }, tools: [{ type: "web_search" }] });
  expect(JSON.stringify(sent.input)).toContain("keep it abstract");
  expect(JSON.stringify(sent.input)).toContain("9:16");
  // 12 s is longer than Veo's 8: split into shots back to back over the same span, in the same region, one undo step.
  const shots = brolls();
  expect(shots.map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)])).toEqual([
    [1, 5],
    [5, 13],
  ]);
  expect(shots.map((c) => props(c).prompt)).toEqual(["A city skyline at dusk, slow aerial push-in", "Hands typing on a laptop, shallow focus"]);
  for (const c of shots) expect(regionOfClip(c, core.doc(h), core.registry)).toEqual(region);
  expect((await core.history(h)).undo.at(-1)).toBe("Plan B-roll");
  expect((await state())!.errors[clip!.id]).toBeUndefined();
  const estimate = (await core.query(h, "broll.estimate", { clips: shots.map((c) => c.id) })) as { total: number; model: string };
  expect(estimate.model).toBe("Veo 3.1 Fast");
  expect(estimate.total).toBeCloseTo(0.15 * (4 + 8));

  // Over the limit set in Settings › AI, nothing is sent.
  await core.setPreference("brollLimit", String(estimate.total / 2));
  await expect(core.run(h, "broll.generate", { clips: shots.map((c) => c.id) })).rejects.toThrow(/over the \$[\d.]+ limit per generation/);
  await core.setPreference("brollLimit", "0");
  await expect(waitJob(core, jobOf(await core.run(h, "broll.generate", { clips: shots.map((c) => c.id) })))).rejects.toThrow(/no Replicate API token: add one in Settings › AI/);
  expect((await state())!.making).toEqual([]);
  secrets.set("replicate-api-token", "replicate-token");

  // A zoom on the placeholder (scale 1 → 1.2 in its box's pixels) still zooms by 1.2 once it shows footage.
  await core.run(h, "animation.add", { clip: shots[0]!.id, end: 4, duration: 2, to: { "transform.scaleX": 1.2, "transform.scaleY": 1.2 } });
  const asked = predictions.length;
  await waitJob(core, jobOf(await core.run(h, "broll.generate", { clips: shots.map((c) => c.id) })));
  const zoomed = brolls()[0]!;
  const base = (zoomed.props.transform as { scaleX: number }).scaleX;
  expect(zoomed.animations[0]!.to["transform.scaleX"]).toBeCloseTo(base * 1.2);
  // Silent, in the region's shape, each at the shortest length that covers it, only fields the model has.
  for (const input of predictions.slice(asked)) {
    expect(input).toMatchObject({ model: "google/veo-3.1-fast", aspect_ratio: "9:16", generate_audio: false, resolution: "1080p" });
    expect(Object.keys(input).sort()).toEqual(["aspect_ratio", "duration", "generate_audio", "model", "prompt", "resolution"]);
  }
  expect(predictions.slice(asked).map((p) => p.duration).sort()).toEqual([4, 8]);
  expect((await core.history(h)).undo.at(-1)).toBe("Generate B-roll");
  // In each clip, in place: its region kept, the footage silent, the take in the Media Bin with what made it.
  const made = brolls();
  for (const c of made) {
    expect(c.assetId).toBeDefined();
    expect(props(c).takes).toEqual([{ assetId: c.assetId! }]);
    expect(c.props.brollBox).toBeUndefined();
    const [x, y, w, h2] = regionOfClip(c, core.doc(h), core.registry);
    expect([x, y, w, h2].map((v, i) => Math.abs(v - region[i]!) < 0.5)).toEqual([true, true, true, true]);
    const a = core.doc(h).assets[c.assetId!]!;
    expect((a.derived.media as { streams: { kind: string }[] }).streams.map((s) => s.kind)).toEqual(["video"]);
    expect(a.derived.broll).toMatchObject({ model: "Veo 3.1 Fast", prompt: props(c).prompt });
  }
  const folder = join(dir, "main.beproj", "media", "B-roll");
  expect(readdirSync(folder).filter((f) => f.endsWith(".mp4"))).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(folder, readdirSync(folder).find((f) => f.endsWith(".json"))!), "utf8"))).toMatchObject({ slug: "google/veo-3.1-fast", resolution: "1080p" });
  const shown = canvas();
  expect(shown.equals(plain)).toBe(false);

  // One clip with every model that can make it, side by side: each take on the clip, the last shown, any picked again.
  const second = made[1]!;
  const before = predictions.length;
  await waitJob(core, jobOf(await core.run(h, "broll.compare", { clip: second.id })));
  const compared = predictions.slice(before);
  expect(compared.map((p) => p.model).sort()).toEqual(["black-forest-labs/flux-3", "bytedance/seedance-2.0", "bytedance/seedance-2.5", "google/veo-3.1-fast", "kwaivgi/kling-v3-video"]);
  // FLUX 3: its length a string; 1:1 nearer the 960×1080 region than 9:16, so less is cropped.
  expect(compared.find((p) => p.model === "black-forest-labs/flux-3")).toMatchObject({ duration: "8", aspect_ratio: "1:1", draft: false, generate_audio: false });
  const takes = props(brolls()[1]!).takes;
  expect(takes).toHaveLength(6);
  const flux = takes.map((t) => t.assetId).find((id) => (core.doc(h).assets[id]!.derived.broll as { model: string }).model === "FLUX 3")!;
  await core.run(h, "broll.use", { clip: second.id, asset: flux });
  const picked = brolls()[1]!;
  expect(picked.assetId).toBe(flux);
  expect(regionOfClip(picked, core.doc(h), core.registry).map((v, i) => Math.abs(v - region[i]!) < 0.5)).toEqual([true, true, true, true]);
  await core.run(h, "broll.use", { clip: second.id, asset: second.assetId! });

  // Planned again with footage: one shot, a new prompt; the footage stays (its box went with it, so no split).
  await waitJob(core, jobOf(await core.run(h, "broll.plan", { clip: second.id })));
  expect(brolls()).toHaveLength(2);
  expect(brolls()[1]!.assetId).toBe(second.assetId);
  // The stand-in's first shot ends where this clip starts: the second's prompt is the one under it.
  expect(props(brolls()[1]!).prompt).toBe("Hands typing on a laptop, shallow focus");
  // Sped up, then given footage: back to normal speed, or 8 s of footage would run out halfway.
  await core.run(h, "clip.speed", { clips: [second.id], speed: 2 });
  expect(brolls()[1]!.speed).toBeDefined();
  await core.run(h, "broll.use", { clip: second.id, asset: flux });
  expect(brolls()[1]!.speed).toBeUndefined();

  // Copied into another project, the clip brings every take: each pasted, each pointing at an asset there.
  const other = await core.create({ path: join(dir, "other.beproj") });
  await core.run(h, "clipboard.copy", { clips: [second.id] });
  await core.run(other, "edit.paste", {});
  const pasted = core.doc(other).tracks.flatMap((t) => t.clips).find((c) => c.type === "broll")!;
  expect(props(pasted).takes).toHaveLength(6);
  for (const t of props(pasted).takes) expect(core.doc(other).assets[t.assetId]).toBeDefined();
  expect(props(pasted).takes.some((t) => t.assetId === pasted.assetId)).toBe(true);
  await core.close(other);

  // Grouped and opened, it is still B-roll to price and make.
  const group = (await core.run(h, "clip.group", { clips: [second.id] })).results[0] as string;
  await core.run(h, "group.open", { clip: group });
  const priced = (await core.query(h, "broll.estimate", { clips: [second.id] })) as { clips: unknown[] };
  expect(priced.clips).toHaveLength(1);
  await expect(core.run(h, "broll.add", {})).rejects.toThrow(/close the group/);
  const madeBefore = props(core.doc(h).tracks.flatMap((t) => t.clips).flatMap((c) => [c, ...((c.props.group as { tracks?: { clips: Clip[] }[] } | undefined)?.tracks?.flatMap((t) => t.clips) ?? [])]).find((c) => c.id === second.id)!).takes.length;
  await waitJob(core, jobOf(await core.run(h, "broll.generate", { clips: [second.id] })));
  const inside = core.doc(h).tracks.flatMap((t) => t.clips).flatMap((c) => (c.props.group as { tracks?: { clips: Clip[] }[] } | undefined)?.tracks?.flatMap((t) => t.clips) ?? []).find((c) => c.id === second.id)!;
  expect(props(inside).takes).toHaveLength(madeBefore + 1);
  await core.run(h, "group.close", {});
  await core.undo(h);
  await core.undo(h);

  // Made again from a prompt the model refuses: the clip keeps what it had and says why.
  const first = made[0]!;
  await core.run(h, "clip.set", { clip: first.id, props: { broll: { prompt: "[refuse] a street" } } });
  await expect(waitJob(core, jobOf(await core.run(h, "broll.generate", { clips: [first.id] })))).rejects.toThrow(/the model refused the prompt/);
  expect(brolls()[0]!.assetId).toBe(first.assetId);
  expect((await state())!.errors[first.id]).toMatch(/the model refused the prompt/);

  // On a locked track, footage isn't put in the clip: picking a take is refused, and a take made meanwhile stays in the Media Bin.
  await core.run(h, "clip.set", { clip: first.id, props: { broll: { prompt: "a street" } } });
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === first.id))!;
  const making = jobOf(await core.run(h, "broll.generate", { clips: [first.id] }));
  await core.run(h, "track.set", { track: track.id, locked: true });
  const assets = Object.keys(core.doc(h).assets).length;
  await waitJob(core, making);
  expect(Object.keys(core.doc(h).assets)).toHaveLength(assets + 1);
  expect(brolls()[0]!.assetId).toBe(first.assetId);
  expect((await state())!.errors[first.id]).toMatch(/track is locked/);
  await expect(core.run(h, "broll.use", { clip: first.id, asset: props(brolls()[0]!).takes[0]!.assetId })).rejects.toThrow(/is locked/);
  await core.run(h, "track.set", { track: track.id, locked: false });

  // Every step undone, the document is as it was before the clip was added; the canvas too.
  for (let n = (await core.history(h)).undo.length - steps; n > 0; n--) await core.undo(h);
  expect(core.doc(h)).toEqual(start);
  expect(canvas().equals(plain)).toBe(true);
  core.detachView(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("B-roll: a typed prompt needs no OpenAI key; planning and making refuse each other; a plan for a clip moved meanwhile is dropped; nested and too-long shots; long prompts; cancelling cancels on Replicate", async () => {
  const { core, h, brolls, state } = await talk("races", { "replicate-api-token": "replicate-token" });
  // Left empty, with only a Replicate token: the words said under it are the prompt.
  await core.run(h, "broll.add", { time: 20, duration: 2 });
  const fromWords = predictions.length;
  await waitJob(core, jobOf(await core.run(h, "broll.generate", {})));
  // The stand-in transcript's words from 20 to 22 s.
  expect(predictions[fromWords]!.prompt).toBe('Footage illustrating: "word word word word".');
  await core.undo(h);
  await core.undo(h);

  // Made in numbered steps with a clock; checks that fail are tried again rather than losing the footage.
  await core.run(h, "broll.add", { time: 20, duration: 2, prompt: "[steps] a field" });
  const stepping = jobOf(await core.run(h, "broll.generate", {}));
  const seen = new Set<string>();
  for (;;) {
    const j = await core.job(stepping);
    if (j.stage) seen.add(j.stage.replace(/ · \d+:\d\d$/, ""));
    if (j.state !== "running") break;
    await Bun.sleep(10);
  }
  expect([...seen].filter((s) => / of 3 /.test(s))).toEqual(["1 of 3 · Sent to Replicate, waiting its turn", "2 of 3 · Veo 3.1 Fast is making it", "3 of 3 · Downloading"]);
  await core.run(h, "clip.set", { clip: brolls().find((c) => props(c).prompt === "[steps] a field")!.id, props: { broll: { prompt: "[flaky] a field" } } });
  await waitJob(core, jobOf(await core.run(h, "broll.generate", {})));
  await core.undo(h);
  await core.undo(h);
  await core.undo(h);
  await core.undo(h);

  // A frame over Veo's 8 s (a cut rounded to a frame) is made, not refused: the footage ends a frame early.
  await core.run(h, "broll.add", { time: 24, duration: 8 + 1 / 30, prompt: "a frame over" });
  await waitJob(core, jobOf(await core.run(h, "broll.generate", {})));
  await core.undo(h);
  await core.undo(h);

  const footageBefore = readdirSync(join(dir, "races.beproj", "media", "B-roll")).filter((f) => f.endsWith(".mp4")).length;
  // Typed, with only a Replicate token.
  await core.run(h, "broll.add", { time: 0, duration: 4, prompt: "[hold] a pan over hills" });
  const [clip] = brolls();
  const making = jobOf(await core.run(h, "broll.generate", {}));
  for (let i = 0; i < 100 && !predictions.some((p) => p.prompt === "[hold] a pan over hills"); i++) await Bun.sleep(20);
  // While it is made it can't be planned or made again.
  await expect(core.run(h, "broll.plan", {})).rejects.toThrow(/being planned or made already/);
  await expect(core.run(h, "broll.generate", {})).rejects.toThrow(/being planned or made already/);
  const counted = cancelled.length;
  await core.cancelJob(making);
  await expect(waitJob(core, making)).rejects.toThrow(/cancelled/);
  for (let i = 0; i < 100 && cancelled.length === counted; i++) await Bun.sleep(20);
  expect(cancelled.length).toBe(counted + 1);
  expect(await state()).toMatchObject({ making: [] });
  expect((await state())!.errors[clip!.id]).toBeUndefined();
  // Nothing paid for arrived: no file left for it.
  expect(readdirSync(join(dir, "races.beproj", "media", "B-roll")).filter((f) => f.endsWith(".mp4"))).toHaveLength(footageBefore);

  // Cancelled before Replicate answers that it started one: it is still cancelled there once it answers.
  await core.run(h, "clip.set", { clip: clip!.id, props: { broll: { prompt: "[late-start] a pan" } } });
  const starting = jobOf(await core.run(h, "broll.generate", {}));
  for (let i = 0; i < 100 && !predictions.some((p) => p.prompt === "[late-start] a pan"); i++) await Bun.sleep(10);
  const before = cancelled.length;
  await core.cancelJob(starting);
  await expect(waitJob(core, starting)).rejects.toThrow(/cancelled/);
  for (let i = 0; i < 100 && cancelled.length === before; i++) await Bun.sleep(20);
  expect(cancelled.length).toBe(before + 1);

  // A prompt longer than a file name can be: the name is cut short, the prompt kept whole.
  await core.run(h, "clip.set", { clip: clip!.id, props: { broll: { prompt: `${"x".repeat(300)} [refuse]` } } });
  await expect(waitJob(core, jobOf(await core.run(h, "broll.generate", {})))).rejects.toThrow(/the model refused the prompt/);

  // A plan answered after its clip was moved is dropped, the clip as it is.
  const withKey = await talk("plans", { "openai-api-key": "openai-key" });
  await withKey.core.setPreference("brollPlanner", "openai");
  await withKey.core.run(withKey.h, "broll.add", { time: 0, duration: 12 });
  const [late] = withKey.brolls();
  await styled(withKey.core, withKey.h, late!.id, "[late]");
  const planning = jobOf(await withKey.core.run(withKey.h, "broll.plan", {}));
  await expect(withKey.core.run(withKey.h, "broll.generate", {})).rejects.toThrow(/being planned or made already|has no prompt/);
  await withKey.core.run(withKey.h, "clip.move", { clip: late!.id, by: 1 });
  await expect(waitJob(withKey.core, planning)).rejects.toThrow(/moved or trimmed while it was planned/);
  expect((await withKey.state())!.planning).toEqual([]);
  expect(props(withKey.brolls()[0]!).prompt).toBe("");

  // Streamed, its steps are told as they happen, numbered, with the time it has taken.
  await styled(withKey.core, withKey.h, late!.id, "[stream]");
  const streaming = jobOf(await withKey.core.run(withKey.h, "broll.plan", { clip: late!.id }));
  const stages = new Set<string>();
  for (;;) {
    const j = await withKey.core.job(streaming);
    if (j.stage) stages.add(j.stage.replace(/ · \d+:\d\d$/, ""));
    if (j.state !== "running") break;
    await Bun.sleep(20);
  }
  expect(plans.at(-1)).toMatchObject({ stream: true });
  expect([...stages].filter((s) => / of 3 /.test(s))).toEqual(["1 of 3 · gpt-6.1-sol is thinking", "2 of 3 · Searching the web", "3 of 3 · Writing the shots"]);
  expect(props(withKey.brolls()[0]!).prompt).toBe("Streamed");
  // 12 s split in two for Veo: back to one clip for what follows.
  await withKey.core.undo(withKey.h);
  // Nothing from OpenAI for the idle limit: given up, saying so.
  process.env.BEACON_OPENAI_IDLE_MS = "300";
  await styled(withKey.core, withKey.h, late!.id, "[silent]");
  await expect(waitJob(withKey.core, jobOf(await withKey.core.run(withKey.h, "broll.plan", { clip: late!.id })))).rejects.toThrow(/OpenAI sent nothing for 0 minutes while planning/);
  delete process.env.BEACON_OPENAI_IDLE_MS;

  // A shot planned inside another is dropped, not overlapped (it would be paid for twice); the split keeps the clip's
  // own look (an effect here) on every piece.
  await withKey.core.run(withKey.h, "clip.move", { clip: late!.id, by: -1 });
  await withKey.core.run(withKey.h, "effect.add", { clip: late!.id, type: "drop-shadow" });
  await styled(withKey.core, withKey.h, late!.id, "[nested]");
  await waitJob(withKey.core, jobOf(await withKey.core.run(withKey.h, "broll.plan", { clip: late!.id })));
  expect(withKey.brolls().map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)])).toEqual([
    [0, 8],
    [8, 12],
  ]);
  expect(withKey.brolls().map((c) => c.effects.map((e) => e.type))).toEqual([["drop-shadow"], ["drop-shadow"]]);

  // Boundaries between frames (Kling, which makes 3 s shots, keeps all three): snapped once, shared, so the shots butt up and the plan goes through.
  await withKey.core.undo(withKey.h);
  await withKey.core.setPreference("brollModel", "kling-v3");
  await styled(withKey.core, withKey.h, late!.id, "[frames]");
  await waitJob(withKey.core, jobOf(await withKey.core.run(withKey.h, "broll.plan", { clip: late!.id })));
  const framed = withKey.brolls();
  expect(framed).toHaveLength(3);
  for (const [i, c] of framed.entries()) if (i) expect(c.start).toBe(framed[i - 1]!.start + framed[i - 1]!.duration);

  // Planned for Kling (15 s shots), then Veo chosen (8 s): refused before anything is paid for, not made short.
  await withKey.core.undo(withKey.h);
  await withKey.core.setPreference("brollModel", "kling-v3");
  await styled(withKey.core, withKey.h, late!.id, "[long]");
  await waitJob(withKey.core, jobOf(await withKey.core.run(withKey.h, "broll.plan", { clip: late!.id })));
  expect(withKey.brolls()).toHaveLength(1);
  await withKey.core.setPreference("brollModel", "veo-3.1-fast");
  const asked = predictions.length;
  await expect(withKey.core.run(withKey.h, "broll.generate", { clips: [late!.id] })).rejects.toThrow(/longer than Veo 3.1 Fast's 8 s/);
  expect(predictions.length).toBe(asked);
}, 60_000);
