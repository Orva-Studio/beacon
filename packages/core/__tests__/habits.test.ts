import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-habits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Words 0.4 s long, 0.1 s apart; "|" a pause of 0.7 s more, "||" one of 1.5 s more. */
function said(lines: string) {
  const words: { text: string; start: number; end: number; p: number }[] = [];
  let t = 1;
  for (const w of lines.split(" ")) {
    if (w === "|" || w === "||") {
      t += w === "|" ? 0.7 : 1.5;
      continue;
    }
    words.push({ text: w, start: Number(t.toFixed(3)), end: Number((t + 0.4).toFixed(3)), p: 1 });
    t += 0.5;
  }
  return words;
}

/** Projects made by one user: one config folder, so their decisions are shared. */
function user(name: string) {
  const core = new LocalCore({ cacheDir: join(dir, `${name}-cache`), configDir: join(dir, `${name}-config`) });
  let n = 0;
  const project = async (lines: string, short = false) => {
    const path = join(dir, `${name}-${++n}`);
    const h = await core.create({ path: `${path}.beproj`, ...(short ? { settings: { width: 1080, height: 1920 } } : {}) });
    copyFileSync(AUDIO, `${path}.m4a`);
    const r = await core.import(h, [`${path}.m4a`], { at: 0 });
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
    const asset = core.doc(h).assets[r.assets[0]!]!;
    const file = new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!);
    mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
    const words = said(lines);
    writeFileSync(file, JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
    return h;
  };
  return { core, project };
}

type Review = { learned?: string[]; keep?: string[]; min?: number; prefer?: string };
const review = async (core: LocalCore, h: Awaited<ReturnType<LocalCore["create"]>>, key: string) =>
  ((await core.session(h)).features.transcript as Record<string, Review | undefined>)[key];

/** A review's state, as its panel queries with it. */
const asked = async (core: LocalCore, h: Awaited<ReturnType<LocalCore["create"]>>, key: string) => (await review(core, h, key)) ?? {};

// Short pauses ("|", 0.8 s of silence) between sentences, long ones ("||", 1.6 s) between parts.
const PAUSES = "This is the first part. | It has two sentences. || This is the second part. | It has two too. || And the end. | Done now.";

test.skipIf(!existsSync(AUDIO))("Remove Silences learns the shortest pause the user cuts: those they keep and those they cut, over two projects, set where the review opens and said why", async () => {
  const { core, project } = user("silences");
  type Found = { silences: { start: number; end: number }[] };
  // Cuts the long pauses only, then closes: the short ones before the last cut were kept.
  const cutLong = async (h: Awaited<ReturnType<typeof project>>) => {
    await core.run(h, "silences.review", { min: 0.6, keep: 0.3 });
    const long = ((await core.query(h, "transcript.silences", { min: 0.6, keep: 0.3 })) as Found).silences.filter((s) => s.end - s.start > 1.2 && s.end - s.start < 2);
    expect(long.length).toBe(2);
    for (const s of long) await core.run(h, "silences.select", { at: (s.start + s.end) / 2, add: true });
    await core.run(h, "silences.apply", {});
    await core.run(h, "silences.close", {});
  };
  await cutLong(await project(PAUSES));
  // One project: four decisions, not a habit.
  const one = await project(PAUSES);
  await core.run(one, "silences.review", {});
  expect((await review(core, one, "silences"))?.learned).toBeUndefined();
  await core.run(one, "silences.close", {});
  await cutLong(one);
  const saved = (await Bun.file(join(dir, "silences-config", "decisions.json")).json()) as Decision[];
  // The quiet second before the first word was left too.
  expect(saved.map((d) => `${d.choice} ${d.value}`)).toEqual(["cut 1.6", "cut 1.6", "keep 1", "keep 0.8", "keep 0.8", "cut 1.6", "cut 1.6", "keep 1", "keep 0.8", "keep 0.8"]);
  // Learned: pauses up to 1 s kept, 1.6 s cut, so longer than 1.3 s is found.
  const next = await project(PAUSES);
  await core.run(next, "silences.review", {});
  expect(await review(core, next, "silences")).toMatchObject({ min: 1.3, learned: ["Longer than 1.3 s: you cut pauses longer than this and keep shorter ones in long videos (10 of 10)"] });
  // The two long pauses, and the quiet after the last word.
  expect(((await core.query(next, "transcript.silences", {})) as Found).silences.length).toBe(3);
  // Moved from it, the review no longer says why.
  await core.run(next, "silences.review", { min: 0.6 });
  expect((await review(core, next, "silences"))?.learned).toBeUndefined();
  // Closed without cutting anything: nothing recorded.
  await core.run(next, "silences.close", {});
  expect(((await Bun.file(join(dir, "silences-config", "decisions.json")).json()) as Decision[]).length).toBe(10);
});

// Three lines each said twice.
const RETAKES = "So the first step is | so the first step is to open the settings. | Then we click on Bluetooth | then we click on Bluetooth and pair it. | And that is how | and that is how it is done.";

test.skipIf(!existsSync(AUDIO))("Remove Retakes learns which take the user keeps: the first, kept by hand over two projects, is kept where they don't choose", async () => {
  const { core, project } = user("retakes");
  type Found = { groups: { takes: { start: number; text: string }[]; best: number; by: string }[] };
  const keepFirst = async (h: Awaited<ReturnType<typeof project>>) => {
    await core.run(h, "retakes.review", {});
    const found = (await core.query(h, "transcript.retakes", {})) as Found;
    expect(found.groups.map((g) => g.best)).toEqual([1, 1, 1]);
    for (const g of found.groups) await core.run(h, "retakes.keep", { at: g.takes[0]!.start + 0.1 });
    await core.run(h, "retakes.apply", {});
  };
  await keepFirst(await project(RETAKES));
  await keepFirst(await project(RETAKES));
  const next = await project(RETAKES);
  await core.run(next, "retakes.review", {});
  const r = (await review(core, next, "retakes"))!;
  expect(r).toMatchObject({ prefer: "first", learned: ["Keeps the first take: you usually keep the first one said in long videos (6 of 6)"] });
  const found = (await core.query(next, "transcript.retakes", await asked(core, next, "retakes"))) as Found;
  expect(found.groups.map((g) => [g.best, g.by])).toEqual([[0, "habit"], [0, "habit"], [0, "habit"]]);
  // What the review shows is what Apply keeps.
  await core.run(next, "retakes.apply", {});
  const text = ((await core.query(next, "transcript.get", { format: "words" })) as { text: string }[]).map((w) => w.text).join(" ");
  // The second takes' repeats go; what each went on to say stays.
  expect(text).toBe("So the first step is to open the settings. Then we click on Bluetooth and pair it. And that is how it is done.");
  // An agent's transcript_removeRetakes, not given `prefer`, keeps the same takes.
  const agent = await project(RETAKES);
  await core.run(agent, "transcript.removeRetakes", { minWords: 3, within: 30 });
  expect(((await core.query(agent, "transcript.get", { format: "words" })) as { text: string }[]).map((w) => w.text).join(" ")).toBe(text);
});
