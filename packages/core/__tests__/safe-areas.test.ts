import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-safe-areas-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Check = { layout: string; clean: boolean; issues: { clip: string; type: string; zone: string; from: number; to: number }[] };

test.skipIf(!existsSync(AUDIO))("a 9:16 Short's captions under TikTok's caption band are flagged, clean once moved up; a callout under the action rail too; the layout shown is kept with the project", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const path = join(dir, "short.beproj");
  const h = await core.create({ path, settings: { width: 1080, height: 1920 } });
  const copy = join(dir, "voice.m4a");
  copyFileSync(AUDIO, copy);
  const r = await core.import(h, [copy], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const words = "So this is a short about safe areas and where captions should go".split(" ").map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.4 + i * 0.5, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: [[1, 8]] } } }));
  await core.run(h, "captions.create", {});

  // Only a layout for the canvas's shape.
  await expect(core.run(h, "safeAreas.show", { layout: "youtube" })).rejects.toThrow(/16:9 canvas; this one is 9:16/);
  await core.run(h, "safeAreas.show", { layout: "tiktok" });
  const layouts = (await core.query(h, "safeAreas.layouts", {})) as { id: string; fits: boolean; zones: { id: string; rect: number[] }[] }[];
  expect(layouts.filter((l) => l.fits).map((l) => l.id)).toEqual(["tiktok", "reels", "shorts"]);
  expect(layouts.find((l) => l.id === "tiktok")!.zones.find((z) => z.id === "bottom")!.rect.map(Math.round)).toEqual([0, 1574, 1080, 1920]);

  // The default captions sit low, under TikTok's username and caption and beside its rail, which reaches down to them: every caption, for as long as it shows.
  const captions = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "caption");
  expect(captions.length).toBeGreaterThan(2);
  const low = (await core.query(h, "safeAreas.check", {})) as Check;
  expect([low.layout, low.clean]).toEqual(["tiktok", false]);
  expect(new Set(low.issues.map((i) => `${i.type}:${i.zone}`))).toEqual(new Set(["caption:bottom", "caption:rail"]));
  expect([...new Set(low.issues.filter((i) => i.zone === "bottom").map((i) => i.clip))].sort()).toEqual(captions.map((c) => c.id).sort());
  const first = captions.sort((a, b) => a.start - b.start)[0]!;
  const issue = low.issues.find((i) => i.clip === first.id)!;
  expect(issue.from).toBeCloseTo(first.start / 705_600_000, 2);
  // Another layout can be checked without showing it.
  expect(((await core.query(h, "safeAreas.check", { layout: "shorts" })) as Check).issues.every((i) => i.zone === "bottom")).toBe(true);

  // In the middle the wider ones reach the action rail, which starts halfway down; a little higher, clean.
  await core.run(h, "captions.style", { style: { anchorY: "middle", offsetY: 0 } });
  expect(new Set(((await core.query(h, "safeAreas.check", {})) as Check).issues.map((i) => i.zone))).toEqual(new Set(["rail"]));
  await core.run(h, "captions.style", { style: { anchorY: "middle", offsetY: -300 } });
  expect(((await core.query(h, "safeAreas.check", {})) as Check).clean).toBe(true);

  // A text annotation low on the right, where the action rail is.
  const added = (await core.run(h, "edit.addAnnotation", { preset: "text", time: 1 })) as { results: unknown[] };
  expect(added.results.length).toBeGreaterThan(0);
  const text = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "callout")!;
  await core.run(h, "clip.set", { clips: [text.id], props: { transform: { x: 380, y: -150 } } });
  const rail = (await core.query(h, "safeAreas.check", {})) as Check;
  expect(rail.issues.filter((i) => i.clip === text.id).map((i) => i.zone)).toContain("rail");

  // Kept with the project, not as an edit.
  const undo = (await core.history(h)).undo.length;
  expect(existsSync(join(path, "editor.json"))).toBe(true);
  await core.close(h);
  const again = await core.open(path);
  expect((await core.session(again)).features["safe-areas"]).toEqual({ layout: "tiktok" });
  expect((await core.history(again)).undo.length).toBeLessThanOrEqual(undo);
  await core.run(again, "safeAreas.show", { layout: null });
  expect(existsSync(join(path, "editor.json"))).toBe(false);
  await core.close(again);
}, 60_000);

