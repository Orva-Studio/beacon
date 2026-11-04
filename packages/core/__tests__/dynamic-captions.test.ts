import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-dynamic-captions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Lit pixels (any channel over half) in a PNG, decoded by Beacon's FFmpeg. */
async function lit(png: Uint8Array) {
  const path = join(dir, "frame.png");
  writeFileSync(path, png);
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  const data = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! > 128 || data[i + 1]! > 128 || data[i + 2]! > 128) n++;
  return n;
}

test.skipIf(!existsSync(AUDIO))("Dynamic Captions: with word-by-word reveal a word is drawn only once it is said; keywords and a look change what is drawn, classic captions draw as before", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  copyFileSync(AUDIO, join(dir, "talk.m4a"));
  const r = await core.import(h, [join(dir, "talk.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const words = ["Especially", "with", "AI-generated", "content"].map((text, i) => ({ text, start: 0.2 + i * 0.5, end: 0.6 + i * 0.5, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
  const [id] = (await core.run(h, "captions.create", { maxWords: 4 })).results[0] as string[];
  const at = async (t: number) => lit((await core.frame(h, t, { width: 640 })).png);

  // Classic: every word is there from the start (the highlight only moves).
  const classic = [await at(0.3), await at(1.8)];
  expect(Math.abs(classic[0]! - classic[1]!) / classic[1]!).toBeLessThan(0.15);

  await core.run(h, "captions.style", { style: { reveal: "word", background: [0, 0, 0, 0] } });
  const one = await at(0.45);
  const four = await at(1.9);
  expect(one).toBeGreaterThan(0);
  expect(four).toBeGreaterThan(one * 2.5);

  // A keyword in the headline layout is big, on a line of its own: more is drawn.
  await core.run(h, "caption.emphasize", { clip: id, text: "AI-generated" });
  const plain = four;
  await core.run(h, "captions.style", { style: { layout: "headline", emphasis: { scale: 2 } } });
  expect(await at(1.9)).toBeGreaterThan(plain * 1.4);
  const layout = (await core.query(h, "captions.layout", { clip: id })) as { lines: { start: number; end: number }[]; text: string };
  expect(layout.lines.map((l) => layout.text.slice(l.start, l.end))).toEqual(["Especially with", "AI-generated", "content"]);

  // Two words to a line; stretched, each line fills the width (wider than laid out plainly).
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === id))!.id;
  await core.run(h, "captions.style", { style: { layout: "line", lineWords: 2 }, track });
  const two = (await core.query(h, "captions.layout", { clip: id })) as { lines: { start: number; end: number; carets: number[] }[]; text: string; box: { width: number } };
  expect(two.lines.map((l) => two.text.slice(l.start, l.end))).toEqual(["Especially with", "AI-generated content"]);
  await core.run(h, "captions.style", { style: { stretch: true, maxWidth: 0.9 }, track });
  const wide = (await core.query(h, "captions.layout", { clip: id })) as { box: { width: number } };
  expect(wide.box.width).toBeGreaterThan(two.box.width * 1.1);
  expect(wide.box.width).toBeLessThanOrEqual(1920 * 0.9 + 60);

  // Drop Shadow dropped on a caption turns on its track's shadow (angle and distance included) and shows it.
  await core.run(h, "edit.addEffect", { type: "drop-shadow", clip: id });
  expect(core.doc(h).tracks.find((t) => t.id === track)!.props!.captionStyle).toMatchObject({ shadow: [0, 0, 0, 0.6], shadowAngle: 5.49779, shadowDistance: 8 });
  expect(core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.effects).toEqual([]);
  expect((await core.session(h)).inspector).toBe("caption");
  // Where there is no such way, it says what it is for.
  const sound = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "audio")!;
  await expect(core.run(h, "edit.addEffect", { type: "drop-shadow", clip: sound.id })).rejects.toThrow("Drop Shadow doesn't apply to audio clips");

  // A look sets everything at once; the preset list says which are for headlines.
  const presets = (await core.query(h, "captions.presets")) as { id: string; headline: boolean }[];
  expect(presets.filter((p) => p.headline).map((p) => p.id)).toEqual(["editorial-headline", "headline", "headline-glow"]);
  await core.run(h, "captions.preset", { preset: "word-pop", track });
  expect(core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === id))!.props!.captionStyle).toMatchObject({ reveal: "word", enter: "pop", uppercase: true, layout: "line" });
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(AUDIO))("headlines: a Headlines track at the top, the keyword big, the captions' line stepping aside while one shows; the review's ticked ones added in one undo step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache2"), configDir: join(dir, "config2") });
  const h = await core.create({ path: join(dir, "h.beproj") });
  copyFileSync(AUDIO, join(dir, "talk2.m4a"));
  const r = await core.import(h, [join(dir, "talk2.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const asset = core.doc(h).assets[r.assets[0]!]!;
  const said = "This is a huge concern. My grandma scrolls on Facebook for five hours a day.".split(" ");
  const words = said.map((text, i) => ({ text, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4, p: 1 }));
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(asset, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words, speech: words.map((w) => [w.start, w.end]) } } }));
  await core.run(h, "captions.create", { maxWords: 3 });
  const tracks = () => core.doc(h).tracks;
  const lineOnly = async (t: number) => lit((await core.frame(h, t, { width: 640 })).png);
  const before = await lineOnly(1.1);
  expect(before).toBeGreaterThan(0);

  const id = (await core.run(h, "headline.add", { from: 0, to: 2, keyword: "huge concern", side: "left" })).results[0] as string;
  const top = tracks().at(-1)!;
  expect(top.name).toBe("Headlines");
  expect(top.props!.captionStyle).toMatchObject({ layout: "headline", anchorX: "left" });
  const shown = (top.clips.find((c) => c.id === id)!.props.caption as { words: { text: string; em?: boolean }[] }).words;
  expect(shown.filter((w) => w.em).map((w) => w.text)).toEqual(["huge", "concern."]);
  // The captions' line steps aside for it, and is back with the headline's track hidden.
  expect(await lineOnly(1.1)).not.toBe(before);
  await core.run(h, "track.set", { track: top.id, hidden: true });
  expect(await lineOnly(1.1)).toBe(before);
  await core.run(h, "track.set", { track: top.id, hidden: false });
  // Not in the .srt: headlines repeat the line's words.
  expect((await core.query(h, "captions.srt")) as string).not.toContain("huge concern. My");

  // The review: two found, one left out, Apply adds the other as one undo step and closes it.
  const steps = (await core.history(h)).undo.length;
  await core.run(h, "headlines.review", { items: [{ from: 0.2, to: 1.7, text: "This is a huge concern.", keyword: "huge concern" }, { from: 1.8, to: 5.7, text: "My grandma scrolls on Facebook for five hours a day.", keyword: "five hours" }] });
  await core.run(h, "headlines.review", { off: { index: 0, off: true } });
  await core.run(h, "headlines.apply", {});
  expect((await core.history(h)).undo.length).toBe(steps + 1);
  expect(await core.query(h, "headlines.review")).toBeNull();
  const heads = tracks().find((t) => t.name === "Headlines")!.clips;
  expect(heads).toHaveLength(2);
  expect((heads[1]!.props.caption as { words: { text: string; em?: boolean }[] }).words.filter((w) => w.em).map((w) => w.text)).toEqual(["five", "hours"]);
  // A headline made from a caption of the line takes its keywords.
  const line = tracks().find((t) => t.name === "Captions")!.clips[0]!;
  await core.run(h, "caption.emphasize", { clip: line.id, text: "is" });
  await core.run(h, "headline.fromCaption", { clip: line.id });
  const made = tracks().find((t) => t.name === "Headlines")!.clips[0]!;
  expect((made.props.caption as { words: { text: string; em?: boolean }[] }).words.filter((w) => w.em).map((w) => w.text)).toEqual(["is"]);
  await core.close(h);
}, 60_000);
