import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { draggedPaths, findDroppedFile } from "@beacon/media";
import { secondsToTicks } from "@beacon/model";
import { findDropped, importDropped, LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-dropped-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a file dropped from a drive Spotlight doesn't index is found among the drag's own paths, by name, size and date", () => {
  const clip = join(dir, "CARD", "DCIM", "107_PANA", "P1078391.MP4");
  mkdirSync(join(clip, ".."), { recursive: true });
  writeFileSync(clip, "clip");
  const other = join(dir, "P1078391.MP4");
  writeFileSync(other, "another clip");
  const s = statSync(clip);
  const dropped = { name: "P1078391.MP4", size: s.size, lastModified: s.mtimeMs };
  expect(findDroppedFile(dropped, [other, clip])).toBe(clip);
  expect(findDroppedFile({ ...dropped, size: s.size + 1 }, [clip])).toBeUndefined();
  expect(findDroppedFile(dropped, [])).toBeUndefined();
  // The engine reads macOS's drag pasteboard: always a list, whatever was dragged last.
  expect(Array.isArray(draggedPaths())).toBe(true);
});

test("two dropped files alike in name, size and date are the drag's two paths, not one twice", async () => {
  const [a, b] = ["A", "B"].map((card) => join(dir, card, "take.mov"));
  for (const p of [a!, b!]) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "same");
    utimesSync(p, 1_700_000_000, 1_700_000_000);
  }
  const s = statSync(a!);
  const f = { name: "take.mov", size: s.size, lastModified: s.mtimeMs };
  expect(await findDropped([f, f], { dragged: [a!, b!] })).toEqual([a!, b!]);
  await expect(findDropped([f, f, f], { dragged: [a!, b!] })).rejects.toThrow("couldn't find take.mov");
});

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const IMAGE = join(FIXTURES, "image.png");

test.skipIf(!existsSync(IMAGE))("a screenshot dropped from its thumbnail, or an image pasted, has only its bytes: written into the project's media folder and imported at the time given", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "paste.beproj") });
  const media = join(dir, "paste.beproj", "media");
  const bytes = readFileSync(IMAGE);
  const shot = { name: "Screenshot 2026-10-20 at 16.14.53.png", size: bytes.length + 1, lastModified: 0, data: bytes.toString("base64") };
  // Its temporary file's size and date aren't the webview's: not found among the drag's paths, so its bytes are kept.
  const r = await importDropped(core, h, [shot, shot], { time: 2 }, media);
  expect(r.assets.length).toBe(2);
  expect(readdirSync(media).sort()).toEqual(["Screenshot 2026-10-20 at 16.14.53 2.png", "Screenshot 2026-10-20 at 16.14.53.png"]);
  expect(readFileSync(join(media, "Screenshot 2026-10-20 at 16.14.53.png")).equals(bytes)).toBe(true);
  const placed = core.doc(h).tracks.flatMap((t) => t.clips);
  expect(placed.map((c) => c.type)).toEqual(["image", "image"]);
  expect(placed[0]!.start).toBe(secondsToTicks(2));
  // WebKit names a pasted image "image.png": it is saved by date instead.
  await findDropped([{ ...shot, name: "image.png" }], { dragged: [], folder: media });
  expect(readdirSync(media).filter((n) => /^Pasted \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/.test(n)).length).toBe(1);
  // Without a folder, a file with no path is still lost.
  await expect(findDropped([shot], { dragged: [] })).rejects.toThrow("couldn't find Screenshot");
  await core.close(h);
});
