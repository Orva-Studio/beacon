import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionProps, MotionState } from "@beacon/features";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-motion-"));

/**
 * OpenAI's Responses API standing in for the real one (which charges): it designs a composition, wrapped in a whole
 * document as a model sometimes does, with a word timed to the speech, a GSAP tween and a map drawn in three.js's
 * absence, so the page carries GSAP and the map; asked to pick examples from the catalog, it picks `x-post`.
 */
const asked: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    const body = (await req.json()) as { text: { format: { name: string } } };
    asked.push(body);
    const answer =
      body.text.format.name === "motion_examples"
        ? { names: ["x-post"] }
        : { html: `<html><body><style>.t { font-size: 120px; font-family: var(--heading); }</style><div class="t"><span class="w" data-t="0.2">Three</span> <span class="w" data-t="0.6">wins</span></div><svg width="960" height="540"><path id="land" fill="#456"/></svg><script>gsap.from(".t", { y: 40, duration: 0.5 }); document.getElementById("land").setAttribute("d", BeaconMap.create({ width: 960, height: 540, center: [-170, 30] }).land);</script></body></html>` };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
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
  // A brief naming no example: one is picked from the catalog first, and its source shown to the author.
  expect((asked.at(-2)!.text as { format: { name: string } }).format.name).toBe("motion_examples");
  expect(JSON.stringify(asked.at(-1)!.input)).toContain("### x-post");
  const m = () => clip().props.motion as MotionProps;
  expect(m().takes).toHaveLength(1);
  // Only the inside of <body> is kept.
  expect(m().takes[0]!.html.startsWith("<style>")).toBe(true);
  const drawn = core.doc(h).assets[clip().assetId!]!;
  expect(drawn.path).toMatch(/media\/Motion graphics\/Three wins\.mov$/);
  const video = (drawn.derived.media as { streams: { kind: string; width?: number; height?: number; pixelFormat?: string }[] }).streams.find((s) => s.kind === "video")!;
  expect([video.width, video.height]).toEqual([960, 540]);
  const doc = readFileSync(drawn.path.replace(/\.mov$/, ".html"), "utf8");
  expect(doc).toContain("Content-Security-Policy");
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
