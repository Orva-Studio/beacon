import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEvent } from "../src/api";
import type { Decision } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-memory-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const decided = (project: string, rule: string, choice: string, format: "short" | "long", value?: number): Decision => ({ rule, choice, flipped: false, ...(value === undefined ? {} : { value }), format, project, at: Date.now() });

test("Memory keeps the user's sentences and agents' proposals until accepted, lists what was learned per format, and forgets a habit's decisions or all of them", async () => {
  const configDir = join(dir, "config");
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir });
  const told: AppEvent[] = [];
  core.watchApp((e) => void (e.kind === "memory" && told.push(e)));
  // A new user: learning on, nothing kept.
  const md = join(configDir, "memory.md");
  expect(await core.memory()).toEqual({ learning: true, sentences: [], proposals: [], file: md, habits: { short: [], long: [] }, decisions: 0 });

  let m = await core.memoryChange({ add: { text: "No B-roll in the intro" } });
  m = await core.memoryChange({ add: { text: "Captions at the top", format: "short" } });
  expect(m.sentences.map((s) => [s.text, s.format])).toEqual([["No B-roll in the intro", undefined], ["Captions at the top", "short"]]);
  const [intro, captions] = m.sentences;
  m = await core.memoryChange({ edit: { id: intro!.id, text: "No B-roll in the first 10 seconds", format: "long" } });
  m = await core.memoryChange({ edit: { id: captions!.id, text: "Captions at the top", format: null } });
  // In memory.md's order: every video, then Shorts, then long videos.
  expect(m.sentences.map((s) => [s.text, s.format])).toEqual([["Captions at the top", undefined], ["No B-roll in the first 10 seconds", "long"]]);
  // An id comes from the line, so a changed one has a new id.
  expect(m.sentences[0]!.id).not.toBe(captions!.id);
  m = await core.memoryChange({ remove: m.sentences[0]!.id });
  expect(m.sentences.length).toBe(1);
  await expect(core.memoryChange({ remove: "nope" })).rejects.toThrow('no sentence "nope"');

  // An agent proposes; the same twice, or one already said, isn't kept twice; only accepted is it memory.
  m = await core.memoryChange({ propose: { text: "Zoom in on code" } });
  m = await core.memoryChange({ propose: { text: "zoom in on code" } });
  m = await core.memoryChange({ propose: { text: "No B-roll in the first 10 seconds" } });
  m = await core.memoryChange({ propose: { text: "Cut every um", format: "short" } });
  expect(m.proposals.map((p) => p.text)).toEqual(["Zoom in on code", "Cut every um"]);
  m = await core.memoryChange({ accept: m.proposals[0]!.id });
  m = await core.memoryChange({ dismiss: m.proposals[0]!.id });
  expect(m.proposals).toEqual([]);
  expect(m.sentences.map((s) => s.text)).toEqual(["Zoom in on code", "No B-roll in the first 10 seconds"]);
  // The sentences are memory.md, by kind of video, for the user to read and edit anywhere; proposals stay in memory.json.
  expect(readFileSync(md, "utf8")).toContain("## Every video\n- Zoom in on code\n\n## Shorts\n\n## Long videos\n- No B-roll in the first 10 seconds\n");
  expect(JSON.parse(readFileSync(join(configDir, "memory.json"), "utf8")).sentences).toBeUndefined();

  // A hand edit: a list marker or none, a heading of its own, a comment; read as written, its layout kept until Beacon changes a sentence.
  const hand = "# My memory\n<!-- mine -->\nNo music under the demo\n\n## Shorts only\n* Captions at the top\n1. Hook in 2 seconds\n## Notes\n- Zoom in on code\n";
  writeFileSync(md, hand);
  m = await core.memory();
  expect(m.sentences.map((s) => [s.text, s.format])).toEqual([["No music under the demo", undefined], ["Captions at the top", "short"], ["Hook in 2 seconds", "short"], ["Zoom in on code", undefined]]);
  const hook = m.sentences[2]!.id;
  expect((await core.memory()).sentences[2]!.id).toBe(hook);
  await core.memoryChange({ learning: true });
  expect(readFileSync(md, "utf8")).toBe(hand);
  m = await core.memoryChange({ edit: { id: hook, text: "Hook in 3 seconds" } });
  expect(readFileSync(md, "utf8")).toContain("## Shorts\n- Captions at the top\n- Hook in 3 seconds\n");
  m = await core.memoryChange({ remove: m.sentences.find((s) => s.text === "No music under the demo")!.id });
  m = await core.memoryChange({ remove: m.sentences.find((s) => s.text.startsWith("Captions"))!.id });
  m = await core.memoryChange({ remove: m.sentences.find((s) => s.text.startsWith("Hook"))!.id });
  expect(m.sentences.map((s) => s.text)).toEqual(["Zoom in on code"]);

  // Habits from decisions: kept "um" in long videos over two projects, cut pauses over 1 s in Shorts.
  writeFileSync(join(configDir, "decisions.json"), JSON.stringify([
    ...["a", "b"].flatMap((p) => [decided(p, "filler:um", "keep", "long"), decided(p, "filler:um", "keep", "long"), decided(p, "filler:um", "keep", "long")]),
    ...["c", "d"].flatMap((p) => [decided(p, "silence", "keep", "short", 0.6), decided(p, "silence", "cut", "short", 1.4), decided(p, "silence", "cut", "short", 1.8)]),
  ]));
  m = await core.memory();
  expect(m.decisions).toBe(12);
  // A format with too few of its own learns from every format's: long videos have the Shorts' pauses, and Shorts the fillers.
  expect(m.habits.long.map((h) => [h.id, h.text, h.agree, h.of, h.format])).toEqual([
    ["silence", "Remove Silences finds pauses longer than 1 s: you cut those and keep shorter ones", 6, 6, undefined],
    ["filler:um", 'Remove Filler Words keeps "um"', 6, 6, "long"],
  ]);
  expect(m.habits.short.map((h) => [h.id, h.format])).toEqual([["silence", "short"], ["filler:um", undefined]]);
  // Forgetting the Shorts' pauses leaves the fillers.
  m = await core.memoryChange({ forget: { rules: ["silence"], format: "short" } });
  expect(m.decisions).toBe(6);
  expect(m.habits.short.map((h) => h.id)).toEqual(["filler:um"]);
  expect(m.habits.long.map((h) => h.id)).toEqual(["filler:um"]);
  m = await core.memoryChange({ forget: "all" });
  expect(m.decisions).toBe(0);
  expect(m.habits).toEqual({ short: [], long: [] });
  // Each change is told, for the open windows.
  expect(told.length).toBeGreaterThan(10);
});

