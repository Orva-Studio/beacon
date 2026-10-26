import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionProps, MotionState } from "@beacon/features";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-motion-"));

/**
 * OpenAI's Responses API standing in for the real one (which charges): it designs a composition, wrapped in a whole
 * document as a model sometimes does, with a word timed to the speech and a script, which the page's policy blocks.
 */
const asked: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    asked.push((await req.json()) as Record<string, unknown>);
    const html = `<html><body><style>.t { font-size: 120px; font-family: var(--heading); }</style><div class="t"><span class="w" data-t="0.2">Three</span> <span class="w" data-t="0.6">wins</span></div><script>document.body.remove()</script></body></html>`;
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ html }) }] }] });
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

test("motion graphics designed by OpenAI as HTML and drawn by WebKit with transparency into the clip, at its box's size; drawn again in another Look with no AI; a refused key says where to fix it", async () => {
  const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
  const core = new LocalCore({ configDir: join(dir, "config"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  await core.setPreference("brollPlanner", "openai");
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
  const m = () => clip().props.motion as MotionProps;
  expect(m().takes).toHaveLength(1);
  // Only the inside of <body> is kept.
  expect(m().takes[0]!.html.startsWith("<style>")).toBe(true);
  const drawn = core.doc(h).assets[clip().assetId!]!;
  expect(drawn.path).toMatch(/media\/Motion graphics\/Three wins\.mov$/);
  const video = (drawn.derived.media as { streams: { kind: string; width?: number; height?: number; pixelFormat?: string }[] }).streams.find((s) => s.kind === "video")!;
  expect([video.width, video.height]).toEqual([960, 540]);
  expect(readFileSync(drawn.path.replace(/\.mov$/, ".html"), "utf8")).toContain("Content-Security-Policy");
  // Another Look draws it again from the same composition: no AI asked.
  const calls = asked.length;
  await core.run(h, "motion.style", { clips: [id], look: "tech" });
  await core.run(h, "motion.render", { clips: [id] });
  await settled(core);
  expect(asked.length).toBe(calls);
  expect(clip().assetId).not.toBe(drawn.id);
  expect(m().takes).toHaveLength(1);
  expect(readFileSync(core.doc(h).assets[clip().assetId!]!.path.replace(/\.mov$/, ".html"), "utf8")).toContain("Menlo");
  secrets.set("openai-api-key", "wrong");
  await core.run(h, "motion.make", {});
  await settled(core);
  expect(((await core.session(h)).features.motion as MotionState).errors[id]).toMatch(/Settings › AI/);
  expect(m().takes).toHaveLength(1);
  await core.close(h);
}, 60_000);
