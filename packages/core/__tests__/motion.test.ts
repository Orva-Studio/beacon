import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionProps, MotionState } from "@beacon/features";
import { secondsToTicks } from "@beacon/model";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-motion-"));

/**
 * OpenAI's Responses API standing in for the real one (which charges): it designs a composition, wrapped in a whole
 * document as a model sometimes does, with a word timed to the speech, a GSAP tween and a map drawn in three.js's
 * absence, so the page carries GSAP and the map; asked to pick examples from the catalog, it picks `x-post`.
 */
const asked: Record<string, unknown>[] = [];
/** While set, the stand-in answers only once it resolves: the clip can be changed while it is made. */
let hold: Promise<void> | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    const body = (await req.json()) as { text: { format: { name: string } } };
    asked.push(body);
    await hold;
    // Asked for the Firecrawl logo: it calls `brand` first, then uses the asset it gave.
    const input = JSON.stringify((body as { input?: unknown }).input);
    if (body.text.format.name === "motion_graphic" && input.includes("Firecrawl logo")) {
      if (!input.includes("function_call_output")) return Response.json({ output: [{ type: "function_call", call_id: "call_1", name: "brand", arguments: JSON.stringify({ url: "https://firecrawl.dev" }) }], usage: { input_tokens: 100, output_tokens: 10 } });
      const asset = /logo-\d+/.exec(input)![0];
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ html: `<div style="color:#FF4C00"><img src="asset:${asset}" width="200"></div>` }) }] }], usage: { input_tokens: 100, output_tokens: 10 } });
    }
    const answer =
      body.text.format.name === "motion_examples"
        ? { names: ["x-post"] }
        : { html: `<html><body><style>.t { font-size: 120px; font-family: var(--heading); }</style><div class="t"><span class="w" data-t="0.2">Three</span> <span class="w" data-t="0.6">wins</span></div><svg width="960" height="540"><path id="land" fill="#456"/></svg><script>gsap.from(".t", { y: 40, duration: 0.5 }); document.getElementById("land").setAttribute("d", BeaconMap.create({ width: 960, height: 540, center: [-170, 30] }).land);</script></body></html>` };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 500 } });
  },
});
process.env.BEACON_OPENAI_URL = server.url.origin;
afterAll(() => {
  server.stop(true);
  delete process.env.BEACON_OPENAI_URL;
  rmSync(dir, { recursive: true, force: true });
});

const settled = async (core: LocalCore) => {
  for (let i = 0; i < 300 && (await core.jobs()).some((j) => j.state === "running"); i++) await Bun.sleep(20);
};

