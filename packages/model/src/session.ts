import { produce } from "immer";
import { z } from "zod";
import { clipSpeed } from "./evaluate";
import type { FeatureRegistry } from "./registry";
import type { Animation, Clip, EffectInstance, Project, Track } from "./schema";
import { projectDuration } from "./project";
import { copyClips, editScope, scopedProject, type Clipboard } from "./edit";
import { roundSeconds, secondsToTicks, snapSeconds, ticksPerFrame, ticksToSeconds } from "./ticks";

/** A range just made is what Delete, Cut and Copy act on next: the last thing selected wins, so clips selected before it are let go. */
function rangeMade(s: Session) {
  if (!s.range) return;
  s.selection = [];
  s.effects = [];
  s.animation = null;
}

/**
 * What the editor is showing, as opposed to what the project contains:
 * playhead, selection, range, timeline view, panels. Not undoable and not
 * saved, but driven and read through commands like the document (PLAN §7).
 * Times are seconds, snapped to frames.
 */
export interface Session {
  playhead: number;
  playing: boolean;
  /** Playback speed while playing: 1, 2, 4 or 8 forward (L pressed again), negative in reverse (J), ±0.5 slow (⇧L, ⇧J). */
  rate: number;
  /** Selected clip ids (top-level tracks); linked clips select together. */
  selection: string[];
  /** The selected animation block (its arrow on the timeline), if any. */
  animation: { clip: string; id: string } | null;
  /** Selected effects (their bars on an opened clip): Delete removes them, ⌘C copies them. */
  effects: { clip: string; id: string }[];
  /** The group opened for editing inside (its group tab), if any; selection and the editor's commands then work on its tracks. */
  group: string | null;
  range: { in: number; out: number } | null;
  /** The timeline's visible span in seconds, and every track's height in points. */
  timeline: { start: number; end: number; trackHeight: number };
  /** Left tool panel shown (null: collapsed) and whether the properties panel is open. */
  panels: { tool: string | null; properties: boolean };
  /** Properties panel tab: a prop group id, "effects" or "audio". */
  inspector: string;
  /**
   * Canvas zoom: "fit", or percent (100 = one canvas pixel per screen point);
   * `pan`: the canvas point (pixels from its centre, y down) shown at the
   * view's centre when zoomed; whether dragged media snaps to the canvas's
   * edges and centre and to other media.
   */
  canvas: { zoom: "fit" | number; pan: [number, number]; snapping: boolean };
  /** Timeline snapping (View > Enable Timeline Snapping). */
  snapping: boolean;
  /** What `clipboard.copy` copied, for `clip.paste`; shared by the projects open in one app. */
  clipboard: Clipboard | null;
  /** What `properties.copy` copied (Copy Properties), for `clip.pasteProperties`; shared like `clipboard`. */
  properties: CopiedProperties | null;
  /** Features' own editor state, by feature id, set by their session commands (Remove Silences' review). */
  features: Record<string, unknown>;
}

/** A clip's property groups and effects, as Copy Properties takes them. */
export interface CopiedProperties {
  props: Record<string, Record<string, unknown>>;
  effects: EffectInstance[];
  /** A copied animation arrow: where it starts in its clip and how long it is (seconds), easing and end values. */
  animations?: { offset: number; duration: number; easing: Animation["easing"]; to: Record<string, unknown> }[];
}

/** What a new project's editor starts with from the ones open before it. */
export type SharedSession = Pick<Session, "clipboard" | "properties">;

export interface SessionContext {
  /** What the editor works on: with a group open, its tracks at main-timeline times. */
  project: Project;
  /** The whole project: the timeline's length and view come from it, group open or not. */
  full: Project;
  registry: FeatureRegistry;
  /** The canvas's fit zoom in percent, reported by the app, for stepping from "fit". */
  fitPercent?: number;
}

export interface SessionCommandDef<A = any> {
  id: string;
  description: string;
  args: z.ZodType<A>;
  apply: (s: Session, args: A, ctx: SessionContext) => void;
}

/** The tool panels, in sidebar order. */
export const TOOL_PANELS = [
  "favorites",
  "media",
  "annotations",
  "visualEffects",
  "audioEffects",
  "narration",
  "ai",
] as const;

export const TRACK_HEIGHT = { min: 26, max: 120, default: 44 };

