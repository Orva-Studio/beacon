import type { Handle, Placed } from "./canvas";

/** Dragged media snaps from this many points away. */
const SNAP = 8;

/** Something a moved box aligns on: a vertical (axis x) or horizontal line at `at`, over `span` on the other axis; a centre is a point. */
export interface Line {
  at: number;
  span: [number, number];
  centre?: boolean;
}

/** A snap guide in canvas pixels: the line at `at` from `from` to `to`, with an × at each aligned point. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  marks: number[];
}

/**
 * Snapping on the canvas for one render: `placed` clips drawn at `k` points per canvas pixel from (`ox`, `oy`) in the
 * overlay, on a `width` × `height` canvas; `on`, the session's snapping; `moving`, the clips a move drags.
 */
export function canvasSnapping({ placed, ox, oy, k, width: CW, height: CH, on, moving }: { placed: Placed[]; ox: number; oy: number; k: number; width: number; height: number; on: boolean; moving: Set<string> }) {
  /** Lines a box can align on along axis `i`: its two edges (spanning its extent on the other axis) and its centre (a point). */
  const lines = (a: number, b: number, c0: number, c1: number): Line[] => [
    { at: a, span: [c0, c1] },
    { at: (a + b) / 2, span: [(c0 + c1) / 2, (c0 + c1) / 2], centre: true },
    { at: b, span: [c0, c1] },
  ];

  /** A clip's corners in canvas pixels, and the box around them. */
  const canvasBox = (p: Placed) => {
    const c = p.corners.map(([x, y]) => [(x - ox) / k, (y - oy) / k] as const);
    const lo = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1]))] as const;
    const hi = [Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))] as const;
    return { c, lo, hi };
  };

  /** What a box snaps to along axis `i` (canvas pixels): the canvas's edges and centre, and other clips' edges. */
  const snapTargets = (i: 0 | 1, skip: Set<string>): Line[] => {
    const out = i === 0 ? lines(0, CW, 0, CH) : lines(0, CH, 0, CW);
    for (const p of placed) {
      if (skip.has(p.clip.id)) continue;
      const { lo, hi } = canvasBox(p);
      const j = (1 - i) as 0 | 1;
      out.push(...lines(lo[i], hi[i], lo[j], hi[j]).filter((l) => !l.centre));
    }
    return out;
  };

  /** The nearest target within snapping distance of any of `own` (centres only to centres), and how far to move to it. */
  const nearest = (own: Line[], targets: Line[]) => {
    let best: { by: number; own: Line; target: Line } | undefined;
    for (const o of own) for (const t of targets) if (!!o.centre === !!t.centre && Math.abs(t.at - o.at) * k <= SNAP && (!best || Math.abs(t.at - o.at) < Math.abs(best.by))) best = { by: t.at - o.at, own: o, target: t };
    return best;
  };

  /** The guide drawn for a snap: a line through what aligned, with an × at each end. */
  const guideOf = (i: 0 | 1, s: { own: Line; target: Line }): Guide => {
    const ends = [...s.own.span, ...s.target.span];
    return { axis: i === 0 ? "x" : "y", at: s.target.at, from: Math.min(...ends), to: Math.max(...ends), marks: [...new Set(ends)] };
  };

  /**
   * Snaps a resized box: the side or corner dragged, by `rel` (its size over the size when the drag started) on
   * each axis, to the lines moving snaps to, keeping the opposite side where it is. `uniform`: one factor for
   * both (a video's corner), snapped on the closer axis. A box turned on the canvas doesn't snap.
   */
  const snapResize = (p: Placed, handle: Handle, rel: [number, number], uniform: boolean, off: boolean): { rel: [number, number]; guides: Guide[] } => {
    if (off || !on) return { rel, guides: [] };
    const { c, lo, hi } = canvasBox(p);
    if (!c.every((q) => [0, 1].every((i) => Math.abs(q[i]! - lo[i]!) < 0.5 || Math.abs(q[i]! - hi[i]!) < 0.5))) return { rel, guides: [] };
    const sides = [handle.sx, handle.sy];
    const skip = new Set([p.clip.id]);
    /** The box's extent on axis `i` as resized by `r`. */
    const extent = (i: 0 | 1, r: number): [number, number] => {
      const side = sides[i]!;
      const size = (hi[i] - lo[i]) * r;
      return side > 0 ? [lo[i], lo[i] + size] : side < 0 ? [hi[i] - size, hi[i]] : [(lo[i] + hi[i] - size) / 2, (lo[i] + hi[i] + size) / 2];
    };
    const snap = (i: 0 | 1) => {
      const side = sides[i]!;
      if (!side) return undefined;
      const [a, b] = extent(i, rel[i]);
      const [fixed, edge] = side > 0 ? [a, b] : [b, a];
      const j = (1 - i) as 0 | 1;
      // Only the dragged edge moves; the canvas's centre is the one centre it aligns on.
      const targets = snapTargets(i, skip).filter((t) => !t.centre);
      const found = nearest([{ at: edge, span: extent(j, rel[j]) }], [...targets, { at: i === 0 ? CW / 2 : CH / 2, span: i === 0 ? [0, CH] : [0, CW] }]);
      const r = found && ((found.target.at - fixed) / (edge - fixed || 1)) * rel[i];
      return found && r! > 0.02 ? { r: r!, d: Math.abs(found.by), guide: guideOf(i, found) } : undefined;
    };
    const sx = snap(0);
    const sy = snap(1);
    if (uniform) {
      const b = sx && sy ? (sx.d <= sy.d ? sx : sy) : (sx ?? sy);
      return b ? { rel: [b.r, b.r], guides: [b.guide] } : { rel, guides: [] };
    }
    return { rel: [sx?.r ?? rel[0], sy?.r ?? rel[1]], guides: [...(sx ? [sx.guide] : []), ...(sy ? [sy.guide] : [])] };
  };

  /**
   * Snaps a moved box (canvas pixels) to the canvas's edges and centre and
   * other clips' edges: returns the shift and, per axis, the
   * guide to show (a line through the aligned edges or between the centres).
   */
  const snapMove = (boxes: [number, number][][], dx: number, dy: number, off: boolean) => {
    if (off || !on) return { dx, dy, guides: [] as Guide[] };
    const all = boxes.flat();
    const lo = (i: 0 | 1) => Math.min(...all.map((q) => q[i]));
    const hi = (i: 0 | 1) => Math.max(...all.map((q) => q[i]));
    const snapAxis = (i: 0 | 1, d: number, other: number) => {
      const j = (1 - i) as 0 | 1;
      return nearest(lines(lo(i) + d, hi(i) + d, lo(j) + other, hi(j) + other), snapTargets(i, moving));
    };
    const sx = snapAxis(0, dx, dy);
    const sy = snapAxis(1, dy, dx + (sx?.by ?? 0));
    return { dx: dx + (sx?.by ?? 0), dy: dy + (sy?.by ?? 0), guides: [...(sx ? [guideOf(0, sx)] : []), ...(sy ? [guideOf(1, sy)] : [])] };
  };
  return { snapResize, snapMove };
}
