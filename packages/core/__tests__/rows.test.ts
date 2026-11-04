import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "take.brec");
const dir = mkdtempSync(join(tmpdir(), "beacon-rows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(TAKE))("rows: a clip added with no track goes on the lowest row free then above what shows; Tidy Rows packs rows never on together, drawing every frame the same, in one undo step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  cpSync(TAKE, join(dir, "take.brec"), { recursive: true });
  const h = await core.create({ path: join(dir, "rows.beproj") });
  const r = await core.import(h, [join(dir, "take.brec")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const tracks = () => core.doc(h).tracks;
  const media = tracks().length;
  // As an agent does: a row of its own for each title, at different times, and two titles showing together.
  const title = async (start: number, track?: string) => {
    const text = core.registry.annotations.get("text")!;
    const callout = structuredClone(text.props.callout) as { text: { text: string } };
    callout.text.text = `At ${start}`;
    const args = { type: text.type ?? "callout", start, duration: 1, props: { ...structuredClone(text.props), callout } };
    return (await core.run(h, "clip.add", track ? { ...args, track } : args)).results[0] as string;
  };
  for (const at of [0.5, 2, 3.5]) {
    const t = (await core.run(h, "track.add", { name: `Title ${at}` })).results[0] as string;
    await title(at, t);
  }
  const under = (await core.run(h, "track.add", { name: "Box" })).results[0] as string;
  const over = (await core.run(h, "track.add", { name: "Box text" })).results[0] as string;
  const box = await title(5, under);
  const boxText = await title(5, over);
  expect(tracks().length).toBe(media + 5);

  // With no track: above everything on at 2 s, on the first row free then (Title 3.5's), no new row.
  const placed = await title(2.2);
  const at = tracks().findIndex((t) => t.clips.some((c) => c.id === placed));
  expect(tracks()[at]!.name).toBe("Title 3.5");
  expect(tracks().length).toBe(media + 5);
  // At 5 s every row up to Box text is on: a new row on top.
  const top = await title(5.2);
  expect(tracks().at(-1)!.clips.map((c) => c.id)).toEqual([top]);

  const times = [0.6, 2.1, 2.3, 3.6, 5.1, 5.3];
  const shots = async () => Promise.all(times.map(async (t) => Buffer.from((await core.frame(h, t, { width: 320 })).png).toString("base64")));
  const before = await shots();
  const steps = (await core.history(h)).undo.length;
  const result = (await core.run(h, "track.tidy", {})).results[0] as { before: number; after: number };
  expect(result.after).toBeLessThan(result.before);
  // Six rows of titles become three: those never on together share one; a box and its text, on together, stay on
  // two in their order; the recording's rows keep only the recording.
  expect(result).toEqual({ before: media + 6, after: media + 3 });
  const row = (id: string) => tracks().findIndex((t) => t.clips.some((c) => c.id === id));
  const text = (start: number) => tracks().flatMap((t) => t.clips).find((c) => (c.props.callout as { text?: { text: string } } | undefined)?.text?.text === `At ${start}`)!.id;
  expect(row(text(0.5))).toBe(row(text(2)));
  expect(row(box)).toBeLessThan(row(boxText));
  for (const t of tracks().slice(0, media)) expect(t.clips.every((c) => c.type !== "callout")).toBe(true);
  expect(await shots()).toEqual(before);
  expect((await core.history(h)).undo.length).toBe(steps + 1);
  await core.undo(h);
  expect(tracks().length).toBe(result.before);
  await core.close(h);
}, 120_000);
