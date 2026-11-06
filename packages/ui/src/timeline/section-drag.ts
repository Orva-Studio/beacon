import { rationalToNumber, ticksToSeconds } from "@beacon/model";
import { replica } from "../store";
import type { Drag } from "../timeline-draw";
import type { DrawingContext } from "./context";
import { partEdges, sectionRoom, sectionSpan, type DragOf } from "./drag-state";
import type { TimelineHits } from "./hit-test";

/** A second press on the band within this long (ms) and this many points of the first is a double-click. */
const DOUBLE_MS = 400;
const DOUBLE_SLOP = 4;

/**
 * The last press on the band, kept outside `sectionDrag`: the first click of a double-click moves the playhead, which
 * draws the timeline again and makes a new `sectionDrag`.
 */
let last = { at: -Infinity, x: -Infinity };

/** Sections picked, moved, resized and dragged out on the Sections band. */
export function sectionDrag({ canvas, latest, dragState, draw, run }: DrawingContext, { sectionAt, snapped, spp, timeAt }: TimelineHits, settle: (drag: Drag) => void) {
  /**
   * A press on the Sections band: pick and drag a section or its edge, or, on empty time, drag out a new one after a
   * double-click (the second press held) or with ⌥. A plain press there is the ruler's (false): moving the playhead
   * along the band named a section by accident (the user, 2026-11-06).
   */
  const press = (e: React.PointerEvent, x: number): boolean => {
    const hit = sectionAt(x);
    // A pointerdown's `detail` stays 0, so the double-click is told from the press before it.
    const second = e.timeStamp - last.at < DOUBLE_MS && Math.abs(x - last.x) <= DOUBLE_SLOP;
    last = second ? { at: -Infinity, x: -Infinity } : { at: e.timeStamp, x };
    if (!hit && !e.altKey && !second) return false;
    canvas.current!.setPointerCapture(e.pointerId);
    if (hit) {
      replica.section(hit.section.id);
      const [a, b] = [ticksToSeconds(hit.section.start), ticksToSeconds(hit.section.end)];
      const [lo, hi] = sectionRoom(latest.current.project, a, b, hit.section.id);
      dragState.current = { kind: "section", section: hit.section.id, part: hit.part, x0: x, a0: a, b0: b, a, b, lo, hi, moved: false };
    } else {
      replica.section(undefined);
      let t = timeAt(e.clientX);
      t += snapped([t], new Set(), e.ctrlKey);
      const [lo, hi] = sectionRoom(latest.current.project, t, t);
      dragState.current = { kind: "sectionNew", a: t, b: t, lo, hi };
    }
    draw();
    return true;
  };

  const move = (d: DragOf<"section" | "sectionNew">, e: React.PointerEvent, x: number) => {
    if (d.kind === "sectionNew") {
      let t = timeAt(e.clientX);
      t += snapped([t], new Set(), e.ctrlKey);
      dragState.current = { ...d, b: Math.min(d.hi, Math.max(d.lo, t)) };
      return draw();
    }
    const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
    let dt = (x - d.x0) * spp();
    dt += snapped(partEdges(d.part, d.a0, d.b0, dt), new Set(), e.ctrlKey);
    const [a, b] = sectionSpan(d, dt, frame);
    dragState.current = { ...d, a, b, moved: d.moved || Math.abs(x - d.x0) > 2 };
    return draw();
  };

  const finish = (d: DragOf<"section" | "sectionNew">) => {
    if (d.kind === "sectionNew") {
      const [a, b] = [Math.min(d.a, d.b), Math.max(d.a, d.b)];
      if (b - a >= 1 / rationalToNumber(latest.current.project.settings.fps)) replica.nameSection({ start: a, end: b });
      draw();
    } else if (d.moved && (Math.abs(d.a - d.a0) > 1e-9 || Math.abs(d.b - d.b0) > 1e-9)) {
      settle(d);
      run("section.set", { section: d.section, start: d.a, end: d.b }, d.part === "body" ? "Move Section" : "Resize Section");
    } else draw();
  };

  return { press, move, finish };
}
