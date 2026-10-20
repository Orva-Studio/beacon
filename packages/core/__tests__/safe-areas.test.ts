import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  expect(layouts.find((l) => l.id === "tiktok")!.zones.find((z) => z.id === "bottom")!.rect).toEqual([0, 1260, 1080, 1920]);

  // The default captions sit low, under TikTok's username and caption: every caption, for as long as it shows.
  const captions = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "caption");
  expect(captions.length).toBeGreaterThan(2);
  const low = (await core.query(h, "safeAreas.check", {})) as Check;
  expect([low.layout, low.clean]).toEqual(["tiktok", false]);
  expect(new Set(low.issues.map((i) => `${i.type}:${i.zone}`))).toEqual(new Set(["caption:bottom"]));
  expect(low.issues.map((i) => i.clip).sort()).toEqual(captions.map((c) => c.id).sort());
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
