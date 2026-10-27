import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video-3.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-auto-tune-"));

// OpenAI standing in: it charges, so the test never reaches it.
const asked: Record<string, any>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer openai-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
    asked.push((await req.json()) as Record<string, any>);
    // Warmer as asked; grain past its range, to be kept within it.
    const answer = { ...Object.fromEntries(Object.keys(asked.at(-1)!.text.format.schema.properties).map((k) => [k, 0])), warmth: 0.5, grain: 7, strength: 1, contrast: 1.1, saturation: 1, why: "Warmer, as asked." };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 0 } } });
  },
});
process.env.BEACON_OPENAI_URL = server.url.origin;
afterAll(() => {
  server.stop(true);
  delete process.env.BEACON_OPENAI_URL;
  rmSync(dir, { recursive: true, force: true });
});

async function waitJob(core: LocalCore, id: string) {
  for (;;) {
    const j = await core.job(id);
    if (j.state === "done") return j;
    if (j.state === "failed") throw new Error(j.error);
    await Bun.sleep(50);
  }
}

test.skipIf(!existsSync(VIDEO))("Auto Tune sends three frames of the clip with Film Look's values and ranges and the note to GPT-6.1 Terra, and sets what comes back within the ranges, one undo step with its cost", async () => {
  const video = join(dir, "clip.mp4");
  copyFileSync(VIDEO, video);
  const secrets = new Map<string, string>();
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [video], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const clip = r.clips[0]!;
  await core.run(h, "effect.add", { clip, type: "film-look" });
  const fx = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip)!.effects.find((e) => e.type === "film-look")!;

  // No key: it says where to add one, and nothing changes.
  const before = JSON.stringify(fx().params);
  const job = (r2: { results: unknown[] }) => (r2.results.at(-1) as { job: string }).job;
  await expect(waitJob(core, job(await core.run(h, "filmLook.autoTune", { clip })))).rejects.toThrow(/no OpenAI API key/);
  expect(JSON.stringify(fx().params)).toBe(before);
  expect(asked).toHaveLength(0);

  secrets.set("openai-api-key", "openai-key");
  const steps = (await core.history(h)).undo.length;
  await waitJob(core, job(await core.run(h, "filmLook.autoTune", { clip, note: "warmer" })));
  const sent = asked.at(-1)!;
  expect(sent.model).toBe("gpt-6.1-terra");
  expect(sent.reasoning).toEqual({ effort: "medium" });
  const user = sent.input[1].content as { type: string; text?: string; image_url?: string }[];
  expect(user.filter((c) => c.type === "input_image")).toHaveLength(3);
  expect(user.every((c) => c.type !== "input_image" || c.image_url!.startsWith("data:image/png;base64,"))).toBe(true);
  expect(user[0]!.text).toContain("warmer");
  expect(Object.keys(sent.text.format.schema.properties)).toContain("halation");
  // What came back is set, within the ranges: grain at most 100%.
  expect(fx().params).toMatchObject({ warmth: 0.5, grain: 1 });
  const history = (await core.history(h)).undo;
  expect(history.length - steps).toBe(1);
  expect(history.at(-1)).toMatch(/^Auto Tune Film Look \(\$0\.\d{3}\)$/);
  await core.undo(h);
  expect(JSON.stringify(fx().params)).toBe(before);

  // Two Film Looks on the clip: the one whose button was pressed is tuned, not the first.
  await core.run(h, "effect.add", { clip, type: "film-look" });
  const looks = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip)!.effects.filter((e) => e.type === "film-look");
  const [one, two] = looks();
  await waitJob(core, job(await core.run(h, "filmLook.autoTune", { clip, effect: two!.id })));
  expect(JSON.stringify(looks()[0]!.params)).toBe(JSON.stringify(one!.params));
  expect(looks()[1]!.params).toMatchObject({ warmth: 0.5 });
  await core.close(h);
}, 60_000);
