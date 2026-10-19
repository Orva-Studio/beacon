import type { z } from "zod";
import type { ActionDef, AnalyzerDef, AnnotationDef, ClipTypeDef, CommandDef, EffectDef, ExportFileDef, Feature, JobAnalyzerDef, MediaImporterDef, PanelItemDef, PreferenceDef, PropGroupDef, QueryContext, QueryDef, RenderPassDef, ResourceDef, SecretDef } from "./feature";
import type { SessionCommandDef } from "./session";
import { CORE_COMMANDS } from "./commands";
import type { Patch } from "immer";
import { ClipSchema, formatIssues, ProjectSchema, type Clip, type Project, type Track } from "./schema";

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid project:\n  ${issues.join("\n  ")}`);
    this.name = "ValidationError";
  }
}

function zodIssues(path: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${[path, ...i.path].filter((p) => p !== "").join(".")}: ${i.message}`);
}

/** An effect the Visual Effects panel shows (and favourites can name): any not only for the cursor. */
export const isPanelEffect = (traits: string[]) => !traits.every((t) => t === "cursor");

export class FeatureRegistry {
  readonly features = new Map<string, Feature>();
  readonly clipTypes = new Map<string, ClipTypeDef>();
  readonly propGroups = new Map<string, PropGroupDef>();
  readonly effects = new Map<string, EffectDef>();
  readonly passes = new Map<string, RenderPassDef>();
  readonly commands = new Map<string, CommandDef>();
  readonly analyzers = new Map<string, AnalyzerDef>();
  readonly jobAnalyzers = new Map<string, JobAnalyzerDef>();
  readonly resources = new Map<string, ResourceDef>();
  readonly preferences = new Map<string, PreferenceDef>();
  readonly secrets = new Map<string, SecretDef>();
  readonly queries = new Map<string, QueryDef>();
  readonly importers = new Map<string, MediaImporterDef>();
  readonly actions = new Map<string, ActionDef>();
  readonly exportFiles = new Map<string, ExportFileDef>();
  /** Features' editor commands (session state, not undoable), beside core's `SESSION_COMMANDS`. */
  readonly sessionCommands = new Map<string, SessionCommandDef>();
  /** Every feature's panel items (`Feature.panelItems`), in registration order. */
  readonly panelItems: PanelItemDef[] = [];
  readonly annotations = new Map<string, AnnotationDef & { id: string }>();
  /** A new user's Favorites panel: the items and effects features mark `favorite`, in registration order. */
  readonly favorites: string[] = [];

  constructor(features: Feature[] = []) {
    claim(this.commands, CORE_COMMANDS, "command", "core");
    for (const f of features) this.register(f);
  }

  register(feature: Feature): this {
    this.#groups.clear();
    if (this.features.has(feature.id)) throw new Error(`feature "${feature.id}" registered twice`);
    if (!Number.isInteger(feature.version) || feature.version < 1) {
      throw new Error(`feature "${feature.id}" version must be a positive integer`);
    }
    claim(this.clipTypes, feature.clipTypes ?? [], "clip type", feature.id);
    claim(this.propGroups, feature.props ?? [], "prop group", feature.id);
    claim(this.effects, feature.effects ?? [], "effect", feature.id);
    claim(this.passes, feature.passes ?? [], "render pass", feature.id);
    claim(this.commands, feature.commands ?? [], "command", feature.id);
    claim(this.analyzers, feature.analyzers ?? [], "analyzer", feature.id);
    claim(this.jobAnalyzers, feature.jobAnalyzers ?? [], "analyzer", feature.id);
    claim(this.resources, feature.resources ?? [], "resource", feature.id);
    claim(this.preferences, feature.preferences ?? [], "preference", feature.id);
    claim(this.secrets, feature.secrets ?? [], "secret", feature.id);
    for (const a of feature.jobAnalyzers ?? []) if (typeof a.needs === "string" && !this.resources.has(a.needs)) throw new Error(`analyzer "${a.id}" needs resource "${a.needs}", which no feature registers`);
    for (const p of feature.preferences ?? []) {
      if (!p.options.some((o) => o.id === p.default)) throw new Error(`preference "${p.id}": default "${p.default}" isn't one of its options`);
      for (const o of p.options) if (o.secret && !this.secrets.has(o.secret)) throw new Error(`preference "${p.id}": option "${o.id}" needs secret "${o.secret}", which no feature registers`);
    }
    // Both kinds are read by the same key, so an id may be one or the other.
    for (const a of [...(feature.analyzers ?? []), ...(feature.jobAnalyzers ?? [])]) {
      if (this.analyzers.has(a.id) && this.jobAnalyzers.has(a.id)) throw new Error(`analyzer "${a.id}" from feature "${feature.id}" is already registered`);
    }
    claim(this.queries, feature.queries ?? [], "query", feature.id);
    claim(this.importers, feature.importers ?? [], "importer", feature.id);
    for (const a of feature.actions ?? []) if (this.commands.has(a.id)) throw new Error(`action "${a.id}" from feature "${feature.id}" is already a command`);
    claim(this.actions, feature.actions ?? [], "action", feature.id);
    claim(this.sessionCommands, feature.sessionCommands ?? [], "session command", feature.id);
    claim(this.exportFiles, feature.exportFiles ?? [], "export file", feature.id);
    for (const item of feature.panelItems ?? []) {
      if (this.panelItems.some((i) => i.id === item.id)) throw new Error(`panel item "${item.id}" from feature "${feature.id}" is already registered`);
      this.panelItems.push(item);
    }
    claim(this.annotations, Object.entries(feature.annotations ?? {}).map(([id, a]) => ({ ...a, id })), "annotation", feature.id);
    this.favorites.push(...(feature.panelItems ?? []).filter((i) => i.favorite).map((i) => i.id), ...(feature.effects ?? []).filter((e) => e.favorite).map((e) => `effect:${e.id}`));
    this.features.set(feature.id, feature);
    return this;
  }