const MIN_SPAN_FRAMES = 10;

export function defaultSession(project: Project, shared: Partial<SharedSession> = {}): Session {
  const end = Math.max(10, ticksToSeconds(projectDuration(project)));
  return {
    playhead: 0,
    playing: false,
    rate: 1,
    selection: [],
    animation: null,
    effects: [],
    group: null,
    range: null,
    timeline: { start: 0, end: roundSeconds(end * 1.05), trackHeight: TRACK_HEIGHT.default },
    panels: { tool: "media", properties: true },
    inspector: "transform",
    canvas: { zoom: "fit", pan: [0, 0], snapping: true },
    snapping: true,
    clipboard: shared.clipboard ?? null,
    properties: shared.properties ?? null,
    features: {},
  };
}

const snap = (project: Project, seconds: number) => roundSeconds(ticksToSeconds(snapSeconds(Math.max(0, seconds), project.settings.fps)));
const duration = (project: Project) => ticksToSeconds(projectDuration(project));
const frame = (project: Project) => ticksToSeconds(ticksPerFrame(project.settings.fps));
const end = (c: Clip) => c.start + c.duration;
const topClips = (project: Project) => project.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, track: t })));

/** The clip ids plus every clip linked to them. */
function withLinked(project: Project, ids: string[]): string[] {
  const all = topClips(project).map((x) => x.clip);
  const links = new Set(all.filter((c) => ids.includes(c.id) && c.linkId).map((c) => c.linkId));
  return [...new Set([...ids, ...all.filter((c) => c.linkId && links.has(c.linkId)).map((c) => c.id)])];
}

/** Timeline seconds of every clip start and end, marker and animation block edge, sorted. */
function stops(project: Project, kind: "edit" | "marker" | "animation"): number[] {
  const out: number[] = [];
  if (kind === "marker") for (const m of project.markers) out.push(m.time);
  for (const { clip } of topClips(project)) {
    if (kind === "edit") out.push(clip.start, end(clip));
    if (kind === "animation") {
      for (const a of clip.animations) {
        for (const media of [a.end - a.duration, a.end]) {
          const t = clip.start + (media - (clip.mediaStart ?? 0)) / clipSpeed(clip);
          if (t >= clip.start && t <= end(clip)) out.push(t);
        }
      }
    }
  }
  return [...new Set(out.map((t) => roundSeconds(ticksToSeconds(t))))].sort((a, b) => a - b);
}

/** Keeps the visible span inside [0, max(duration, span, playhead)] and at least a few frames long. */
function setView(s: Session, project: Project, start: number, endAt: number) {
  const span = Math.max(MIN_SPAN_FRAMES * frame(project), endAt - start);
  const limit = Math.max(duration(project) * 1.05, span, s.playhead);
  const from = Math.min(Math.max(0, start), limit - span);
  s.timeline = { start: roundSeconds(from), end: roundSeconds(from + span), trackHeight: s.timeline.trackHeight };
}

/** Zooms by `factor` (< 1 zooms in) around the playhead when it is visible, else the centre. */
function zoomBy(s: Session, project: Project, factor: number) {
  const { start, end: e } = s.timeline;
  const anchor = s.playhead >= start && s.playhead <= e ? s.playhead : (start + e) / 2;
  setView(s, project, anchor - (anchor - start) * factor, anchor + (e - anchor) * factor);
}

function sessionCommand<S extends z.ZodType>(def: { id: string; description: string; args: S; apply: (s: Session, args: z.output<S>, ctx: SessionContext) => void }): SessionCommandDef {
  return def as SessionCommandDef;
}

const Time = z.number().nonnegative().describe("Timeline seconds");