test("motion graphics designed by OpenAI as HTML, with examples from the catalog (named, else picked), and drawn by WebKit with transparency into the clip, at its box's size, with the libraries it uses; drawn again in another Look with no AI; a refused key says where to fix it", async () => {
  const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
  const core = new LocalCore({ configDir: join(dir, "config"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  await core.setPreference("motionPlanner", "openai");
  const h = await core.create({ path: join(dir, "m.beproj") });
  await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "Three wins" });
  const id = (await core.session(h)).selection[0]!;
  const clip = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  // A box half the canvas wide: drawn at that size, not scaled.
  await core.run(h, "clip.set", { clip: id, props: { motionBox: { width: 960, height: 540 } } });
  await core.run(h, "motion.make", {});
  await settled(core);
  const format = (asked.at(-1)!.text as { format: { strict: boolean } }).format;
  expect(format.strict).toBe(true);
  expect(JSON.stringify(asked.at(-1)!.input)).toContain("Three wins");
  // A brief naming no example: one is picked from the catalog first, and its source shown to the author.
  expect((asked.at(-2)!.text as { format: { name: string } }).format.name).toBe("motion_examples");
  expect(JSON.stringify(asked.at(-1)!.input)).toContain("### x-post");
  const m = () => clip().props.motion as MotionProps;
  expect(m().takes).toHaveLength(1);
  // What OpenAI charged, both calls (picking examples, then writing): 500 input, 500 cached and 500 output tokens each.
  expect(m().takes[0]!.cost).toBeCloseTo((2 * (500 * 2 + 500 * 0.1 + 500 * 10)) / 1e6, 9);
  // Only the inside of <body> is kept.
  expect(m().takes[0]!.html.startsWith("<style>")).toBe(true);
  const drawn = core.doc(h).assets[clip().assetId!]!;
  expect(drawn.path).toMatch(/media\/Motion graphics\/Three wins\.mov$/);
  const video = (drawn.derived.media as { streams: { kind: string; width?: number; height?: number; pixelFormat?: string }[] }).streams.find((s) => s.kind === "video")!;
  expect([video.width, video.height]).toEqual([960, 540]);
  const doc = readFileSync(drawn.path.replace(/\.mov$/, ".html"), "utf8");
  expect(doc).toContain("Content-Security-Policy");
  // Nothing fades in or out unless the composition does it.
  expect(doc).not.toMatch(/#beacon-stage \{[^}]*animation/);
  expect(doc).toContain("GSAP 3.15.0");
  // Libraries only where used: the map, not three.js.
  expect(doc).toContain("BEACON_COUNTRIES");
  expect(doc).not.toContain("three.js 0.186");
  // Another Look draws it again from the same composition: no AI asked.
  const calls = asked.length;
  await core.run(h, "motion.style", { clips: [id], look: "tech" });
  await core.run(h, "motion.render", { clips: [id] });
  await settled(core);
  expect(asked.length).toBe(calls);
  expect(clip().assetId).not.toBe(drawn.id);
  expect(m().takes).toHaveLength(1);
  expect(readFileSync(core.doc(h).assets[clip().assetId!]!.path.replace(/\.mov$/, ".html"), "utf8")).toContain("Menlo");
  // Drawn again with nothing changed (a Look or timing the composition doesn't use): left as it is, no new file.
  const kept = clip().assetId;
  const files = Object.keys(core.doc(h).assets).length;
  await core.run(h, "motion.render", { clips: [id] });
  await settled(core);
  expect(clip().assetId).toBe(kept);
  expect(Object.keys(core.doc(h).assets).length).toBe(files);
  // A brief naming a catalog item gets it as its base, with no picking.
  await core.run(h, "clip.set", { clip: id, props: { motion: { source: "manual", manual: "Three wins, on the apple-money-count block" } } });
  const before = asked.length;
  await core.run(h, "motion.make", {});
  await settled(core);
  expect(asked.length).toBe(before + 1);
  expect(JSON.stringify(asked.at(-1)!.input)).toContain("### apple-money-count");
  expect(m().takes).toHaveLength(2);
  secrets.set("openai-api-key", "wrong");
  await core.run(h, "motion.make", {});
  await settled(core);
  expect(((await core.session(h)).features.motion as MotionState).errors[id]).toMatch(/Settings › AI/);
  expect(m().takes).toHaveLength(2);
  await core.close(h);
}, 60_000);

test("the author searches the web through Firecrawl (keyless, or with the user's key): a brand's real logo downloaded and drawn into the page, which stays offline", async () => {
  const keys: (string | null)[] = [];
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="79" height="15"><path d="M0 0h10v15H0z" fill="#FF4C00"/></svg>`;
  const firecrawl: Bun.Server<undefined> = Bun.serve({
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/logo.svg") return new Response(logo, { headers: { "Content-Type": "image/svg+xml" } });
      keys.push(req.headers.get("authorization"));
      if (path === "/v2/scrape") return Response.json({ success: true, data: { branding: { brandName: "Firecrawl", colors: { primary: "#FF4C00" }, images: { logo: `${firecrawl.url.origin}/logo.svg` } } } });
      return Response.json({ success: false }, { status: 404 });
    },
  });
  process.env.BEACON_FIRECRAWL_URL = firecrawl.url.origin;
  try {
    const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
    const core = new LocalCore({ configDir: join(dir, "config-web"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
    const h = await core.create({ path: join(dir, "web.beproj") });
    await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "The Firecrawl logo, on x-post" });
    const id = (await core.session(h)).selection[0]!;
    const clip = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    await core.run(h, "clip.set", { clip: id, props: { motionBox: { width: 640, height: 360 } } });
    await core.run(h, "motion.make", {});
    await settled(core);
    expect(((await core.session(h)).features.motion as MotionState).errors[id]).toBeUndefined();
    // Keyless: no Authorization header.
    expect(keys).toEqual([null]);
    const sent = JSON.stringify(asked.at(-1)!.input);
    // The tool's answer carried the SVG, so the author could restyle it, and the brand's colour.
    expect(sent).toContain("#FF4C00");
    expect(sent).toContain("M0 0h10v15H0z");
    expect((asked.at(-1)!.tools as { name: string }[]).map((t) => t.name)).toEqual(["web_search", "brand", "image"]);
    const m = clip().props.motion as MotionProps;
    const data = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;
    expect(m.takes[0]!.html).toContain(`src="${data}"`);
    const doc = readFileSync(core.doc(h).assets[clip().assetId!]!.path.replace(/\.mov$/, ".html"), "utf8");
    expect(doc).toContain(data);
    expect(doc).toContain("img-src data:");
    // With a key, it's sent.
    secrets.set("firecrawl-api-key", "fc-key");
    await core.run(h, "motion.make", {});
    await settled(core);
    expect(keys.at(-1)).toBe("Bearer fc-key");
    await core.close(h);
  } finally {
    firecrawl.stop(true);
    delete process.env.BEACON_FIRECRAWL_URL;
  }
}, 60_000);

test("OpenAI makes motion graphics by default, even before its key is added: Make then says where to add it; removing Claude's key falls back to OpenAI", async () => {
  const secrets = new Map<string, string>();
  const core = new LocalCore({ configDir: join(dir, "config-default"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const pref = async () => (await core.preferences()).find((p) => p.id === "motionPlanner")!.value;
  expect(await pref()).toBe("openai");
  const h = await core.create({ path: join(dir, "default.beproj") });
  await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "Three wins" });
  const id = (await core.session(h)).selection[0]!;
  await core.run(h, "motion.make", {});
  await settled(core);
  expect(((await core.session(h)).features.motion as MotionState).errors[id]).toMatch(/no OpenAI API key: add one in Settings › AI/);
  await core.setSecret("anthropic-api-key", "sk-ant");
  await core.setPreference("motionPlanner", "claude");
  await core.setSecret("anthropic-api-key", null);
  expect(await pref()).toBe("openai");
  // Apple's model needs no key; OpenAI stays choosable as the default.
  await core.setPreference("motionPlanner", "apple");
  await core.setPreference("motionPlanner", "openai");
  await expect(core.setPreference("motionPlanner", "claude")).rejects.toThrow(/needs the Anthropic API key/);
  await core.close(h);
});

test("a clip resized and lengthened while it is made keeps what the AI wrote: drawn again to fit, with no AI, then shown; one take", async () => {
  const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
  const core = new LocalCore({ configDir: join(dir, "config-fit"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
  await core.setPreference("motionPlanner", "openai");
  const h = await core.create({ path: join(dir, "fit.beproj") });
  await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "Three wins, on the x-post block" });
  const id = (await core.session(h)).selection[0]!;
  const clip = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  await core.run(h, "clip.set", { clip: id, props: { motionBox: { width: 960, height: 540 } } });
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  const calls = asked.length;
  await core.run(h, "motion.make", {});
  for (let i = 0; i < 300 && asked.length === calls; i++) await Bun.sleep(20);
  await core.run(h, "clip.set", { clip: id, props: { motionBox: { width: 640, height: 360 } } });
  await core.run(h, "clip.trim", { clip: id, end: 3 });
  release();
  hold = undefined;
  await settled(core);
  const state = (await core.session(h)).features.motion as MotionState;
  expect(state.errors[id]).toBeUndefined();
  expect(state.making).not.toContain(id);
  expect(asked.length).toBe(calls + 1);
  const m = clip().props.motion as MotionProps;
  expect(m.takes).toHaveLength(1);
  expect(m.shown).toBe(0);
  const drawn = core.doc(h).assets[clip().assetId!]!;
  const video = (drawn.derived.media as { streams: { kind: string; width?: number; height?: number; duration: number }[] }).streams.find((s) => s.kind === "video")!;
  expect([video.width, video.height]).toEqual([640, 360]);
  expect(video.duration).toBeCloseTo(3, 1);
  expect(clip().duration).toBe(secondsToTicks(3));
  expect(clip().assetId).toBe(m.takes[0]!.assetId!);
  // Only the drawing to fit is in the Media Bin: the one made at the old size never was.
  expect(Object.values(core.doc(h).assets).filter((a) => a.path.endsWith(".mov"))).toHaveLength(1);
  await core.close(h);
});

test("a reference image: copied into the project's media, sent to OpenAI with the brief to recreate and animate; Apple's model is refused; removed in one step", async () => {
  const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
  const core = new LocalCore({ configDir: join(dir, "config-ref"), cacheDir: join(dir, "cache-ref"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
  await core.setPreference("motionPlanner", "openai");
  const h = await core.create({ path: join(dir, "ref.beproj") });
  await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "Three wins" });
  const id = (await core.session(h)).selection[0]!;
  const m = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.props.motion as MotionProps;
  // A 1×1 PNG.
  const png = join(dir, "look.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await core.run(h, "motion.refer", { path: png });
  await settled(core);
  const ref = core.doc(h).assets[m().reference!]!;
  expect(ref.kind).toBe("image");
  expect(ref.path).toMatch(/ref\.beproj\/media\/Motion graphics\/References\/look\.png$/);
  await core.run(h, "motion.make", {});
  await settled(core);
  const content = (asked.at(-1)!.input as { role: string; content: unknown }[]).find((x) => x.role === "user")!.content as { type: string; image_url?: string }[];
  expect(content.find((c) => c.type === "input_image")!.image_url).toMatch(/^data:image\/png;base64,iVBOR/);
  expect(JSON.stringify(asked.at(-1)!.input)).toContain("A reference image is attached");
  expect(m().takes).toHaveLength(1);
  await core.setPreference("motionPlanner", "apple");
  await expect(core.run(h, "motion.make", {})).rejects.toThrow(/needs OpenAI/);
  const steps = (await core.history(h)).undo.length;
  await core.run(h, "motion.refer", { path: null });
  expect(m().reference).toBeUndefined();
  expect((await core.history(h)).undo.length).toBe(steps + 1);
  await core.close(h);
}, 60_000);

test("Claude makes motion graphics as OpenAI does: the same brief, streamed, with the reference image, a refusal falling back on Anthropic's side; the take says who made it and what it cost", async () => {
  const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const anthropic: Bun.Server<undefined> = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      if (new URL(req.url).pathname === "/icon.svg") return new Response(`<svg xmlns="http://www.w3.org/2000/svg"/>`, { headers: { "Content-Type": "image/svg+xml" } });
      if (req.headers.get("authorization") !== "Bearer anthropic-key") return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid API key" } }, { status: 401 });
      const body = (await req.json()) as { output_config: { format: { schema: { required: string[] } } } };
      seen.push({ headers: Object.fromEntries(req.headers), body: body as Record<string, unknown> });
      const messages = JSON.stringify((body as { messages?: unknown }).messages);
      const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
      // Asked for an icon: it downloads one with `image` first, then uses it.
      if (body.output_config.format.schema.required[0] === "html" && messages.includes("an icon") && !messages.includes("tool_result")) {
        const events: object[] = [
          start,
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "image", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ url: `${anthropic.url.origin}/icon.svg` }) } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 500 } },
          { type: "message_stop" },
        ];
        return new Response(sse(events), { headers: { "Content-Type": "text/event-stream" } });
      }
      const icon = /image-\d+/.exec(messages)?.[0];
      const answer = body.output_config.format.schema.required[0] === "names" ? { names: [] } : { html: icon ? `<img src="asset:${icon}">` : `<div class="t"><span class="w" data-t="0.2">Claude</span></div>` };
      const events = [
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(answer) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } },
        { type: "message_stop" },
      ];
      return new Response(sse(events), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  process.env.BEACON_ANTHROPIC_URL = anthropic.url.origin;
  try {
    const secrets = new Map<string, string>([["anthropic-api-key", "anthropic-key"]]);
    const core = new LocalCore({ configDir: join(dir, "config-claude"), cacheDir: join(dir, "cache-claude"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
    await core.setPreference("motionPlanner", "claude");
    const h = await core.create({ path: join(dir, "claude.beproj") });
    await core.run(h, "motion.add", { time: 0, duration: 2, prompt: "Claude, in big type" });
    const id = (await core.session(h)).selection[0]!;
    const m = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.props.motion as MotionProps;
    const png = join(dir, "claude-look.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await core.run(h, "motion.refer", { path: png });
    await settled(core);
    await core.run(h, "motion.make", {});
    await settled(core);
    expect(((await core.session(h)).features.motion as MotionState).errors[id]).toBeUndefined();
    expect(m().takes[0]!.html).toContain("Claude");
    expect(m().takes[0]!.by).toBe("claude");
    // Two calls (picking examples, then writing), 1000 input and 500 output tokens each, at Opus 5.5's $4 and $20.
    expect(m().takes[0]!.cost).toBeCloseTo((2 * (1000 * 4 + 500 * 20)) / 1e6, 9);
    const last = seen.at(-1)!;
    expect(last.body.model).toBe("claude-opus-5-5");
    expect(last.body.fallbacks).toBe("default");
    expect(last.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    const content = (last.body.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0]!.content;
    expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(JSON.stringify(last.body.system)).toContain("A reference image is attached");
    // Its tools: an icon downloaded in one round, then used.
    await core.run(h, "motion.refer", { path: null });
    await core.run(h, "clip.set", { clip: id, props: { motion: { source: "manual", manual: "an icon, on x-post" } } });
    await core.run(h, "motion.make", {});
    await settled(core);
    expect(((await core.session(h)).features.motion as MotionState).errors[id]).toBeUndefined();
    expect(m().takes.at(-1)!.html).toBe(`<img src="data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>`).toString("base64")}">`);
    const round = seen.at(-1)!.body as { tools: { name: string }[]; messages: { role: string; content: { type: string }[] }[] };
    expect(round.tools.map((t) => t.name)).toEqual(["web_search", "brand", "image"]);
    expect(round.messages.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(round.messages[2]!.content[0]!.type).toBe("tool_result");
    // A wrong key says where to fix it.
    secrets.set("anthropic-api-key", "wrong");
    await core.run(h, "motion.make", {});
    await settled(core);
    expect(((await core.session(h)).features.motion as MotionState).errors[id]).toMatch(/Anthropic refused the API key/);
    await core.close(h);
  } finally {
    anthropic.stop(true);
    delete process.env.BEACON_ANTHROPIC_URL;
  }
}, 60_000);