  command(id: string): CommandDef {
    const def = this.commands.get(id);
    if (!def) throw new Error(`unknown command "${id}"`);
    return def;
  }

  /** Runs a query with validated args. */
  runQuery(id: string, args: unknown, ctx: QueryContext): unknown {
    const def = this.query(id);
    const parsed = def.args.safeParse(args ?? {});
    if (!parsed.success) throw new Error(`${id}: ${formatIssues(parsed.error)}`);
    return def.run(parsed.data, ctx);
  }

  query(id: string): QueryDef {
    const def = this.queries.get(id);
    if (!def) throw new Error(`unknown query "${id}"`);
    return def;
  }

  /** The importer for a file extension (with the dot, any case). */
  importerFor(ext: string): MediaImporterDef | undefined {
    const e = ext.toLowerCase();
    return [...this.importers.values()].find((i) => i.extensions.includes(e));
  }

  clipType(id: string): ClipTypeDef {
    const def = this.clipTypes.get(id);
    if (!def) throw new Error(`unknown clip type "${id}"`);
    return def;
  }

  /** Prop groups that apply to a clip type, in registration order; those kept on its track are left out. */
  groupsFor(clipType: string): PropGroupDef[] {
    // Asked per clip per frame: worked out once per type, again only when a feature registers.
    let groups = this.#groups.get(clipType);
    if (!groups) {
      const traits = this.clipTypes.get(clipType)?.traits ?? [];
      groups = [...this.propGroups.values()].filter((g) => !g.track && g.traits.some((t) => traits.includes(t)));
      this.#groups.set(clipType, groups);
    }
    return groups;
  }
  readonly #groups = new Map<string, PropGroupDef[]>();

  /** A clip type's prop group `id`, if it has that group. */
  group(clipType: string, id: string): PropGroupDef | undefined {
    return this.groupsFor(clipType).find((g) => g.id === id);
  }

  /** Whether effect `effectType` applies to clips of `clipType` (they share a trait). */
  effectFits(effectType: string, clipType: string): boolean {
    const traits = this.clipTypes.get(clipType)?.traits ?? [];
    return this.effect(effectType).traits.some((t) => traits.includes(t));
  }

  /** The tracks nested in a clip (a group's, stitched media's pieces), to read: a new list, so to add or remove one use `walkClips`' `tracks`. */
  nestedTracks(clip: Clip): Track[] {
    return this.groupsFor(clip.type).flatMap((g) => (g.nested && clip.props[g.id] ? g.nested(clip.props[g.id]) : []));
  }

  hasTrait(clipType: string, trait: string): boolean {
    return this.clipTypes.get(clipType)?.traits.includes(trait) ?? false;
  }

  effect(id: string): EffectDef {
    const def = this.effects.get(id);
    if (!def) throw new Error(`unknown effect "${id}"`);
    return def;
  }

  /** Core shape, then every clip's props and effect params against their feature schemas. */
  validate(doc: unknown): asserts doc is Project {
    const core = ProjectSchema.safeParse(doc);
    if (!core.success) throw new ValidationError(zodIssues("", core.error));
    const issues: string[] = [];
    const project = doc as Project;
    const clipIds = new Set<string>();
    const trackIds = new Set<string>();
    for (const [ti, track] of project.tracks.entries()) {
      if (trackIds.has(track.id)) issues.push(`tracks.${ti}: duplicate track id "${track.id}"`);
      trackIds.add(track.id);
      this.#validateTrack(project, track, `tracks.${ti}`, clipIds, issues);
      for (const [ci, clip] of track.clips.entries()) {
        if (clip.start < 0) issues.push(`tracks.${ti}.clips.${ci}: starts before the timeline`);
      }
    }
    for (const [key, asset] of Object.entries(project.assets)) {
      if (asset.id !== key) issues.push(`assets.${key}: id "${asset.id}" does not match its key`);
    }
    if (issues.length) throw new ValidationError(issues);
  }

