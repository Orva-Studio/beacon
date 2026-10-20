import { afterAll, afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-retakes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

/**
 * Words at 0.4 s each with a 0.1 s gap, a pause of `pause` seconds where a line is "|": the talk's real audio
 * under a transcript that restarts lines.
 */
function said(lines: string, pause = 0.8) {
  const words: { text: string; start: number; end: number; p: number }[] = [];
  let t = 1;
  for (const w of lines.split(" ")) {
    if (w === "|") {
      t += pause;
      continue;
    }
    words.push({ text: w, start: Number(t.toFixed(3)), end: Number((t + 0.4).toFixed(3)), p: 1 });
    t += 0.5;
  }
  return words;
}

function transcribed(core: LocalCore, asset: Asset, words: ReturnType<typeof said>) {
  const file = new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!);
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(file, JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
}

const TALK =
  "Welcome to the video. | So the next step is | um, | so the next step is to open the settings. | Then we click on Bluetooth and | then we click on Bluetooth and pair the keyboard. | That's all for today.";

type Group = { start: number; end: number; key: string; takes: { start: number; end: number; text: string }[]; best: number; by: string; reason?: string };
type Found = { waiting: string[]; judging: string[]; judge: string; groups: Group[]; saved: number; current?: number };

async function talk(name: string, secrets = new Map<string, string>()) {
  const core = new LocalCore({
    cacheDir: join(dir, `${name}-cache`),
    configDir: join(dir, `${name}-config`),
    secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) },
  });
  const h = await core.create({ path: join(dir, `${name}.beproj`) });
  const copy = join(dir, `${name}.m4a`);
  copyFileSync(AUDIO, copy);
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  transcribed(core, asset, said(TALK));
  const text = async () => ((await core.query(h, "transcript.get", { format: "words" })) as { text: string }[]).map((w) => w.text).join(" ");
  return { core, h, asset, text };
}

