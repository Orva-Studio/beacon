/**
 * The timeline's geometry in points: where rows, clips, arrows, volume
 * lines, header icons and the playhead's handles are. Drawing and hit-testing
 * both read it, so what is clickable is what is drawn.
 */

import { color, font } from "./theme";

export const RULER = 40;
export const HEADER = 156;

/** The track headers' width: room for names only when a track has one (unnamed tracks show just their icons). */
export const headerWidth = (tracks: readonly { name: string }[]) => (tracks.some((t) => shownName(t.name)) ? HEADER : 100);

/** A track's name as its header shows it: none for unnamed tracks, nor for "Track N" (older `.cmproj` imports stored it). */
export const shownName = (name: string) => (/^Track \d+$/.test(name) ? "" : name);
/** The track height control in the corner above the headers. */
export const HEIGHT_SLIDER = { x: 14, top: 8, bottom: 32, hit: 26 };
/** The corner's buttons right of the slider: Add Track (+) over the tracks menu (⌄), `right` short of the headers' edge. */
const CORNER = { x: 52, right: 10, height: 15, add: 4, menu: 22 };
export const cornerButtons = (header: number) =>
  (["add", "menu"] as const).map((id) => ({ id, x: CORNER.x, y: CORNER[id], w: header - CORNER.right - CORNER.x, h: CORNER.height }));
export const cornerButtonAt = (header: number, x: number, y: number) => cornerButtons(header).find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.id;
/** Within this many pixels of the playhead line, a press grabs the playhead. */
export const GRAB = 6;
/** Within this many points of a clip's end, a press grabs the edge to trim it. */
export const EDGE = 6;
/** Dragged clips and edges snap from this many points away. */
export const SNAP = 12;

/** The top of display row `i` (top track first) for tracks `track` points tall. */
export const rowTop = (i: number, track: number) => RULER + i * track;

/** A clip's box in its row: 3 points in from the row's edges. */
export const clipBox = (i: number, track: number) => ({ y: rowTop(i, track) + 3, h: track - 6 });

/** The volume line's height for a gain (0–1 shown) on a clip in row `i`. */
export const volumeY = (i: number, track: number, v: number) => {
  const { y, h } = clipBox(i, track);
  return y + 3 + (1 - Math.min(1, Math.max(0, v))) * (h - 6);
};

/** Tracks at least this tall show the magnet under their header icons. */
const MAGNET_TRACK = 62;

/** A track header's icon centres: mute, lock and eye, and on tall tracks the magnet below them. */
export function headerIcons(i: number, track: number, header: number): { mute: [number, number]; eye: [number, number]; lock: [number, number]; magnet?: [number, number] } {
  const top = rowTop(i, track);
  const mid = top + track / 2;
  // Mute, lock and eye side by side on every track; taller tracks add the magnet below them.
  const tall = track >= MAGNET_TRACK;
  const y = tall ? mid - 10 : mid;
  const row = { mute: [header - 66, y], lock: [header - 44, y], eye: [header - 22, y] } as const satisfies Record<string, [number, number]>;
  return tall ? { ...row, magnet: [header - 44, mid + 12] } : row;
}

/**
 * Where the in (green) and out (red) handles start, and the green one's width:
 * beside the playhead's head; with a range, the green flag ends at the
 * in point and the red handle sits at the out point (beside the head when the playhead is there).
 */
export const rangeHandles = (playheadX: number, range?: { inX: number; outX: number }) =>
  range
    ? { green: range.inX - FLAG, greenW: FLAG, red: range.outX + (Math.abs(playheadX - range.outX) < 1 ? 12 : 0) }
    : { green: playheadX - 20, greenW: 8, red: playheadX + 12 };

/** Width of the in point's green flag while there is a range. */
export const FLAG = 44;

export const ARROW = { fill: () => color("arrow"), selected: () => color("arrow-selected"), start: () => color("arrow-start"), end: () => color("arrow-end") };

/** The arrowhead's height on a clip `ch` tall: what the arrow hit test and drawing share. */
export const arrowHead = (ch: number) => Math.min(ch * 0.72, 40);

/** Half the animation band's height on a clip `ch` tall (its diamonds reach as far). */
const bandHalf = (ch: number) => Math.min(15, arrowHead(ch) * 0.42);

/** Half the animation's height at `px`: the hit test follows the band. */
export function arrowHalfHeight(_xa: number, _xb: number, _px: number, ch: number): number {
  return bandHalf(ch);
}

/** A diamond with rounded corners centred on (x, y), `r` from its centre to a corner. */
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const side = r * Math.SQRT2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  ctx.roundRect(-side / 2, -side / 2, side, side, Math.min(3, side / 4));
  ctx.restore();
}

/**
 * An animation on a clip: a keyframe diamond at its start and at its end,
 * joined by a translucent band across the clip's middle; the diamond last clicked (`picked`) is red.
 */
export function drawArrow(ctx: CanvasRenderingContext2D, xa: number, xb: number, ay: number, ch: number, on: boolean, picked?: "start" | "end") {
  const r = bandHalf(ch);
  ctx.save();
  ctx.fillStyle = on ? ARROW.selected() : ARROW.fill();
  ctx.fillRect(xa, ay - r, Math.max(0, xb - xa), r * 2);
  ctx.strokeStyle = color("arrow-outline");
  ctx.lineWidth = on ? 1.5 : 1;
  ctx.globalAlpha *= on ? 1 : 0.75;
  ctx.beginPath();
  ctx.moveTo(xa, ay - r + 0.5);
  ctx.lineTo(xb, ay - r + 0.5);
  ctx.moveTo(xa, ay + r - 0.5);
  ctx.lineTo(xb, ay + r - 0.5);
  ctx.stroke();
  ctx.globalAlpha /= on ? 1 : 0.75;
  for (const [x, fill, part] of [[xa, ARROW.start(), "start"], [xb, ARROW.end(), "end"]] as const) {
    diamond(ctx, x, ay, r);
    ctx.fillStyle = picked === part ? color("arrow-picked") : fill;
    ctx.fill();
    ctx.strokeStyle = picked === part ? color("arrow-picked") : color("arrow-outline");
    ctx.stroke();
  }
  ctx.restore();
}

/** The "fx" badge at a clip's top right (`right` is its right edge), marking that it has effects; `pulse` (0–1) while one was just added. */
export function drawFxBadge(ctx: CanvasRenderingContext2D, right: number, top: number, on: boolean, pulse?: number) {
  const [w, h] = [20, 14];
  ctx.save();
  ctx.globalAlpha = pulse ?? (on ? 1 : 0.5);
  ctx.fillStyle = color(pulse === undefined ? "fx-badge" : "accent");
  ctx.beginPath();
  ctx.roundRect(right - w, top, w, h, 3);
  ctx.fill();
  ctx.fillStyle = color(pulse === undefined ? "fx-badge-text" : "effect-text-selected");
  ctx.font = `italic ${font(10, 700)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("fx", right - w / 2, top + h / 2 + 0.5);
  ctx.restore();
}
