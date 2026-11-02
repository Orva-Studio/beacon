import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-export-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(AUDIO))("an export writes the captions' .srt beside it only when asked for (`files`)", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  copyFileSync(AUDIO, join(dir, "talk.m4a"));
  const r = await core.import(h, [join(dir, "talk.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const words = ["One", "two", "three", "four"].map((text, i) => ({ text, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
  await core.run(h, "captions.create", { maxWords: 2 });

  await (await core.export(h, { output: join(dir, "plain.wav"), from: 0, to: 2 })).done;
  expect(existsSync(join(dir, "plain.wav"))).toBe(true);
  expect(existsSync(join(dir, "plain.srt"))).toBe(false);
  await (await core.export(h, { output: join(dir, "with.wav"), from: 0, to: 2, files: ["captions"] })).done;
  expect(readFileSync(join(dir, "with.srt"), "utf8")).toContain("One two");
  await core.close(h);
}, 60_000);