test("callouts inside groups are checked where the group puts them, and a callout that passes under a zone for a few frames is caught", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-g") });
  const h = await core.create({ path: join(dir, "grouped.beproj"), settings: { width: 1080, height: 1920 } });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 4 });
  const text = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "callout")!;
  const rail = async () => ((await core.query(h, "safeAreas.check", { layout: "tiktok" })) as Check).issues.filter((i) => i.zone === "rail");
  // Clear of the action rail, then a tenth of a second over it, then back.
  await core.run(h, "clip.set", { clips: [text.id], props: { callout: { width: 300 }, transform: { x: -100, y: -150 } } });
  expect(await rail()).toEqual([]);
  await core.run(h, "animation.add", { clip: text.id, end: 1.1, duration: 0.1, to: { "transform.x": 380 } });
  await core.run(h, "animation.add", { clip: text.id, end: 1.2, duration: 0.1, to: { "transform.x": -100 } });
  const brief = await rail();
  expect(brief.length).toBe(1);
  expect(brief[0]!.from).toBeGreaterThan(1);
  expect(brief[0]!.to).toBeLessThan(1.25);
  await core.undo(h);
  await core.undo(h);

  // Under the rail, then grouped: still under it; the group moved left, clear of it.
  await core.run(h, "clip.set", { clips: [text.id], props: { transform: { x: 380 } } });
  expect((await rail()).map((i) => i.clip)).toEqual([text.id]);
  const group = (await core.run(h, "clip.group", { clips: [text.id] })).results[0] as string;
  expect((await rail()).map((i) => i.clip)).toEqual([text.id]);
  await core.run(h, "clip.set", { clips: [group], props: { transform: { x: -480 } } });
  expect(await rail()).toEqual([]);
  await core.close(h);
});

test("the safe areas kept with a project replace a link left where editor.json goes, never writing through it", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-l") });
  const path = join(dir, "linked.beproj");
  const h = await core.create({ path, settings: { width: 1080, height: 1920 } });
  const target = join(dir, "precious.txt");
  writeFileSync(target, "keep me");
  symlinkSync(target, join(path, "editor.json"));
  await core.run(h, "safeAreas.show", { layout: "reels" });
  expect(readFileSync(target, "utf8")).toBe("keep me");
  expect(lstatSync(join(path, "editor.json")).isSymbolicLink()).toBe(false);
  expect(JSON.parse(readFileSync(join(path, "editor.json"), "utf8"))).toEqual({ features: { "safe-areas": { layout: "reels" } } });
  await core.close(h);
});

test("the key hides parts of the safe areas: kept with the project and across platforms, one at a time, back with another click", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-k") });
  const path = join(dir, "key.beproj");
  const h = await core.create({ path, settings: { width: 1080, height: 1920 } });
  await expect(core.run(h, "safeAreas.toggle", { part: "eyeLine" })).rejects.toThrow("no safe areas are shown");
  await core.run(h, "safeAreas.show", { layout: "tiktok" });
  await core.run(h, "safeAreas.toggle", { part: "eyeLine" });
  await core.run(h, "safeAreas.toggle", { part: "headroom" });
  await core.run(h, "safeAreas.show", { layout: "reels" });
  expect((await core.session(h)).features["safe-areas"]).toEqual({ layout: "reels", hidden: ["headroom", "eyeLine"] });
  await core.run(h, "safeAreas.toggle", { part: "headroom" });
  await core.run(h, "safeAreas.toggle", { part: "eyeLine", shown: false });
  expect(JSON.parse(readFileSync(join(path, "editor.json"), "utf8"))).toEqual({ features: { "safe-areas": { layout: "reels", hidden: ["eyeLine"] } } });
  await core.close(h);
  const again = await core.open(path);
  expect((await core.session(again)).features["safe-areas"]).toEqual({ layout: "reels", hidden: ["eyeLine"] });
  await core.run(again, "safeAreas.toggle", { part: "eyeLine" });
  expect(JSON.parse(readFileSync(join(path, "editor.json"), "utf8"))).toEqual({ features: { "safe-areas": { layout: "reels" } } });
  await core.close(again);
});
