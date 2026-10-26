import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionProps, MotionState } from "@beacon/features";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-motion-"));

/**
 * OpenAI's Responses API standing in for the real one (which charges): it composes a title in the box's top third and
 * a list in its bottom one, with a piece of a kind Beacon doesn't have, for Beacon to leave out.
 */
const asked: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    asked.push((await req.json()) as Record<string, unknown>);
    const empty = { detail: "", value: 0, prefix: "", suffix: "", items: [] };
    const pieces = [
      { ...empty, kind: "title", start: 0, end: 3, area: "top", text: "Three wins" },
      { ...empty, kind: "list", start: 0.5, end: 3, area: "bottom", text: "", items: ["Faster cuts", "Cleaner audio"] },
      { ...empty, kind: "chart", start: 0, end: 3, area: "middle", text: "?" },
    ];
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ pieces }) }] }] });
  },
});
process.env.BEACON_OPENAI_URL = server.url.origin;
afterAll(() => {
  server.stop(true);
  delete process.env.BEACON_OPENAI_URL;
  rmSync(dir, { recursive: true, force: true });
});

const settled = async (core: LocalCore) => {
  for (let i = 0; i < 300 && (await core.jobs()).some((j) => j.state === "running" || j.state === "queued"); i++) await Bun.sleep(20);
};

test("motion graphics composed by OpenAI: pieces mixed in parts of the box, a kind Beacon can't draw left out, asked for as strict JSON; a refused key says where to fix it", async () => {
  const secrets = new Map<string, string>([["openai-api-key", "openai-key"]]);
  const core = new LocalCore({ configDir: join(dir, "config"), cacheDir: join(dir, "cache"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  await core.setPreference("brollPlanner", "openai");
  const h = await core.create({ path: join(dir, "m.beproj") });
  await core.run(h, "motion.add", { time: 0, duration: 3, prompt: "Three wins: faster cuts, cleaner audio" });
  const id = (await core.session(h)).selection[0]!;
  const clip = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  await core.run(h, "motion.make", {});
  await settled(core);
  const body = asked.at(-1)!;
  const format = (body.text as { format: { strict: boolean; schema: { properties: { pieces: { items: Record<string, unknown> } } } } }).format;
  expect(format.strict).toBe(true);
  expect("$schema" in format.schema.properties.pieces.items).toBe(false);
  expect(JSON.stringify(body.input)).toContain("Three wins: faster cuts, cleaner audio");
  const m = clip().props.motion as MotionProps;
  expect(m.takes[0]!.pieces.map((p) => p.kind)).toEqual(["title", "list"]);
  const tracks = (clip().props.group as { tracks: { name: string }[] }).tracks.map((t) => t.name);
  expect(tracks).toEqual(expect.arrayContaining(["Three", "wins", "Faster cuts", "Cleaner audio"]));
  secrets.set("openai-api-key", "wrong");
  await core.run(h, "motion.make", {});
  await settled(core);
  expect(((await core.session(h)).features.motion as MotionState).errors[id]).toMatch(/Settings › AI/);
  expect((clip().props.motion as MotionProps).takes).toHaveLength(1);
  await core.close(h);
});
