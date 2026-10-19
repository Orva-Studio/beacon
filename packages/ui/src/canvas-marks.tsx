import { apply, type RGBA } from "@beacon/model";
import { rgba } from "./theme";
import type { Placed } from "./canvas";

export const HANDLE = 10;
/** The rotate control: the × circle at the clip's centre, and the dot this far out along its x axis. */
export const ROTATE = { ring: 14, dot: 10, arm: 52 };

/** The canvas colours, from the design tokens. */
export const COLOR = {
  get border() {
    return rgba("canvas-border");
  },
  get outline() {
    return rgba("canvas-outline");
  },
  get handle() {
    return rgba("canvas-handle");
  },
  get guide() {
    return rgba("canvas-guide");
  },
  get hot() {
    return rgba("canvas-hot");
  },
  get ring() {
    return rgba("canvas-ring");
  },
};

/**
 * What the preview draws over the canvas in the same frame as the picture
 * (beacon-render's `Mark`), computed in overlay points; the app hands them to the
 * native view in canvas pixels, the harness draws them as SVG.
 */
export type CanvasMark =
  /** `butt`: square ends (a band, such as a text selection) instead of round caps. */
  | { kind: "line"; from: [number, number]; to: [number, number]; width: number; color: RGBA; butt?: boolean }
  | { kind: "circle"; at: [number, number]; radius: number; width: number; fill: RGBA; stroke: RGBA };

export const line = (from: [number, number], to: [number, number], color: RGBA, width = 1): CanvasMark => ({ kind: "line", from, to, width, color });
export const circle = (at: [number, number], radius: number, fill: RGBA, stroke: RGBA = COLOR.outline, width = 1.5): CanvasMark => ({ kind: "circle", at, radius, width, fill, stroke });
export const cross = ([x, y]: [number, number], r: number, color: RGBA, width = 1.3): CanvasMark[] => [line([x - r, y - r], [x + r, y + r], color, width), line([x + r, y - r], [x - r, y + r], color, width)];

/** Where the clip turns about: its content's centre, in overlay points. */
export const pivot = (p: Placed) => apply(p.m, p.size[0] / 2, p.size[1] / 2);

/** The content's x axis on screen from the pivot, so the rotate arm turns with the clip (and points left when it is flipped). */
export function axis(p: Placed): [number, number] {
  const [cx, cy] = pivot(p);
  const q = apply(p.m, p.size[0] / 2 + 1, p.size[1] / 2);
  const n = Math.hypot(q[0] - cx, q[1] - cy) || 1;
  return [(q[0] - cx) / n, (q[1] - cy) / n];
}

export const handlePoints = (p: Placed): Record<string, [number, number]> => {
  const [a, b, c, d] = p.corners as [[number, number], [number, number], [number, number], [number, number]];
  const mid = (u: [number, number], v: [number, number]): [number, number] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  return { nw: a, n: mid(a, b), ne: b, e: mid(b, c), se: c, s: mid(c, d), sw: d, w: mid(d, a) };
};

export const dotAt = (p: Placed): [number, number] => {
  const [cx, cy] = pivot(p);
  const [ux, uy] = axis(p);
  return [cx + ux * ROTATE.arm, cy + uy * ROTATE.arm];
};

/**
 * The selection: a thin white outline that turns with the clip, round
 * handles at its corners and sides, and the rotate control in the middle (a
 * circle with an ×, joined by a line to a dot that is green when hot).
 */
export function selectionMarks(p: Placed, hot: boolean): CanvasMark[] {
  const q = p.corners;
  const [cx, cy] = pivot(p);
  const [ux, uy] = axis(p);
  const dot = dotAt(p);
  return [
    ...q.map((a, i) => line(a, q[(i + 1) % 4]!, COLOR.outline)),
    ...Object.values(handlePoints(p)).map((h) => circle(h, HANDLE / 2, COLOR.handle)),
    line([cx + (ux * ROTATE.ring) / 2, cy + (uy * ROTATE.ring) / 2], [dot[0] - (ux * ROTATE.dot) / 2, dot[1] - (uy * ROTATE.dot) / 2], COLOR.outline),
    circle([cx, cy], ROTATE.ring / 2, COLOR.ring),
    ...cross([cx, cy], 2.6, COLOR.outline),
    circle(dot, ROTATE.dot / 2, hot ? COLOR.hot : COLOR.handle),
  ];
}

/** Invisible grab areas over the drawn handles and rotate dot (the picture is drawn by the preview). */
/** A caption's selection: its box, and the side handles that set how wide its lines run. */
export function captionMarks(p: Placed): CanvasMark[] {
  const q = p.corners;
  const at = handlePoints(p);
  return [...q.map((a, i) => line(a, q[(i + 1) % 4]!, COLOR.outline)), circle(at.e!, HANDLE / 2, COLOR.handle), circle(at.w!, HANDLE / 2, COLOR.handle)];
}

export const css = (c: RGBA) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;

/** The marks as SVG, where there is no native view to draw them (the UI harness). */
export function MarksSvg({ marks }: { marks: CanvasMark[] }) {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {marks.map((m, i) =>
        m.kind === "line" ? (
          <line key={i} x1={m.from[0]} y1={m.from[1]} x2={m.to[0]} y2={m.to[1]} stroke={css(m.color)} strokeWidth={m.width} />
        ) : (
          <circle key={i} cx={m.at[0]} cy={m.at[1]} r={m.radius} fill={css(m.fill)} stroke={css(m.stroke)} strokeWidth={m.width} />
        ),
      )}
    </svg>
  );
}