test.skipIf(!existsSync(AUDIO))("Remove Retakes finds each line said again, keeps the last take, and Apply cuts the others in one undo step", async () => {
  const { core, h, text } = await talk("apply");
  const before = JSON.stringify(core.doc(h).tracks);
  await core.run(h, "retakes.review", {});
  const found = (await core.query(h, "transcript.retakes", {})) as Found;
  expect(found.waiting).toEqual([]);
  expect(found.judge).toBe("beacon");
  expect(found.groups.map((g) => g.takes.map((t) => t.text))).toEqual([
    ["So the next step is um,", "so the next step is"],
    ["Then we click on Bluetooth and", "then we click on Bluetooth and"],
  ]);
  expect(found.groups.map((g) => [g.best, g.by])).toEqual([
    [1, "beacon"],
    [1, "beacon"],
  ]);
  expect(found.saved).toBeGreaterThan(5);
  await core.run(h, "retakes.apply", {});
  expect(await text()).toBe("Welcome to the video. so the next step is to open the settings. then we click on Bluetooth and pair the keyboard. That's all for today.");
  expect((await core.session(h)).features.transcript).not.toHaveProperty("retakes");
  await core.undo(h);
  expect(JSON.stringify(core.doc(h).tracks)).toBe(before);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("keeping an earlier take cuts only what the later one repeats, so what it goes on to say stays; Cut This One cuts one group", async () => {
  const { core, h, text } = await talk("keep");
  await core.run(h, "retakes.review", {});
  const [first] = ((await core.query(h, "transcript.retakes", {})) as Found).groups;
  await core.run(h, "retakes.keep", { at: first!.takes[0]!.start + 0.1 });
  await core.run(h, "retakes.focus", { at: first!.start });
  const kept = (await core.query(h, "transcript.retakes", { kept: [first!.takes[0]!.start + 0.1], current: first!.start })) as Found;
  expect([kept.groups[0]!.best, kept.groups[0]!.by, kept.current]).toEqual([0, "you", 0]);
  await core.run(h, "retakes.apply", { one: true });
  expect(await text()).toBe("Welcome to the video. So the next step is um, to open the settings. Then we click on Bluetooth and then we click on Bluetooth and pair the keyboard. That's all for today.");
  // Still open, on the next group.
  const next = (await core.query(h, "transcript.retakes", ((await core.session(h)).features.transcript as { retakes: object }).retakes)) as Found;
  expect(next.groups.length).toBe(1);
  expect(next.current).toBe(0);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("cutting every take of a line keeps none of it (what the last goes on to say stays); keeping one of its takes again undoes that, and Apply cuts them all", async () => {
  const { core, h, text } = await talk("cut-all");
  await core.run(h, "retakes.review", {});
  const review = async () => ((await core.session(h)).features.transcript as { retakes: object }).retakes;
  const [first, second] = ((await core.query(h, "transcript.retakes", {})) as Found).groups;
  const cutAll = { start: second!.start, end: second!.end, key: second!.key };
  await core.run(h, "retakes.cutAll", cutAll);
  const none = (await core.query(h, "transcript.retakes", await review())) as Found;
  expect(none.groups.map((g) => [g.best, g.by])).toEqual([
    [1, "beacon"],
    [-1, "you"],
  ]);
  // Keeping one of its takes again puts it back to keeping one; Cut All then Keep One comes back to that same take.
  await core.run(h, "retakes.keep", { at: second!.takes[0]!.start + 0.1 });
  expect(((await core.query(h, "transcript.retakes", await review())) as Found).groups[1]!.best).toBe(0);
  await core.run(h, "retakes.cutAll", cutAll);
  await core.run(h, "retakes.cutAll", { ...cutAll, on: false });
  expect(((await core.query(h, "transcript.retakes", await review())) as Found).groups[1]!.best).toBe(0);
  await core.run(h, "retakes.cutAll", cutAll);
  await core.run(h, "retakes.focus", { at: first!.start });
  // Cut This One on the first group: the second, cut whole, moves with the timeline and stays cut whole.
  await core.run(h, "retakes.apply", { one: true });
  expect(((await core.query(h, "transcript.retakes", await review())) as Found).groups.map((g) => g.best)).toEqual([-1]);
  // Undone, the review's times stay moved: they must not make the first line lose every take.
  await core.undo(h);
  expect(((await core.query(h, "transcript.retakes", await review())) as Found).groups[0]!.best).toBeGreaterThanOrEqual(0);
  await core.redo(h);
  await core.run(h, "retakes.apply", {});
  expect(await text()).toBe("Welcome to the video. so the next step is to open the settings. pair the keyboard. That's all for today.");
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("with OpenAI as the judge, its picks are kept once the review asks for them, and applied", async () => {
  const secrets = new Map([["openai-api-key", "sk-test"]]);
  const { core, h, asset, text } = await talk("openai", secrets);
  await core.setPreference("retake-judge", "openai");
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked.push(String(init.body));
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    const groups = body.messages[1]!.content.split("\n\n");
    // Keeps the first take of the Bluetooth line, the last of the others.
    const picks = groups.map((g, n) => ({ group: n + 1, best: /Bluetooth/.test(g) ? 1 : g.split("Take").length - 1, reason: "test" }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ picks }) } }] }));
  }) as typeof fetch;
  await core.run(h, "retakes.review", {});
  const waiting = (await core.query(h, "transcript.retakes", {})) as Found;
  // Until it is judged, Beacon's own picks; it isn't asked on its own.
  expect(waiting.judging).toEqual([asset.id]);
  expect(waiting.groups.map((g) => g.by)).toEqual(["beacon", "beacon"]);
  expect(asked).toEqual([]);
  const job = await core.analyze(h, "retakes", asset.id);
  await job.done;
  expect(asked.length).toBe(1);
  expect(asked[0]).toContain("Take 1: So the next step is um,");
  const judged = (await core.query(h, "transcript.retakes", {})) as Found;
  expect(judged.judging).toEqual([]);
  expect(judged.groups.map((g) => [g.best, g.by, g.reason])).toEqual([
    [1, "openai", "test"],
    [0, "openai", "test"],
  ]);
  await core.run(h, "retakes.apply", {});
  expect(await text()).toBe("Welcome to the video. so the next step is to open the settings. Then we click on Bluetooth and pair the keyboard. That's all for today.");
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("keeping the first of \"click on save / click on save then save\" cuts only the repeat: the second take's own \"then save\" stays", async () => {
  const { core, h, asset, text } = await talk("earliest");
  transcribed(core, asset, said("Now. | Click on save. | click on save then save the file. | Done."));
  await core.run(h, "retakes.review", {});
  const [g] = ((await core.query(h, "transcript.retakes", {})) as Found).groups;
  expect(g!.takes.map((t) => t.text)).toEqual(["Click on save.", "click on save"]);
  await core.run(h, "retakes.keep", { at: g!.takes[0]!.start + 0.1 });
  await core.run(h, "retakes.apply", {});
  expect(await text()).toBe("Now. Click on save. then save the file. Done.");
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("cancelling OpenAI's judging aborts its request", async () => {
  const { core, h, asset } = await talk("cancel", new Map([["openai-api-key", "sk-test"]]));
  await core.setPreference("retake-judge", "openai");
  let signal: AbortSignal | undefined;
  let asked!: () => void;
  const started = new Promise<void>((r) => (asked = r));
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    asked();
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal!.reason)));
  }) as unknown as typeof fetch;
  const job = await core.analyze(h, "retakes", asset.id);
  await started;
  await core.cancelJob(job.id);
  await job.done.catch(() => {});
  expect(signal?.aborted).toBe(true);
  expect((await core.job(job.id)).state).toBe("failed");
  await core.close(h);
}, 60_000);
