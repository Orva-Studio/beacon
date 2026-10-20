import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draggedPaths, findDroppedFile } from "@beacon/media";

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