export const SESSION_COMMANDS: SessionCommandDef[] = [
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
      if (sign > 0 && !s.playing) SESSION_COMMANDS.find((c) => c.id === "playback.play")!.apply(s, {}, ctx);
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
      else SESSION_COMMANDS.find((c) => c.id === "playback.play")!.apply(s, args, ctx);
    },
  }),
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
    description: "Scroll the timeline so its visible span starts at a time, keeping the zoom",
    args: z.strictObject({ start: Time }),
    apply: (s, { start }, { project, full }) => setView(s, full, start, start + (s.timeline.end - s.timeline.start)),
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
  sessionCommand({
    id: "effect.select",
    description: "Select effects (their bars on a clip opened with its arrow) and their clips; `add` adds to the selected effects (⇧/⌘-click); no effects deselects them",
    args: z.strictObject({ effects: z.array(z.strictObject({ clip: z.string(), id: z.string() })), add: z.boolean().default(false) }),
    apply: (s, { effects, add }, { project }) => {
      const clips = topClips(project).map((x) => x.clip);
      for (const e of effects) if (!clips.find((c) => c.id === e.clip)?.effects.some((fx) => fx.id === e.id)) throw new Error(`no effect "${e.id}" on clip "${e.clip}"`);
      const key = (e: { clip: string; id: string }) => `${e.clip}/${e.id}`;
      const next = add ? [...s.effects.filter((e) => !effects.some((x) => key(x) === key(e))), ...effects] : effects;
      s.effects = next;
      s.animation = null;
      if (effects.length) {
        s.selection = [...new Set([...(add ? s.selection : []), ...next.map((e) => e.clip)])];
        s.inspector = "effects";
      }
    },
  }),
  sessionCommand({
    id: "animation.copy",
    description: "Copy the selected animation arrow (⌘C with an arrow selected) for pasting onto other clips (⌘V), kept as copied properties",
    args: z.strictObject({}),
    apply: (s, _, { project }) => {
      const sel = s.animation;
      const clip = sel && topClips(project).find((x) => x.clip.id === sel.clip)?.clip;
      const anim = clip?.animations.find((a) => a.id === sel!.id);
      if (!clip || !anim) throw new Error("select an animation arrow first");
      const speed = clipSpeed(clip);
      const offset = ticksToSeconds((anim.end - anim.duration - (clip.mediaStart ?? 0)) / speed);
      s.properties = JSON.parse(JSON.stringify({ props: {}, effects: [], animations: [{ offset, duration: ticksToSeconds(anim.duration / speed), easing: anim.easing, to: anim.to }] }));
      s.clipboard = null;
    },
  }),
  sessionCommand({
    id: "effects.copy",
    description: "Copy the selected effects (⌘C with effects selected) for pasting onto other clips (⌘V); they are kept as copied properties with no prop groups",
    args: z.strictObject({}),
    apply: (s, _, { project }) => {
      const clips = topClips(project).map((x) => x.clip);
      const effects = s.effects.flatMap((e) => clips.find((c) => c.id === e.clip)?.effects.filter((fx) => fx.id === e.id) ?? []);
      if (!effects.length) throw new Error("select effects first");
      // The span is the copied clip's media time; on another clip the effect covers it whole.
      s.properties = JSON.parse(JSON.stringify({ props: {}, effects: effects.map(({ span: _, ...fx }) => fx) }));
      s.clipboard = null;
    },
  }),
  sessionCommand({
    id: "clipboard.copy",
    description:
      "Copy clips for `clip.paste`: the given clips, else the selection, else what every unlocked track holds in the in/out range (⌘C). Cut is a copy then `clip.remove`",
    args: z.strictObject({ clips: z.array(z.string()).optional() }),
    apply: (s, { clips }, { project, registry }) => {
      const ids = clips ?? (s.selection.length ? s.selection : undefined);
      const range = s.range ? ([secondsToTicks(s.range.in), secondsToTicks(s.range.out)] as [number, number]) : undefined;
      const board = copyClips(project, ids ? { clips: ids } : { range }, (c) => registry.hasTrait(c.type, "hold"));
      if (!board) throw new Error("nothing to copy: select clips or set an in/out range");
      s.clipboard = board as Session["clipboard"];
    },
  }),
  sessionCommand({
    id: "properties.copy",
    description:
      "Copy a clip's properties (transform, crop, cursor, audio, callout style... and its effects) for `clip.pasteProperties`: the given clip, else the first selected one (Copy Properties, ⇧⌘C)",
    args: z.strictObject({ clip: z.string().optional() }),
    apply: (s, { clip }, { project, registry }) => {
      const id = clip ?? s.selection[0];
      const c = topClips(project).find((x) => x.clip.id === id)?.clip;
      if (!c) throw new Error(id ? `no clip "${id}" on the timeline` : "select a clip first");
      // Which stream it shows and a group's own tracks belong to the clip, not its look.
      const own = new Set(registry.groupsFor(c.type).filter((g) => g.nested || g.identity).map((g) => g.id));
      const props = Object.fromEntries(Object.entries(c.props).filter(([k]) => !own.has(k))) as CopiedProperties["props"];
      s.properties = JSON.parse(JSON.stringify({ props, effects: c.effects }));
    },
  }),
  sessionCommand({
    id: "panel.show",
    description: `Show a tool panel on the left (${TOOL_PANELS.join(", ")}; null collapses it) and/or open or close the properties panel`,
    args: z.strictObject({ tool: z.enum(TOOL_PANELS).nullable().optional(), properties: z.boolean().optional() }),
    apply: (s, { tool, properties }) => {
      if (tool !== undefined) s.panels.tool = tool;
      if (properties !== undefined) s.panels.properties = properties;
    },
  }),
  sessionCommand({
    id: "inspector.tab",
    description: 'Show a tab of the properties panel: a property group id (e.g. "transform", "cursor"), "effects", "audio" or "speed"',
    args: z.strictObject({ tab: z.string().min(1) }),
    apply: (s, { tab }, { registry }) => {
      if (tab !== "effects" && tab !== "audio" && tab !== "speed" && !registry.propGroups.has(tab)) {
        throw new Error(`no property group "${tab}"; there are: ${[...registry.propGroups.keys()].join(", ")}, effects, audio, speed`);
      }
      s.inspector = tab;
      s.panels.properties = true;
    },
  }),
  sessionCommand({
    id: "canvas.zoom",
    description:
      'Zoom the canvas preview: "fit" (⌘0, centred), a percent (100 = actual size, ⌥Z), or "in"/"out" (⌘= / ⌘-); `pan`: the canvas point (pixels from its centre, y down) to show at the view\'s centre, as the wheel and a middle-button drag set it',
    args: z.strictObject({ zoom: z.union([z.enum(["fit", "in", "out"]), z.number().min(5).max(800)]), pan: z.tuple([z.number(), z.number()]).optional() }),
    apply: (s, { zoom, pan }, ctx) => {
      if (zoom === "fit") {
        s.canvas = { ...s.canvas, zoom, pan: [0, 0] };
        return;
      }
      if (pan) s.canvas.pan = pan;
      if (typeof zoom === "number") {
        s.canvas.zoom = zoom;
        return;
      }
      const steps = [10, 25, 33, 50, 66, 75, 100, 150, 200, 300, 400];
      const current = s.canvas.zoom === "fit" ? ctx.fitPercent ?? 50 : s.canvas.zoom;
      const next = zoom === "in" ? steps.find((x) => x > current + 0.5) : steps.findLast((x) => x < current - 0.5);
      s.canvas.zoom = next ?? current;
    },
  }),
];

