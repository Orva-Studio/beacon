import { rationalToNumber, ticksToSeconds, type Clip, type Session } from "@beacon/model";
import type { Drag } from "../timeline-draw";
import type { DrawingContext } from "./context";
import { trimmedWith, trimTarget, trimTo, type DragOf } from "./drag-state";
import type { TimelineHits } from "./hit-test";

/** A clip's edge dragged: trimmed with the clips selected or linked with it, or with ⌥ on video a frame held past its media. */
export function trimDrag({ latest, dragState, draw, run, clipTypes }: DrawingContext, { snapped, timeAt }: TimelineHits, settle: (drag: Drag) => void) {
  const press = (session: Session, clip: Clip, edge: "start" | "end", e: React.PointerEvent, x: number) => {
    if (!session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
    const t = ticksToSeconds(edge === "start" ? clip.start : clip.start + clip.duration);
    const edges = new Map([[clip.id, t]]);
    for (const c of trimmedWith(latest.current.project, clip, session.selection.includes(clip.id) ? session.selection : [])) edges.set(c.id, ticksToSeconds(edge === "start" ? c.start : c.start + c.duration));
    dragState.current = { kind: "trim", clip: clip.id, edge, x0: x, t, ripple: e.shiftKey, extend: false, edges };
  };

  const move = (d: DragOf<"trim">, e: React.PointerEvent) => {
    const { project } = latest.current;
    const target = trimTarget(project, clipTypes, d, e.altKey, e.shiftKey);
    let t = timeAt(e.clientX, target.room);
    t += snapped([t], new Set(d.edges.keys()), e.ctrlKey);
    const frame = 1 / rationalToNumber(project.settings.fps);
    dragState.current = { ...d, ...trimTo(project, clipTypes, d, target, t, e.altKey, e.shiftKey, frame) };
    return draw();
  };

  const finish = (d: DragOf<"trim">) => {
    const clip = latest.current.project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clip)!;
    const end = ticksToSeconds(clip.start + clip.duration);
    if (d.extend) {
      const by = d.edge === "start" ? ticksToSeconds(clip.start) - d.t : d.t - end;
      if (by > 0) {
        settle(d);
        run("clip.extendFrame", { clip: d.clip, duration: by, edge: d.edge, ripple: d.ripple }, "Extend Frame");
      }
    } else if (Math.abs(d.t - (d.edge === "start" ? ticksToSeconds(clip.start) : end)) > 1e-9) {
      settle(d);
      const linkId = clip.linkId;
      const others = [...d.edges.keys()].filter((id) => id !== d.clip);
      // Its linked clips alone keep the command's own way (trimmed to the same edges); clips selected with it go by the same amount.
      const apart = others.filter((id) => !linkId || latest.current.project.tracks.some((t) => t.clips.some((c) => c.id === id && c.linkId !== linkId)));
      run("clip.trim", { clip: d.clip, [d.edge]: d.t, linked: true, ripple: d.ripple, ...(apart.length ? { with: others } : {}) }, "Trim Media");
    }
  };

  return { press, move, finish };
}
