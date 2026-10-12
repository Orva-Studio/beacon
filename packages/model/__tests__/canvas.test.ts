import { expect, test } from "bun:test";
import { enginePlacement, fitPercent, panKeeping, placeCanvas } from "../src";

const canvas = { width: 1920, height: 1080 };

test("canvas placement agrees between points, physical pixels and the engine", () => {
  // Fitted in a tall view: as wide as the view, centred vertically; the engine's own fit (canvas px per view px) is the inverse.
  const view = { width: 1772, height: 2068 };
  const fit = placeCanvas(canvas, view, "fit", [500, 500], 2);
  expect(fit.k).toBeCloseTo(1772 / 1920);
  expect([fit.x, fit.y]).toEqual([0, (2068 - 1080 * fit.k) / 2]);
  const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!));
  close(enginePlacement(canvas, view, fit), [1920 / 1772, 0, 0]);
  expect(fitPercent(canvas, { width: 886, height: 1034 })).toBeCloseTo((886 / 1920) * 100);

  // Zoomed 66% on a 2x display and panned: the same canvas point lands on the same spot in points and in pixels.
  const pts = placeCanvas(canvas, { width: 886, height: 1034 }, 66, [100, -50]);
  const px = placeCanvas(canvas, view, 66, [100, -50], 2);
  expect(px.k).toBeCloseTo(pts.k * 2);
  expect(px.x).toBeCloseTo(pts.x * 2);
  expect(px.y).toBeCloseTo(pts.y * 2);
  close(enginePlacement(canvas, view, px), [1 / 1.32, -100 * 1.32, 50 * 1.32]);

  // Zooming about a point keeps it under the pointer.
  const pan = panKeeping(canvas, { width: 886, height: 1034 }, 150, [400, 300], [200, 250]);
  const after = placeCanvas(canvas, { width: 886, height: 1034 }, 150, pan);
  expect(after.x + 400 * after.k).toBeCloseTo(200);
  expect(after.y + 300 * after.k).toBeCloseTo(250);
});
