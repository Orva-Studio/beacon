/**
 * Where the canvas sits in the editor's view: the one place this is worked
 * out, for the overlay (points), the native preview (physical pixels) and
 * snapshots. The canvas is centred in the view, fitted or at a zoom percent
 * (100 = one canvas pixel per point), and when zoomed, panned so `pan` (a
 * canvas point, pixels from its centre, y down) is at the view's centre.
 */
export interface CanvasPlacement {
  /** View units per canvas pixel. */
  k: number;
  /** The canvas's top-left corner in the view. */
  x: number;
  y: number;
}

type Size = { width: number; height: number };

/** `unitsPerPoint`: 1 for a view measured in points, the display scale for physical pixels. */
export function placeCanvas(canvas: Size, view: Size, zoom: "fit" | number, pan: readonly [number, number], unitsPerPoint = 1): CanvasPlacement {
  const fit = zoom === "fit";
  const k = fit ? Math.min(view.width / canvas.width, view.height / canvas.height) : (zoom / 100) * unitsPerPoint;
  const [px, py] = fit ? [0, 0] : pan;
  return { k, x: (view.width - canvas.width * k) / 2 - px * k, y: (view.height - canvas.height * k) / 2 - py * k };
}

/** The zoom percent that fits the canvas in a view measured in points. */
export function fitPercent(canvas: Size, viewPoints: Size): number {
  return Math.min(viewPoints.width / canvas.width, viewPoints.height / canvas.height) * 100;
}

/** The pan that puts canvas point `c` (pixels from its top left) at view point `v`, at zoom percent `zoom`. */
export function panKeeping(canvas: Size, view: Size, zoom: number, c: readonly [number, number], v: readonly [number, number], unitsPerPoint = 1): [number, number] {
  const k = (zoom / 100) * unitsPerPoint;
  return [((view.width - canvas.width * k) / 2 + c[0] * k - v[0]) / k, ((view.height - canvas.height * k) / 2 + c[1] * k - v[1]) / k];
}

/** The placement as beacon-render's `Placement` takes it: canvas pixels per view pixel, and the canvas centre's offset from the view's centre. */
export function enginePlacement(canvas: Size, view: Size, p: CanvasPlacement): [zoom: number, panX: number, panY: number] {
  return [1 / p.k, p.x + (canvas.width * p.k) / 2 - view.width / 2, p.y + (canvas.height * p.k) / 2 - view.height / 2];
}
