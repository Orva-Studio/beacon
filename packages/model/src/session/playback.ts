import { z } from "zod";
import { snap, duration, frame, stops, setView, sessionCommand, Time, type SessionCommandDef } from "./shared";

export const PLAYBACK_COMMANDS: SessionCommandDef[] = [
  sessionCommand({
    id: "playhead.set",
    description: "Move the playhead to a time (seconds, snapped to a frame), past the last clip too",
    args: z.strictObject({ time: Time }),
    apply: (s, { time }, { project }) => {
      s.playhead = snap(project, time);
    },
  }),
  sessionCommand({
    id: "playhead.step",
    description: "Move the playhead by whole frames (negative steps back); the , and . keys step one, ⌃< and ⌃> fifteen",
    args: z.strictObject({ frames: z.int() }),
    apply: (s, { frames }, { project, full }) => {
      s.playhead = Math.min(snap(project, s.playhead + frames * frame(project)), Math.max(s.playhead, snap(project, duration(full))));
    },
  }),
  sessionCommand({
    id: "playhead.jump",
    description:
      "Jump the playhead: to the start or end of the timeline, the next/previous edit (clip start or end), marker or animation, or the range's in/out point",
    args: z.strictObject({
      to: z.enum(["start", "end", "nextEdit", "previousEdit", "nextMarker", "previousMarker", "nextAnimation", "previousAnimation", "rangeIn", "rangeOut"]),
    }),
    apply: (s, { to }, { project, full }) => {
      const eps = frame(project) / 2;
      const pick = (kind: "edit" | "marker" | "animation", dir: 1 | -1) => {
        const list = stops(project, kind);
        const t = dir > 0 ? list.find((x) => x > s.playhead + eps) : list.findLast((x) => x < s.playhead - eps);
        return t ?? s.playhead;
      };
      const target = {
        start: () => 0,
        end: () => duration(full),
        nextEdit: () => pick("edit", 1),
        previousEdit: () => pick("edit", -1),
        nextMarker: () => pick("marker", 1),
        previousMarker: () => pick("marker", -1),
        nextAnimation: () => pick("animation", 1),
        previousAnimation: () => pick("animation", -1),
        rangeIn: () => s.range?.in ?? s.playhead,
        rangeOut: () => s.range?.out ?? s.playhead,
      }[to]();
      s.playhead = snap(project, target);
      // Off screen, the timeline scrolls to it at the same zoom, a little in from the edge it came in by.
      const { start, end } = s.timeline;
      const span = end - start;
      if (s.playhead < start) setView(s, project, s.playhead - span * 0.1, s.playhead + span * 0.9);
      else if (s.playhead > end) setView(s, project, s.playhead - span * 0.9, s.playhead + span * 0.1);
    },
  }),
  sessionCommand({
    id: "playback.play",
    description: "Start playback at 1x from the playhead (from the start when at the end)",
    args: z.strictObject({}),
    apply: (s, _, { project, full }) => {
      if (s.playhead >= snap(project, duration(full)) - frame(project) / 2) s.playhead = 0;
      s.playing = true;
      s.rate = 1;
    },
  }),
  sessionCommand({
    id: "playback.shuttle",
    description:
      "J/L: play forward (L) or in reverse (J) at 1x; pressed again while playing that way, 2x, 4x, then 8x. `slow`: half speed (⇧L, ⇧J). K pauses",
    args: z.strictObject({ direction: z.enum(["forward", "reverse"]), slow: z.boolean().optional() }),
    apply: (s, { direction, slow }, ctx) => {
      const sign = direction === "forward" ? 1 : -1;
      const speed = slow ? 0.5 : s.playing && Math.sign(s.rate) === sign && Math.abs(s.rate) >= 1 ? Math.min(Math.abs(s.rate) * 2, 8) : 1;
      if (sign > 0 && !s.playing) PLAYBACK_COMMANDS.find((c) => c.id === "playback.play")!.apply(s, {}, ctx);
      else if (sign < 0 && s.playhead <= 0) return;
      s.playing = true;
      s.rate = sign * speed;
    },
  }),
  sessionCommand({
    id: "playback.pause",
    description: "Stop playback, leaving the playhead where it is (K)",
    args: z.strictObject({}),
    apply: (s) => {
      s.playing = false;
    },
  }),
  sessionCommand({
    id: "playback.toggle",
    description: "Play or pause (Space)",
    args: z.strictObject({}),
    apply: (s, args, ctx) => {
      if (s.playing) s.playing = false;
      else PLAYBACK_COMMANDS.find((c) => c.id === "playback.play")!.apply(s, args, ctx);
    },
  }),
];
