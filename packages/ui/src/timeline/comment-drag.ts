import { rationalToNumber, ticksToSeconds } from "@beacon/model";
import { replica } from "../store";
import type { Drag } from "../timeline-draw";
import type { DrawingContext } from "./context";
import { partEdges, type DragOf } from "./drag-state";
import type { TimelineHits } from "./hit-test";

const DOUBLE_MS = 400;
const DOUBLE_SLOP = 4;

/** The last press on the lane, kept outside `commentDrag` for the same reason as the Sections band's. */
let last = { at: -Infinity, x: -Infinity };

/** Comments picked, moved, resized and made in the Comments lane. */
export function commentDrag({ canvas, latest, dragState, draw, run }: DrawingContext, { commentAt, snapped, spp, timeAt }: TimelineHits, settle: (drag: Drag) => void) {
  /**
   * A press in the lane: pick and drag a comment or its edge, or make one: on empty time after a double-click (the
   * second press: held and dragged, over a stretch; let go, at that moment), or with ⌥ anywhere, over others too, as
   * comments may overlap. A plain press on empty time scrubs (false).
   */
  const press = (e: React.PointerEvent, x: number, y: number): boolean => {
    const hit = e.altKey ? undefined : commentAt(x, y);
    const second = e.timeStamp - last.at < DOUBLE_MS && Math.abs(x - last.x) <= DOUBLE_SLOP;
    last = second ? { at: -Infinity, x: -Infinity } : { at: e.timeStamp, x };
    if (!hit && !e.altKey && !second) return false;
    canvas.current!.setPointerCapture(e.pointerId);
    if (hit) {
      replica.comment(hit.comment.id);
      const a = ticksToSeconds(hit.comment.start);
      const b = hit.comment.end === undefined ? undefined : ticksToSeconds(hit.comment.end);
      dragState.current = { kind: "comment", comment: hit.comment.id, part: hit.part, x0: x, a0: a, a, moved: false, ...(b !== undefined ? { b0: b, b } : {}) };
    } else {
      replica.comment(undefined);
      let t = timeAt(e.clientX);
      t += snapped([t], new Set(), e.ctrlKey);
      dragState.current = { kind: "commentNew", a: t, b: t };
    }
    draw();
    return true;
  };

  const move = (d: DragOf<"comment" | "commentNew">, e: React.PointerEvent, x: number) => {
    if (d.kind === "commentNew") {
      let t = timeAt(e.clientX);
      t += snapped([t], new Set(), e.ctrlKey);
      dragState.current = { ...d, b: Math.max(0, t) };
      return draw();
    }
    const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
    let dt = (x - d.x0) * spp();
    const moved = d.moved || Math.abs(x - d.x0) > 2;
    if (d.b0 === undefined) {
      dt += snapped([d.a0 + dt], new Set(), e.ctrlKey);
      dragState.current = { ...d, a: Math.max(0, d.a0 + dt), moved };
      return draw();
    }
    dt += snapped(partEdges(d.part, d.a0, d.b0, dt), new Set(), e.ctrlKey);
    let [a, b] = [d.a0, d.b0];
    if (d.part === "start") a = Math.max(0, Math.min(d.b0 - frame, d.a0 + dt));
    else if (d.part === "end") b = Math.max(d.a0 + frame, d.b0 + dt);
    else {
      const by = Math.max(-d.a0, dt);
      [a, b] = [d.a0 + by, d.b0 + by];
    }
    dragState.current = { ...d, a, b, moved };
    return draw();
  };

  const finish = (d: DragOf<"comment" | "commentNew">) => {
    if (d.kind === "commentNew") {
      const [a, b] = [Math.min(d.a, d.b), Math.max(d.a, d.b)];
      const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
      replica.editComment(b - a >= frame ? { start: a, end: b } : { start: d.a });
      return draw();
    }
    const changed = Math.abs(d.a - d.a0) > 1e-9 || (d.b !== undefined && d.b0 !== undefined && Math.abs(d.b - d.b0) > 1e-9);
    if (d.moved && changed) {
      settle(d);
      return run("comment.set", { comment: d.comment, start: d.a, ...(d.b !== undefined ? { end: d.b } : {}) }, d.part === "body" ? "Move Comment" : "Resize Comment");
    }
    // A click on a comment takes the playhead to it, as one on a marker did.
    draw();
    run("playhead.set", { time: d.a0 });
  };

  return { press, move, finish };
}
