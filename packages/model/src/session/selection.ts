import { z } from "zod";
import type { Clip } from "../schema";
import { secondsToTicks } from "../ticks";
import { rangeMade, snap, duration, frame, end, topClips, withLinked, nestedOf, stops, sessionCommand, Time, type SessionCommandDef } from "./shared";

export const SELECTION_COMMANDS: SessionCommandDef[] = [
  sessionCommand({
    id: "selection.set",
    description:
      "Select clips by id (replacing the selection, or `add`ing to it, or `toggle`); with `linked`, the clips linked to them (a recording's camera and audio) too, as the editor selects them (Unlink to edit them apart)",
    args: z.strictObject({
      clips: z.array(z.string()),
      add: z.boolean().default(false).describe("Add to the selection instead of replacing it"),
      toggle: z.boolean().default(false).describe("Deselect those already selected, select the others (⌘/⇧-click)"),
      linked: z.boolean().default(true),
    }),
    apply: (s, { clips, add, toggle, linked }, { project, full }) => {
      const known = new Set(topClips(project).map((x) => x.clip.id));
      const missing = clips.filter((id) => !known.has(id));
      if (missing.length) throw new Error(`no clip ${missing.map((m) => `"${m}"`).join(", ")} on the timeline`);
      const ids = linked ? withLinked(project, clips) : clips;
      if (s.animation && !clips.includes(s.animation.clip)) s.animation = null;
      s.effects = s.effects.filter((fx) => clips.includes(fx.clip));
      if (toggle) {
        // A clip and those linked to it toggle as one: a partly selected set becomes fully selected.
        const done = new Set<string>();
        for (const clip of clips) {
          if (done.has(clip)) continue;
          const set = linked ? withLinked(project, [clip]) : [clip];
          for (const id of set) done.add(id);
          if (set.every((id) => s.selection.includes(id))) s.selection = s.selection.filter((id) => !set.includes(id));
          else s.selection = [...new Set([...s.selection, ...set])];
        }
      } else s.selection = [...new Set(add ? [...s.selection, ...ids] : ids)];
    },
  }),
  sessionCommand({
    id: "selection.range",
    description:
      "Select a run of clips (⇧-click): every clip from the earlier one's start to the later one's end, on the tracks from `from`'s to `to`'s (locked tracks left out, as the marquee does), and the clips linked to them",
    args: z.strictObject({
      from: z.string().describe("The anchor: the clip clicked before"),
      to: z.string().describe("The clip ⇧-clicked"),
    }),
    apply: (s, { from, to }, { project }) => {
      const at = (id: string) => {
        const i = project.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
        if (i < 0) throw new Error(`no clip "${id}" on the timeline`);
        return { row: i, clip: project.tracks[i]!.clips.find((c) => c.id === id)! };
      };
      const [a, b] = [at(from), at(to)];
      const start = Math.min(a.clip.start, b.clip.start);
      const stop = Math.max(end(a.clip), end(b.clip));
      const ids = project.tracks
        .slice(Math.min(a.row, b.row), Math.max(a.row, b.row) + 1)
        .flatMap((t) => (t.locked ? [] : t.clips.filter((c) => c.start < stop && end(c) > start).map((c) => c.id)));
      s.selection = withLinked(project, [...new Set([from, to, ...ids])]);
      s.animation = null;
      s.effects = [];
    },
  }),
  sessionCommand({
    id: "selection.clear",
    description: "Deselect everything (⇧⌘A); with `range`, clear the in/out range too (Escape)",
    args: z.strictObject({ range: z.boolean().default(false) }),
    apply: (s, { range }) => {
      s.selection = [];
      s.animation = null;
      s.effects = [];
      if (range) s.range = null;
    },
  }),
  sessionCommand({
    id: "selection.all",
    description: "Select every clip on the timeline (⌘A)",
    args: z.strictObject({}),
    apply: (s, _, { project, full }) => {
      s.selection = topClips(project).map((x) => x.clip.id);
    },
  }),
  sessionCommand({
    id: "track.focus",
    description: "Pick the track Lock Track and Mute Track act on when no clip is selected (a click on its header); null for none",
    args: z.strictObject({ track: z.string().nullable() }),
    apply: (s, { track }, { project }) => {
      if (track !== null && !project.tracks.some((t) => t.id === track)) throw new Error(`no track "${track}"${s.group ? " in the open group" : " on the timeline"}`);
      s.track = track;
    },
  }),
  sessionCommand({
    id: "group.open",
    description: "Open a group (a top-level group clip) to edit the clips inside it on the timeline (⌃⇧G); the selected group when no clip is given",
    args: z.strictObject({ clip: z.string().optional() }),
    apply: (s, { clip }, { project, full, registry }) => {
      const id = clip ?? s.selection[0];
      // Only top-level groups: the edit scope is one level deep.
      if (s.group && project.tracks.some((t) => t.clips.some((x) => x.id === id))) throw new Error("groups inside a group can't be opened; close this one first (⌃⇧U)");
      const c = full.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
      if (!c || !registry.hasTrait(c.type, "group") || !nestedOf(registry)(c)) throw new Error(id ? `"${id}" is not a group on the timeline` : "select a group first");
      if (c.speed) throw new Error("a group with a speed change can't be opened");
      s.group = c.id;
      s.track = null;
      s.selection = [];
      s.animation = null;
    },
  }),
  sessionCommand({
    id: "group.close",
    description: "Close the opened group and go back to the main timeline (⌃⇧U)",
    args: z.strictObject({}),
    apply: (s) => {
      if (s.group) s.selection = [s.group];
      s.group = null;
      s.track = null;
      s.animation = null;
    },
  }),
  sessionCommand({
    id: "animation.select",
    description: "Select an animation block (its arrow on the timeline) and its clip, or with no args deselect the animation",
    args: z.strictObject({ clip: z.string().optional(), animation: z.string().optional() }),
    apply: (s, { clip, animation }, { project, full }) => {
      if (!clip || !animation) {
        s.animation = null;
        return;
      }
      const c = topClips(project).find((x) => x.clip.id === clip)?.clip;
      if (!c?.animations.some((a) => a.id === animation)) throw new Error(`no animation "${animation}" on clip "${clip}"`);
      s.animation = { clip, id: animation };
      s.selection = [clip];
    },
  }),
  sessionCommand({
    id: "selection.side",
    description: "Select every clip on the timeline left of the playhead (⌃⇧←) or right of it (⌃⇧→), including those under it",
    args: z.strictObject({ side: z.enum(["left", "right"]) }),
    apply: (s, { side }, { project, full }) => {
      const at = secondsToTicks(s.playhead);
      s.selection = topClips(project)
        .filter(({ clip }) => (side === "left" ? clip.start < at : end(clip) > at))
        .map((x) => x.clip.id);
    },
  }),
  sessionCommand({
    id: "selection.step",
    description:
      "Select a neighbouring clip: on the selected clip's track (⌥← / ⌥→: preceding / succeeding media), or the next or previous visual clip under the playhead (⇥ / ⇧⇥)",
    args: z.strictObject({ direction: z.enum(["next", "previous"]), scope: z.enum(["track", "playhead"]) }),
    apply: (s, { direction, scope }, { project, registry }) => {
      const at = secondsToTicks(s.playhead);
      if (scope === "playhead") {
        const visual = (c: Clip) => registry.clipTypes.get(c.type)?.traits.includes("visual") ?? false;
        const under = [...project.tracks].reverse().flatMap((t) => (t.hidden ? [] : t.clips.filter((c) => visual(c) && c.start <= at && at < end(c))));
        if (!under.length) return;
        const i = under.findIndex((c) => s.selection.includes(c.id));
        const next = i < 0 ? 0 : (i + (direction === "next" ? 1 : under.length - 1)) % under.length;
        s.selection = withLinked(project, [under[next]!.id]);
        return;
      }
      const current = topClips(project).find((x) => s.selection.includes(x.clip.id));
      if (!current) return;
      const clips = [...current.track.clips].sort((a, b) => a.start - b.start);
      const i = clips.findIndex((c) => c.id === current.clip.id);
      const pick = clips[direction === "next" ? i + 1 : i - 1];
      if (pick) s.selection = withLinked(project, [pick.id]);
    },
  }),
  sessionCommand({
    id: "range.set",
    description: "Set the in/out range on the timeline (seconds), deselecting clips so edits act on it; with `playhead`, move the playhead too (a ⌘-drag from the playhead takes it along)",
    args: z.strictObject({ in: Time, out: Time, playhead: Time.optional() }),
    apply: (s, r, { project, full }) => {
      const [a, b] = [snap(project, Math.min(r.in, r.out)), snap(project, Math.max(r.in, r.out))];
      s.range = a === b ? null : { in: a, out: b };
      rangeMade(s);
      if (r.playhead !== undefined) s.playhead = snap(project, r.playhead);
    },
  }),
  sessionCommand({
    id: "range.extend",
    description:
      "Move one end of the in/out range (starting one from the playhead when there is none): by a frame (⇧< / ⇧>), or to the previous or next clip edge (⌥⇧⌘< / ⌥⇧⌘>) or marker (⌃⇧{ / ⌃⇧})",
    args: z.strictObject({ side: z.enum(["left", "right"]), to: z.enum(["frame", "edit", "marker"]).default("frame") }),
    apply: (s, { side, to }, { project, full }) => {
      const r = s.range ?? { in: s.playhead, out: s.playhead };
      const from = side === "left" ? r.in : r.out;
      const eps = frame(project) / 2;
      const list = to === "frame" ? [] : stops(project, to);
      const next =
        to === "frame"
          ? from + (side === "left" ? -1 : 1) * frame(project)
          : side === "left"
            ? (list.findLast((x) => x < from - eps) ?? from)
            : (list.find((x) => x > from + eps) ?? from);
      const t = Math.min(snap(project, next), snap(project, duration(full)));
      s.range = side === "left" ? { in: Math.min(t, r.out), out: r.out } : { in: r.in, out: Math.max(t, r.in) };
      if (s.range.in === s.range.out) s.range = null;
      rangeMade(s);
    },
  }),
  sessionCommand({
    id: "range.clear",
    description: "Remove the in/out range",
    args: z.strictObject({}),
    apply: (s) => {
      s.range = null;
    },
  }),
];
