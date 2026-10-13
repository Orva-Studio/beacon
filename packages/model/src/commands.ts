import { z } from "zod";
import { defineCommand, type CommandDef } from "./feature";
import { isFree } from "./edit";
import type { FeatureRegistry } from "./registry";
import { AssetSchema, IdSchema as Id, RationalSchema, SettingsSchema, trackName, type Clip, type Project, type Track } from "./schema";
import { secondsToTicks, snapSeconds, ticksToSeconds, type Ticks } from "./ticks";

const Seconds = z.number().nonnegative();

export interface ClipLocation {
  clip: Clip;
  track: Track;
  /** The list the track is in: the timeline's, or a group's. */
  tracks: Track[];
  /**
   * What to take off a main-timeline time to get one on the clip's own
   * track: 0 on the timeline; inside a group, where the group's inner
   * timeline starts on the main one (through every level). Commands take
   * main-timeline seconds and convert with it. (Groups with a speed change
   * aren't accounted for.)
   */
  offset: Ticks;
}

/**
 * Puts clips starting together at `time` on adjacent tracks, bottom to top:
 * from `track`, refused over other media there, with new tracks above where
 * the next are taken; else on the lowest run of tracks free for them (new
 * tracks on top when there is none). Linked by their `link` keys, or all
 * together when they have none.
 */
function placeClips(
  doc: Project,
  ctx: { newId: (prefix: string) => string },
  specs: { type: string; duration: Ticks; props: Clip["props"]; assetId?: string; link?: string }[],
  time: number,
  track?: string,
): string[] {
  const start = snapSeconds(time, doc.settings.fps);
  // One link per key shared by two or more clips; without keys, one for them all.
  const links = new Map<string | undefined, string>();
  const keys = specs.map((spec) => (specs.some((x) => x.link !== undefined) ? spec.link : ""));
  for (const k of keys) if (k !== undefined && keys.filter((x) => x === k).length > 1 && !links.has(k)) links.set(k, ctx.newId("link"));
  const add = (index: number) => {
    const t: Track = { id: ctx.newId("track"), name: "", clips: [] };
    doc.tracks.splice(index, 0, t);
    return t;
  };
  const durations = specs.map((spec) => snapSeconds(ticksToSeconds(spec.duration), doc.settings.fps));
  if (durations.some((d) => d <= 0)) throw new Error("duration is under one frame");
  const takes = (t: Track | undefined, i: number) => !t || (!t.locked && (t.magnetic || isFree(t, start, start + durations[i]!)));
  const base = track === undefined ? doc.tracks.findIndex((_, b) => specs.every((_, i) => takes(doc.tracks[b + i], i))) : doc.tracks.findIndex((t) => t.id === track);
  if (track !== undefined && base < 0) throw new Error(`no track "${track}" on the timeline`);
  // No run of free tracks: new ones on top.
  const from = base < 0 ? doc.tracks.length : base;
  return specs.map((spec, i) => {
    const at = doc.tracks[from + i];
    if (i === 0 && track !== undefined) {
      if (at!.locked) throw new Error(`track "${trackName(at!, from)}" is locked`);
      if (!takes(at, 0)) throw new Error(`it would overlap media on "${trackName(at!, from)}"`);
    }
    const t = at && takes(at, i) ? at : add(from + i);
    const id = ctx.newId("clip");
    t.clips.push({ id, type: spec.type, start, duration: durations[i]!, mediaStart: 0, ...(spec.assetId ? { assetId: spec.assetId } : {}), ...(links.has(keys[i]) ? { linkId: links.get(keys[i]) } : {}), props: spec.props, effects: [], animations: [] });
    return id;
  });
}

/** Every clip, including those inside groups (any prop group with `nested` tracks). */
export function* walkClips(tracks: Track[], registry: FeatureRegistry, offset: Ticks = 0): Generator<ClipLocation> {
  for (const track of tracks) {
    for (const clip of track.clips) {
      yield { clip, track, tracks, offset };
      for (const g of registry.groupsFor(clip.type)) {
        if (g.nested && clip.props[g.id]) yield* walkClips(g.nested(clip.props[g.id]), registry, offset + clip.start - (clip.mediaStart ?? 0));
      }
    }
  }
}


