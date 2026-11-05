import { z } from "zod";
import { ticksToSeconds } from "../ticks";
import { MIN_SPAN_FRAMES, duration, frame, end, topClips, setView, zoomBy, sessionCommand, Time, type SessionCommandDef, TRACK_HEIGHT } from "./shared";

export const TIMELINE_VIEW_COMMANDS: SessionCommandDef[] = [
  sessionCommand({
    id: "timeline.view",
    description: "Show a span of the timeline (seconds)",
    args: z.strictObject({ start: Time, end: Time }),
    apply: (s, v, { project, full }) => setView(s, full, Math.min(v.start, v.end), Math.max(v.start, v.end)),
  }),
  sessionCommand({
    id: "timeline.zoom",
    description:
      "Zoom the timeline: in or out by 2x around the playhead (⇧⌘= / ⇧⌘-), to fit the project (⇧⌘0), to the selection (⇧⌘8) or to the maximum (⇧⌘9)",
    args: z.strictObject({ to: z.enum(["in", "out", "fit", "selection", "max"]) }),
    apply: (s, { to }, { project, full }) => {
      if (to === "in") return zoomBy(s, full, 0.5);
      if (to === "out") return zoomBy(s, full, 2);
      if (to === "fit") return setView(s, full, 0, Math.max(frame(project) * MIN_SPAN_FRAMES, duration(full) * 1.05));
      if (to === "max") return setView(s, full, s.playhead - (MIN_SPAN_FRAMES / 2) * frame(project), s.playhead + (MIN_SPAN_FRAMES / 2) * frame(project));
      const sel = topClips(project).filter((x) => s.selection.includes(x.clip.id));
      if (!sel.length) return;
      const a = ticksToSeconds(Math.min(...sel.map((x) => x.clip.start)));
      const b = ticksToSeconds(Math.max(...sel.map((x) => end(x.clip))));
      const pad = (b - a) * 0.05;
      setView(s, full, a - pad, b + pad);
    },
  }),
  sessionCommand({
    id: "timeline.scroll",
    description: "Scroll the timeline so its visible span starts at a time, keeping the zoom, and/or its tracks up by `top` points when there are more than fit (the timeline keeps it within them)",
    args: z
      .strictObject({ start: Time.optional(), top: z.number().nonnegative().optional() })
      .refine((a) => a.start !== undefined || a.top !== undefined, { message: "give `start` or `top`" }),
    apply: (s, { start, top }, { full }) => {
      if (start !== undefined) setView(s, full, start, start + (s.timeline.end - s.timeline.start));
      if (top !== undefined) s.timeline = { ...s.timeline, top: Math.round(top) };
    },
  }),
  sessionCommand({
    id: "timeline.trackHeight",
    description: `Set every track's height in points (${TRACK_HEIGHT.min}-${TRACK_HEIGHT.max}), as the track height slider does, or change it \`by\` points (⌥= / ⌥-)`,
    args: z
      .strictObject({ height: z.number().min(TRACK_HEIGHT.min).max(TRACK_HEIGHT.max).optional(), by: z.number().optional() })
      .refine((a) => (a.height === undefined) !== (a.by === undefined), { message: "give `height` or `by`" }),
    apply: (s, { height, by }) => {
      const h = height ?? s.timeline.trackHeight + by!;
      s.timeline = { ...s.timeline, trackHeight: Math.round(Math.min(TRACK_HEIGHT.max, Math.max(TRACK_HEIGHT.min, h))) };
    },
  }),
  sessionCommand({
    id: "timeline.snapping",
    description: "Turn timeline snapping on or off, or toggle it (⇧⌘;): dragged clips and edges snap to clip edges, the playhead, markers and the range",
    args: z.strictObject({ on: z.boolean().optional() }),
    apply: (s, { on }) => {
      s.snapping = on ?? !s.snapping;
    },
  }),
  sessionCommand({
    id: "canvas.snapping",
    description: "Turn canvas snapping on or off, or toggle it (⌘;): media dragged on the canvas snaps to its edges and centre and to other media",
    args: z.strictObject({ on: z.boolean().optional() }),
    apply: (s, { on }) => {
      s.canvas.snapping = on ?? !s.canvas.snapping;
    },
  }),
];