/** A clip's nested tracks (groups, stitched media), through the prop groups that declare them. */
export function nestedOf(registry: FeatureRegistry): (c: Clip) => Track[] | undefined {
  return (c) => {
    const g = registry.groupsFor(c.type).find((x) => x.nested);
    return g && c.props[g.id] ? g.nested!(c.props[g.id]) : undefined;
  };
}

export interface SessionChange {
  session: Session;
  /** Top-level fields that changed. */
  changed: (keyof Session)[];
}

/** One per open project: applies session commands, keeps the selection valid as the document changes. */
export class SessionStore {
  #state: Session;
  readonly #listeners = new Set<(c: SessionChange) => void>();
  /** Core's and the features'. */
  readonly commands: Map<string, SessionCommandDef>;
  /** The canvas's fit zoom in percent, reported by the app, for stepping from "fit". */
  fitPercent?: number;

  constructor(
    readonly registry: FeatureRegistry,
    project: Project,
    shared: Partial<SharedSession> = {},
  ) {
    this.#state = defaultSession(project, shared);
    this.commands = new Map([...SESSION_COMMANDS, ...registry.sessionCommands.values()].map((c) => [c.id, c]));
  }

  get state(): Session {
    return this.#state;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** `dryRun`: what would change, without changing it. */
  run(id: string, args: unknown, project: Project, opts: { dryRun?: boolean } = {}): SessionChange {
    const def = this.commands.get(id);
    if (!def) throw new Error(`no session command "${id}"`);
    const parsed = def.args.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`${id}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`);
    // With a group open, the editor works on its tracks, at main-timeline times.
    const ctx = { project: scopedProject(project, editScope(project, this.#state.group, nestedOf(this.registry))), full: project, registry: this.registry, fitPercent: this.fitPercent };
    const next = produce(this.#state, (d) => def.apply(d as Session, parsed.data, ctx));
    if (opts.dryRun) return { session: next, changed: changedKeys(this.#state, next) };
    return this.#set(next);
  }

  /** After a document change: drop deleted clips from the selection, keep the range inside the project. */
  reconcile(full: Project): SessionChange | undefined {
    const open = this.#state.group && full.tracks.some((t) => t.clips.some((c) => c.id === this.#state.group));
    const project = scopedProject(full, editScope(full, open ? this.#state.group : null, nestedOf(this.registry)));
    const ids = new Set(topClips(project).map((x) => x.clip.id));
    const last = snap(full, duration(full));
    const next = produce(this.#state, (d) => {
      if (!open) d.group = null;
      d.selection = d.selection.filter((id) => ids.has(id));
      if (d.animation && !topClips(project).some((x) => x.clip.id === d.animation!.clip && x.clip.animations.some((a) => a.id === d.animation!.id))) d.animation = null;
      const fx = new Set(topClips(project).flatMap((x) => x.clip.effects.map((e) => `${x.clip.id}/${e.id}`)));
      if (d.effects.some((e) => !fx.has(`${e.clip}/${e.id}`))) d.effects = d.effects.filter((e) => fx.has(`${e.clip}/${e.id}`));
      if (d.range && d.range.out > last) d.range = d.range.in < last ? { in: d.range.in, out: last } : null;
    });
    return next === this.#state ? undefined : this.#set(next);
  }

  /** Takes another open project's copies (clipboard, copied properties), so they paste here too. */
  share(shared: SharedSession): SessionChange {
    return this.#set(produce(this.#state, (d) => Object.assign(d, shared)));
  }

  /** Puts back an earlier state, e.g. the one before an action whose document change failed. */
  restore(state: Session): SessionChange {
    return this.#set(state);
  }

  subscribe(fn: (c: SessionChange) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(next: Session): SessionChange {
    const changed = changedKeys(this.#state, next);
    this.#state = next;
    const change = { session: next, changed };
    if (changed.length) for (const l of this.#listeners) l(change);
    return change;
  }
}

function changedKeys(a: Session, b: Session): (keyof Session)[] {
  return (Object.keys(b) as (keyof Session)[]).filter((k) => a[k] !== b[k]);
}

/** The session in a few lines, for agents. */
export function describeSession(s: Session, project: Project): string {
  const clips = new Map(topClips(project).map((x) => [x.clip.id, x]));
  const selected = s.selection.map((id) => {
    const x = clips.get(id);
    return x ? `${id} (${x.clip.type} on "${x.track.name}", ${roundSeconds(ticksToSeconds(x.clip.start))}–${roundSeconds(ticksToSeconds(end(x.clip)))} s)` : id;
  });
  const fmt = (t: number) => `${t.toFixed(2)} s`;
  return [
    `playhead ${fmt(s.playhead)} of ${fmt(duration(project))}${s.playing ? ", playing" : ", paused"}`,
    `selection: ${selected.length ? selected.join(", ") : "nothing"}`,
    `in/out range: ${s.range ? `${fmt(s.range.in)} – ${fmt(s.range.out)}` : "none"}`,
    `timeline shows ${fmt(s.timeline.start)} – ${fmt(s.timeline.end)}, tracks ${s.timeline.trackHeight} pt tall`,
    `panels: tools ${s.panels.tool ?? "collapsed"}, properties ${s.panels.properties ? `open (${s.inspector} tab)` : "closed"}`,
    `canvas zoom: ${s.canvas.zoom === "fit" ? "fit" : `${s.canvas.zoom}%`}`,
    `snapping ${s.snapping ? "on" : "off"}; clipboard: ${s.clipboard ? `${s.clipboard.items.length} clips` : "empty"}; properties copied: ${s.properties ? Object.keys(s.properties.props).join(", ") || "effects only" : "none"}`,
  ].join("\n");
}