  /**
   * `validate` after a change that touched only top-level clips' props, effects or animations (a drag on the
   * canvas, a slider): those clips, as `validate` checks them, for a fraction of the time on a long timeline.
   * Any other change, or props holding nested tracks, checks the whole document.
   */
  validateChanged(doc: Project, patches: readonly Patch[]): void {
    const touched = new Map<string, [number, number]>();
    for (const { path } of patches) {
      const [tracks, ti, clips, ci, field, group] = path;
      const partOfClip = tracks === "tracks" && typeof ti === "number" && clips === "clips" && typeof ci === "number" && (field === "props" || field === "effects" || field === "animations");
      if (!partOfClip || (field === "props" && (group === undefined || this.propGroups.get(String(group))?.nested))) return this.validate(doc);
      touched.set(`${ti}/${ci}`, [ti, ci]);
    }
    const issues: string[] = [];
    for (const [ti, ci] of touched.values()) {
      const clip = doc.tracks[ti]?.clips[ci];
      if (!clip) return this.validate(doc);
      const path = `tracks.${ti}.clips.${ci}`;
      const shape = ClipSchema.safeParse(clip);
      if (!shape.success) issues.push(...zodIssues(path, shape.error));
      else this.#validateClip(doc, clip, path, new Set(), issues);
    }
    if (issues.length) throw new ValidationError(issues);
  }

  #validateTrack(project: Project, track: Track, path: string, clipIds: Set<string>, issues: string[]) {
    for (const [key, value] of Object.entries(track.props ?? {})) {
      const group = this.propGroups.get(key);
      if (!group?.track) {
        issues.push(`${path}.props.${key}: no track prop group "${key}"`);
        continue;
      }
      const r = group.schema.safeParse(value);
      if (!r.success) issues.push(...zodIssues(`${path}.props.${key}`, r.error));
    }
    let end = -Infinity;
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (const [ci, clip] of track.clips.entries()) {
      const at = `${path}.clips.${ci}`;
      if (clipIds.has(clip.id)) issues.push(`${at}: duplicate clip id "${clip.id}"`);
      clipIds.add(clip.id);
      this.#validateClip(project, clip, at, clipIds, issues);
    }
    for (const clip of sorted) {
      if (clip.start < end) issues.push(`${path}: clip "${clip.id}" overlaps the previous clip`);
      end = Math.max(end, clip.start + clip.duration);
    }
  }

  #validateClip(project: Project, clip: Clip, path: string, clipIds: Set<string>, issues: string[]) {
    const type = this.clipTypes.get(clip.type);
    if (!type) {
      issues.push(`${path}: unknown clip type "${clip.type}"`);
      return;
    }
    const groups = new Map(this.groupsFor(clip.type).map((g) => [g.id, g]));
    for (const [key, value] of Object.entries(clip.props)) {
      const group = groups.get(key);
      if (!group) {
        issues.push(`${path}.props.${key}: no prop group "${key}" for clip type "${clip.type}"`);
        continue;
      }
      const r = group.schema.safeParse(value);
      if (!r.success) issues.push(...zodIssues(`${path}.props.${key}`, r.error));
      else if (group.nested) {
        for (const [ti, track] of group.nested(value).entries()) {
          this.#validateTrack(project, track, `${path}.props.${key}.tracks.${ti}`, clipIds, issues);
        }
      }
    }
    if (clip.assetId !== undefined && !project.assets[clip.assetId]) {
      issues.push(`${path}: unknown asset "${clip.assetId}"`);
    }
    for (const [ei, effect] of clip.effects.entries()) {
      const def = this.effects.get(effect.type);
      if (!def) {
        issues.push(`${path}.effects.${ei}: unknown effect "${effect.type}"`);
        continue;
      }
      if (!def.traits.some((t) => type.traits.includes(t))) {
        issues.push(`${path}.effects.${ei}: effect "${effect.type}" does not apply to "${clip.type}" clips`);
      }
      const params = def.params.safeParse(effect.params);
      if (!params.success) issues.push(...zodIssues(`${path}.effects.${ei}.params`, params.error));
    }
    for (const [ai, anim] of clip.animations.entries()) {
      for (const target of Object.keys(anim.to)) {
        const [group, field] = target.split(".", 2);
        if (!groups.get(group!)?.animatable?.includes(field ?? "")) {
          issues.push(`${path}.animations.${ai}: "${target}" is not an animatable property of "${clip.type}" clips`);
        }
      }
    }
  }
}

function claim<T extends { id: string }>(map: Map<string, T>, items: T[], what: string, feature: string) {
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`${what} "${item.id}" from feature "${feature}" is already registered`);
    map.set(item.id, item);
  }
}
