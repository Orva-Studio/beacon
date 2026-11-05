import { z } from "zod";
import { clipSpeed, timelineTimeAt } from "../evaluate";
import type { Memory } from "../feature";
import type { FeatureRegistry } from "../registry";
import type { Animation, Clip, EffectInstance, Project, Track } from "../schema";
import { projectDuration } from "../project";
import type { Clipboard } from "../edit";
import { roundSeconds, snapSeconds, ticksPerFrame, ticksToSeconds } from "../ticks";

/** A range just made is what Delete, Cut and Copy act on next: the last thing selected wins, so clips selected before it are let go. */
export function rangeMade(s: Session) {
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
  /** The track whose header was clicked last: Lock Track and Mute Track act on it when no clip is selected. */
  track: string | null;
  range: { in: number; out: number } | null;
  /** The timeline's visible span in seconds, and every track's height in points. */
  /** `top`: points the tracks are scrolled up by, when there are more than fit (none: the top track under the ruler). */
  timeline: { start: number; end: number; trackHeight: number; top?: number };
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
  /** The clip type copied from: what effects it could have had, so a paste removes those it didn't. */
  type?: string;
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
  /** The app's preferences (a review's last settings). */
  pref: (id: string) => string;
  /** Media's derived data (transcripts), for a command that picks what it finds (a silence). */
  data: <T>(assetId: string, key: string) => T | undefined;
  /** The user's review decisions: a review opens with the habits learned from them, and records more. */
  memory: Memory;
}

export interface SessionCommandDef<A = any> {
  id: string;
  description: string;
  args: z.ZodType<A>;
  apply: (s: Session, args: A, ctx: SessionContext) => void;
}

/**
 * A clip's properties tabs, in order: its groups' (`groupTabs`), Clip Speed once changed or asked for (`inspector`)
 * when it can change speed (`retimes`), Effects when it has any.
 */
export function inspectorTabs(clip: Clip, groupTabs: readonly string[], retimes: boolean, inspector: string): string[] {
  const tabs = [...groupTabs];
  if ((clip.assetId || retimes) && (clipSpeed(clip) !== 1 || inspector === "speed")) tabs.push("speed");
  if (clip.effects.length) tabs.push("effects");
  return tabs;
}

export const inspected = (s: Session, project: Project) => project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selection[0]);

/** The tool panels, in sidebar order. */
export const TOOL_PANELS = [
  "media",
  "annotations",
  "visualEffects",
  "audioEffects",
  "narration",
  "ai",
] as const;

export const TRACK_HEIGHT = { min: 26, max: 120, default: 44 };

export const MIN_SPAN_FRAMES = 10;


export const snap = (project: Project, seconds: number) => roundSeconds(ticksToSeconds(snapSeconds(Math.max(0, seconds), project.settings.fps)));
export const duration = (project: Project) => ticksToSeconds(projectDuration(project));
export const frame = (project: Project) => ticksToSeconds(ticksPerFrame(project.settings.fps));
export const end = (c: Clip) => c.start + c.duration;
export const topClips = (project: Project) => project.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, track: t })));

/** The clip ids plus every clip linked to them. */
export function withLinked(project: Project, ids: string[]): string[] {
  const all = topClips(project).map((x) => x.clip);
  const links = new Set(all.filter((c) => ids.includes(c.id) && c.linkId).map((c) => c.linkId));
  return [...new Set([...ids, ...all.filter((c) => c.linkId && links.has(c.linkId)).map((c) => c.id)])];
}

/** Timeline seconds of every clip start and end, marker and animation block edge, sorted. */
export function stops(project: Project, kind: "edit" | "marker" | "animation"): number[] {
  const out: number[] = [];
  if (kind === "marker") for (const m of project.markers) out.push(m.time);
  for (const { clip } of topClips(project)) {
    if (kind === "edit") out.push(clip.start, end(clip));
    if (kind === "animation") {
      for (const a of clip.animations) {
        for (const media of [a.end - a.duration, a.end]) {
          const t = timelineTimeAt(clip, media);
          if (t >= clip.start && t <= end(clip)) out.push(t);
        }
      }
    }
  }
  return [...new Set(out.map((t) => roundSeconds(ticksToSeconds(t))))].sort((a, b) => a - b);
}

/** Keeps the visible span inside [0, max(duration, span, playhead)] and at least a few frames long. */
export function setView(s: Session, project: Project, start: number, endAt: number) {
  const span = Math.max(MIN_SPAN_FRAMES * frame(project), endAt - start);
  const limit = Math.max(duration(project) * 1.05, span, s.playhead);
  const from = Math.min(Math.max(0, start), limit - span);
  s.timeline = { ...s.timeline, start: roundSeconds(from), end: roundSeconds(from + span) };
}

/** Zooms by `factor` (< 1 zooms in) around the playhead when it is visible, else the centre. */
export function zoomBy(s: Session, project: Project, factor: number) {
  const { start, end: e } = s.timeline;
  const anchor = s.playhead >= start && s.playhead <= e ? s.playhead : (start + e) / 2;
  setView(s, project, anchor - (anchor - start) * factor, anchor + (e - anchor) * factor);
}

export function sessionCommand<S extends z.ZodType>(def: { id: string; description: string; args: S; apply: (s: Session, args: z.output<S>, ctx: SessionContext) => void }): SessionCommandDef {
  return def as SessionCommandDef;
}

export const Time = z.number().nonnegative().describe("Timeline seconds");

/** A clip's nested tracks (groups, stitched media), through the prop groups that declare them. */
export function nestedOf(registry: FeatureRegistry): (c: Clip) => Track[] | undefined {
  return (c) => {
    const g = registry.groupsFor(c.type).find((x) => x.nested);
    return g && c.props[g.id] ? g.nested!(c.props[g.id]) : undefined;
  };
}
