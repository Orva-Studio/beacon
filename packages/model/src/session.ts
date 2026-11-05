import { produce } from "immer";
import { NO_MEMORY, type Memory } from "./feature";
import type { FeatureRegistry } from "./registry";
import { formatIssues, type Project } from "./schema";
import { projectDuration } from "./project";
import { editScope, scopedProject } from "./edit";
import { roundSeconds, ticksToSeconds } from "./ticks";
import { snap, duration, end, topClips, nestedOf, type Session, type SessionCommandDef, type SharedSession, TRACK_HEIGHT } from "./session/shared";
import { PLAYBACK_COMMANDS } from "./session/playback";
import { SELECTION_COMMANDS } from "./session/selection";
import { TIMELINE_VIEW_COMMANDS } from "./session/timeline-view";
import { CLIPBOARD_COMMANDS } from "./session/clipboard";
import { PANEL_COMMANDS } from "./session/panels";

export { inspectorTabs, nestedOf, TRACK_HEIGHT, type Session, type SharedSession, type SessionContext, type SessionCommandDef } from "./session/shared";

function defaultSession(project: Project, shared: Partial<SharedSession> = {}): Session {
  const end = Math.max(10, ticksToSeconds(projectDuration(project)));
  return {
    playhead: 0,
    playing: false,
    rate: 1,
    selection: [],
    animation: null,
    effects: [],
    group: null,
    track: null,
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

export const SESSION_COMMANDS: SessionCommandDef[] = [
  ...PLAYBACK_COMMANDS,
  ...SELECTION_COMMANDS,
  ...TIMELINE_VIEW_COMMANDS,
  ...CLIPBOARD_COMMANDS,
  ...PANEL_COMMANDS,
];

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
    readonly pref: (id: string) => string = (id) => registry.preferences.get(id)?.default ?? "",
    readonly data: <T>(assetId: string, key: string) => T | undefined = () => undefined,
    readonly memory: Memory = NO_MEMORY,
  ) {
    this.#state = defaultSession(project, shared);
    this.commands = new Map([...SESSION_COMMANDS, ...registry.sessionCommands.values()].map((c) => [c.id, c]));
  }

  get state(): Session {
    return this.#state;
  }

  /** Features' state kept with the project (`Feature.sessionSaved`), put back when it is opened. */
  reopen(features: Record<string, unknown>) {
    this.#state = produce(this.#state, (d) => void Object.assign(d.features, features));
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** `dryRun`: what would change, without changing it. */
  run(id: string, args: unknown, project: Project, opts: { dryRun?: boolean } = {}): SessionChange {
    const def = this.commands.get(id);
    if (!def) throw new Error(`no session command "${id}"`);
    const parsed = def.args.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`${id}: ${formatIssues(parsed.error)}`);
    // With a group open, the editor works on its tracks, at main-timeline times.
    const ctx = { project: scopedProject(project, editScope(project, this.#state.group, nestedOf(this.registry))), full: project, registry: this.registry, fitPercent: this.fitPercent, pref: this.pref, data: this.data, memory: opts.dryRun ? { ...this.memory, record: () => {} } : this.memory };
    // One panel with Cancel and Apply at a time (a review, Clean with Auphonic): opening one cancels any other.
    const open = this.registry.panels.filter((p) => p.open(this.#state));
    const next = produce(this.#state, (d) => {
      def.apply(d as Session, parsed.data, ctx);
      if (this.registry.panels.some((p) => !open.includes(p) && p.open(d as Session))) {
        for (const p of open) if (p.open(d as Session)) this.commands.get(p.cancel)!.apply(d as Session, {}, ctx);
      }
    });
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