test("sentences kept in memory.json before memory.md move there on the next change, proposals and learning with them", async () => {
  const configDir = join(dir, "old-config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "memory.json"), JSON.stringify({ learning: false, sentences: [{ id: "a1", text: "Captions at the top", format: "short", by: "you", at: 1 }], proposals: [{ id: "p1", text: "Zoom in on code", by: "agent", at: 2 }] }));
  const core = new LocalCore({ cacheDir: join(dir, "old-cache"), configDir });
  expect((await core.memory()).sentences.map((s) => [s.text, s.format])).toEqual([["Captions at the top", "short"]]);
  const m = await core.memoryChange({ learning: true });
  expect(m.sentences.map((s) => s.text)).toEqual(["Captions at the top"]);
  expect(m.proposals.map((p) => p.text)).toEqual(["Zoom in on code"]);
  expect(readFileSync(join(configDir, "memory.md"), "utf8")).toContain("## Shorts\n- Captions at the top\n");
  expect(JSON.parse(readFileSync(join(configDir, "memory.json"), "utf8"))).toEqual({ learning: true, proposals: [{ id: "p1", text: "Zoom in on code", at: 2 }] });
});

test.skipIf(!existsSync(AUDIO))("with learning off, a review opens with Beacon's defaults and its choices aren't kept; on again, it learns", async () => {
  const configDir = join(dir, "off-config");
  const core = new LocalCore({ cacheDir: join(dir, "off-cache"), configDir });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "decisions.json"), JSON.stringify(["a", "b"].flatMap((p) => [decided(p, "silence", "keep", "long", 0.8), decided(p, "silence", "keep", "long", 0.8), decided(p, "silence", "cut", "long", 1.6)])));
  const h = await core.create({ path: join(dir, "off.beproj") });
  copyFileSync(AUDIO, join(dir, "off.m4a"));
  const r = await core.import(h, [join(dir, "off.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const words = ["One", "two", "three", "four"].map((text, i) => ({ text, start: 1 + i * 2, end: 1.4 + i * 2, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
  const review = async () => ((await core.session(h)).features.transcript as { silences?: { min: number; learned?: string[] } }).silences;

  await core.run(h, "silences.review", {});
  expect((await review())?.min).toBe(1.2);
  await core.run(h, "silences.close", {});
  await core.memoryChange({ learning: false });
  await core.run(h, "silences.review", {});
  expect(await review()).toMatchObject({ min: 0.6 });
  expect((await review())?.learned).toBeUndefined();
  await core.run(h, "silences.apply", { all: true });
  expect((await core.memory()).decisions).toBe(6);
  await core.memoryChange({ learning: true });
  await core.undo(h);
  await core.run(h, "silences.review", {});
  expect((await review())?.min).toBe(1.2);
  // An Apply undone wasn't the user's choice: its decisions go with it, and come back on redo.
  await core.run(h, "silences.review", { min: 0.6 });
  await core.run(h, "silences.apply", { all: true });
  const applied = (await core.memory()).decisions;
  expect(applied).toBeGreaterThan(6);
  await core.undo(h);
  expect((await core.memory()).decisions).toBe(6);
  await core.redo(h);
  expect((await core.memory()).decisions).toBe(applied);
  // Choices that can't be kept don't undo the cut or leave the review open: it's said, not thrown.
  await core.undo(h);
  rmSync(join(configDir, "decisions.json"));
  mkdirSync(join(configDir, "decisions.json"));
  await core.run(h, "silences.review", { min: 0.6 });
  const result = await core.run(h, "silences.apply", { all: true });
  expect(result.diff.at(-1)).toContain("weren't kept");
  expect(await review()).toBeUndefined();
  await core.close(h);
});