export function findTrack(doc: Project, id: string, registry?: FeatureRegistry): Track {
  return locateTrack(doc, id, registry).track;
}

/** A track and the list it is in: the timeline's, or with `registry`, a group's or stitched clip's. */
export function locateTrack(doc: Project, id: string, registry?: FeatureRegistry): { track: Track; list: Track[] } {
  const lists = [doc.tracks];
  if (registry) for (const { clip } of walkClips(doc.tracks, registry)) for (const g of registry.groupsFor(clip.type)) if (g.nested && clip.props[g.id]) lists.push(g.nested(clip.props[g.id]));
  for (const list of lists) {
    const track = list.find((t) => t.id === id);
    if (track) return { track, list };
  }
  throw new Error(`no track "${id}"`);
}


/**
 * Commands over the document's own structure (settings, tracks, assets,
 * adding clips), which every registry has; editing behaviour lives in features.
 */
export const CORE_COMMANDS: CommandDef[] = [
  defineCommand({
    id: "project.settings.set",
    description: "Change project settings (canvas size, frame rate, background colour, loudness target); `loudnessTarget: null` turns Auto-normalize loudness off",
    args: SettingsSchema.partial().extend({ loudnessTarget: z.number().nullable().optional() }),
    apply(doc, { loudnessTarget, ...args }) {
      Object.assign(doc.settings, args);
      if (loudnessTarget === null) delete doc.settings.loudnessTarget;
      else if (loudnessTarget !== undefined) doc.settings.loudnessTarget = loudnessTarget;
    },
  }),

  defineCommand({
    id: "track.add",
    description: "Add an empty track. Tracks are ordered bottom to top; `index` defaults to the top. Returns the track id",
    args: z.strictObject({ name: z.string(), index: z.int().nonnegative().optional() }),
    apply(doc, { name, index }, ctx) {
      const id = ctx.newId("track");
      doc.tracks.splice(index ?? doc.tracks.length, 0, { id, name, clips: [] });
      return id;
    },
  }),

  defineCommand({
    id: "track.set",
    description: "Rename, hide, mute or lock a track, or make it magnetic (no gaps: its clips are packed from the start)",
    args: z.strictObject({
      track: Id,
      name: z.string().optional(),
      hidden: z.boolean().optional(),
      muted: z.boolean().optional(),
      locked: z.boolean().optional(),
      magnetic: z.boolean().optional(),
    }),
    apply(doc, { track, ...rest }, ctx) {
      Object.assign(findTrack(doc, track, ctx.registry), rest);
    },
  }),

  defineCommand({
    id: "track.remove",
    description: "Remove a track and its clips",
    args: z.strictObject({ track: Id }),
    apply(doc, { track }, ctx) {
      const { track: t, list } = locateTrack(doc, track, ctx.registry);
      list.splice(list.indexOf(t), 1);
    },
  }),

  defineCommand({
    id: "track.removeEmpty",
    description: "Remove every track with no clips",
    args: z.strictObject({}),
    apply(doc) {
      for (let i = doc.tracks.length - 1; i >= 0; i--) if (!doc.tracks[i]!.clips.length) doc.tracks.splice(i, 1);
    },
  }),

  defineCommand({
    id: "track.move",
    description: "Move a track to another position (0 is the bottom), changing what covers what",
    args: z.strictObject({ track: Id, index: z.int().nonnegative() }),
    apply(doc, { track, index }, ctx) {
      const { track: t, list } = locateTrack(doc, track, ctx.registry);
      list.splice(list.indexOf(t), 1);
      list.splice(Math.min(index, list.length), 0, t);
    },
  }),

  defineCommand({
    id: "asset.add",
    description: "Add a media asset record. Prefer the import tool, which probes the file and adds clips; returns the asset id",
    args: AssetSchema.omit({ id: true }).extend({ derived: AssetSchema.shape.derived.default({}) }),
    apply(doc, args, ctx) {
      const id = ctx.newId("asset");
      doc.assets[id] = { id, ...args };
      return id;
    },
  }),

  defineCommand({
    id: "asset.remove",
    description: "Remove an asset no clip uses",
    args: z.strictObject({ asset: Id }),
    apply(doc, { asset }, ctx) {
      for (const { clip } of walkClips(doc.tracks, ctx.registry)) if (clip.assetId === asset) throw new Error(`asset "${asset}" is used by clip "${clip.id}"`);
      delete doc.assets[asset];
    },
  }),

  defineCommand({
    id: "asset.rename",
    description: "Rename media in the Media Bin (and on its clips); an empty name goes back to the file's name",
    args: z.strictObject({ asset: Id, name: z.string() }),
    apply(doc, { asset, name }) {
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      if (name.trim()) a.name = name.trim();
      else delete a.name;
    },
  }),

  defineCommand({
    id: "asset.relink",
    description: "Point media at its file's new place after it was moved (Locate… on missing media); agents use media_relink, which checks the file is the same media",
    args: z.strictObject({ asset: Id, path: AssetSchema.shape.path, fingerprint: z.string() }),
    apply(doc, { asset, path, fingerprint }) {
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      a.path = path;
      a.fingerprint = fingerprint;
    },
  }),

  defineCommand({
    id: "asset.place",
    description:
      "Put media from the Media Bin on the timeline at `time`, as importing it does (a recording's screen, camera and audio on tracks next to each other, its camera and audio linked). With `track`, its first clip goes on that track and the others on the tracks above it (new tracks where those are taken); without, on the lowest tracks free there (new tracks above the top one). Refused over other media on `track`. Returns the clip ids",
    args: z.strictObject({ asset: Id, time: Seconds, track: Id.optional() }),
    apply(doc, { asset, time, track }, ctx) {
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      const importer = ctx.registry.importerFor(a.path.slice(a.path.lastIndexOf(".")));
      if (!importer) throw new Error(`no feature places ${a.path}`);
      return placeClips(doc, ctx, importer.clips(a, doc).map((spec) => ({ ...spec, assetId: asset })), time, track);
    },
  }),

  defineCommand({
    id: "clip.place",
    description:
      "Add a clip at `time` on the lowest track free for it (a new one on top if none), or on `track`, refused over other media there: how the editor adds annotations. `effects` are added with their default params, overridden by `params`. Returns its id",
    args: z.strictObject({
      type: z.string().min(1),
      props: z.record(z.string(), z.unknown()).default({}),
      effects: z.array(z.strictObject({ type: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) })).default([]),
      duration: Seconds,
      time: Seconds,
      track: Id.optional(),
    }),
    apply(doc, { type, props, effects, duration, time, track }, ctx) {
      const [id] = placeClips(doc, ctx, [{ type, duration: secondsToTicks(duration), props }], time, track);
      const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
      clip.effects = effects.map((fx) => ({ id: ctx.newId("fx"), type: fx.type, enabled: true, params: { ...ctx.registry.effect(fx.type).defaults(), ...fx.params } }));
      return id;
    },
  }),

  defineCommand({
    id: "clip.add",
    description: "Add a clip to a track. Times in seconds; `mediaStart` is the source position shown at `start`. Returns the clip id",
    args: z.strictObject({
      track: Id,
      type: z.string().min(1),
      start: Seconds,
      duration: Seconds,
      mediaStart: z.number().optional(),
      speed: RationalSchema.optional(),
      assetId: Id.optional(),
      linkId: Id.optional(),
      props: z.record(z.string(), z.unknown()).default({}),
    }),
    apply(doc, { track, start, duration, mediaStart, ...rest }, ctx) {
      const id = ctx.newId("clip");
      const clip: Clip = { id, start: snapSeconds(start, doc.settings.fps), duration: snapSeconds(duration, doc.settings.fps), ...rest, effects: [], animations: [] };
      if (mediaStart !== undefined) clip.mediaStart = secondsToTicks(mediaStart);
      if (clip.duration <= 0) throw new Error("duration is under one frame");
      findTrack(doc, track).clips.push(clip);
      return id;
    },
  }),
];
