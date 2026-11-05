import { rmSync } from "node:fs";
import { z } from "zod";
import {
  clipEnd,
  defineAction,
  defineFeature,
  defineQuery,
  assetName,
  mediaWindow,
  projectDuration,
  selectedClips,
  ticksToSeconds,
  type ActionContext,
  type ActionPlan,
  type ActionStep,
  type Asset,
  type Clip,
  type FeatureRegistry,
  type Project,
  type Session,
  type SessionCommandDef,
} from "@beacon/model";
import { mediaInfo } from "../media";
import { speechSpans } from "../transcript";
import { POP_TERMS, type PopKind } from "./pops";
import { download, downloadEdit, KEY, searchEffects, searchMusic, type Effect, type Page, type Track } from "./epidemic";
import { applySuggestion, suggest, type Suggestion } from "./suggest";
import { duckPoints, EDIT_MAX, freePath, keyOf, libraryOf, MUSIC_DEFAULTS, type LibraryInfo, type MusicPick } from "./shared";

export { duckPoints, libraryOf, MUSIC_DEFAULTS, type LibraryInfo, type MusicPick };

export { POP_TERMS, type PopKind };
export type { SoundKind, SuggestedSound, SuggestedTrack, Suggestion, SuggestOption } from "./suggest";
export type { Effect as SoundEffect, Page as MusicPage, Track as MusicTrack } from "./epidemic";




/** Where something pops onto the picture: its start (timeline seconds), its clip, and the sound it takes. */
export interface PopIn {
  time: number;
  clip: string;
  name: string;
  kind: PopKind;
}

/**
 * The Music panel is open (the AI panel's Music tile): music and sounds suggested from the talk, searching Epidemic
 * Sound for music or a sound effect to place, or sounds for the pop-ins.
 */
export interface MusicReview {
  open: true;
  tab: "suggest" | "music" | "sfx" | "popins";
  /** Suggest's findings, once music.suggest is done; `suggesting` while it works. */
  suggestion?: Suggestion;
  suggesting?: boolean;
  term: string;
  pick?: MusicPick;
  /** Over a range: Epidemic re-cuts the track to its length (`edit`), or it is cut there and faded out (`cut`). */
  fit: "edit" | "cut";
  /** A track with singing keeps it; off, its instruments alone (cut to fit: edits are of the full mix). */
  vocals: boolean;
  /** Dips under speech, as audio points. */
  duck: boolean;
  /** Its volume where no one speaks, and under speech (gains). */
  level: number;
  under: number;
  /** Pop-ins: the sound for each kind, and the pop-ins (by clip) left without one. */
  pops: { sounds: Partial<Record<PopKind, MusicPick>>; off: string[] };
}

export const musicReview = (s: Session) => s.features.music as MusicReview | undefined;

const Gain = z.number().min(0).max(1);
const Pick = z.strictObject({ id: z.string().min(1), title: z.string(), ms: z.number().nonnegative(), vocals: z.boolean().optional() });
const Option = z.strictObject({ id: z.string().min(1), title: z.string(), ms: z.number().nonnegative(), preview: z.string(), vocals: z.boolean().optional() });
const Choice = { term: z.string(), options: z.array(Option), chosen: z.int().nonnegative(), off: z.boolean() };
const SuggestionSchema = z.strictObject({
  kind: z.string(),
  tracks: z.array(z.strictObject({ from: z.number().nonnegative(), to: z.number().nonnegative(), name: z.string(), mood: z.string(), ...Choice })),
  sounds: z.array(z.strictObject({ time: z.number().nonnegative(), kind: z.enum(["section", "moment", "motion", "picture"]), why: z.string(), ...Choice })),
});
const blank = (): MusicReview => ({ open: true, tab: "suggest", term: "", fit: "edit", vocals: true, duck: true, ...MUSIC_DEFAULTS, pops: { sounds: {}, off: [] } });

const sessionCommands: SessionCommandDef[] = [
  {
    id: "music.review",
    description:
      "Open the Music panel in place of the properties panel (the AI panel's Music tile does), or change it: the `tab` (music, sfx, or popins: a sound on each motion graphic, B-roll and picture coming onto the picture, from sfx.popIns), the search `term` shown, the track or sound effect picked (`pick`, from music.search or sfx.search), how music fits the in/out range (`fit`), whether a track's singing is kept (`vocals`), and ducking under speech (`duck`, at `level` where no one speaks and `under` beneath speech); for pop-ins, the sound of a kind (`popSound`, from sfx.search) and a pop-in left out or put back (`popOff`). The user adds it (Apply, ↩: music.apply), which downloads it on their Epidemic Sound account",
    args: z.strictObject({
      tab: z.enum(["suggest", "music", "sfx", "popins"]).optional(),
      suggestion: SuggestionSchema.optional(),
      suggesting: z.boolean().optional(),
      choose: z.strictObject({ track: z.int().nonnegative().optional(), sound: z.int().nonnegative().optional(), option: z.int().nonnegative().optional(), off: z.boolean().optional() }).optional(),
      term: z.string().optional(),
      pick: Pick.nullable().optional(),
      fit: z.enum(["edit", "cut"]).optional(),
      vocals: z.boolean().optional(),
      duck: z.boolean().optional(),
      level: Gain.optional(),
      under: Gain.optional(),
      popSound: z.strictObject({ kind: z.enum(["motion", "picture"]), pick: Pick }).optional(),
      popOff: z.strictObject({ clip: z.string().min(1), off: z.boolean() }).optional(),
    }),
    apply: (
      s,
      { pick, popSound, popOff, choose, ...settings }: Partial<Omit<MusicReview, "open" | "pick" | "pops">> & { pick?: MusicPick | null; popSound?: { kind: PopKind; pick: MusicPick }; popOff?: { clip: string; off: boolean }; choose?: { track?: number; sound?: number; option?: number; off?: boolean } },
    ) => {
      const was: MusicReview = musicReview(s) ?? { ...blank(), ...(pick ? { tab: "music" as const } : {}) };
      const given = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      const next: MusicReview = { ...was, ...given, pops: { sounds: { ...was.pops.sounds }, off: [...was.pops.off] } };
      if (popSound) next.pops.sounds[popSound.kind] = popSound.pick;
      if (popOff) next.pops.off = popOff.off ? [...new Set([...next.pops.off, popOff.clip])] : next.pops.off.filter((c) => c !== popOff.clip);
      // A pick belongs to its tab: a sound effect isn't a track.
      if (pick === null || (settings.tab && settings.tab !== was.tab)) delete next.pick;
      if (pick) next.pick = pick;
      if (choose && next.suggestion) {
        const list = choose.track !== undefined ? next.suggestion.tracks : next.suggestion.sounds;
        const i = choose.track ?? choose.sound;
        const item = i === undefined ? undefined : list[i];
        if (!item) throw new Error("no such suggestion: name a `track` or `sound` by its place in the list");
        if (choose.option !== undefined && !item.options[choose.option]) throw new Error(`it has ${item.options.length} options`);
        const changed = { ...item, ...(choose.option !== undefined ? { chosen: choose.option } : {}), ...(choose.off !== undefined ? { off: choose.off } : {}) };
        next.suggestion = choose.track !== undefined ? { ...next.suggestion, tracks: next.suggestion.tracks.map((t, k) => (k === i ? (changed as typeof t) : t)) } : { ...next.suggestion, sounds: next.suggestion.sounds.map((t, k) => (k === i ? (changed as typeof t) : t)) };
      }
      s.features.music = next;
    },
  },
  {
    id: "music.suggestFailed",
    description: "Suggest stopped (failed or cancelled): the open Music panel stops waiting for it",
    args: z.strictObject({}),
    apply: (s) => {
      const r = musicReview(s);
      if (r?.suggesting) s.features.music = { ...r, suggesting: false };
    },
  },
  {
    id: "music.close",
    description: "Close the Music panel without adding anything",
    args: z.strictObject({}),
    apply: (s) => void delete s.features.music,
  },
];



/** The track named `name` with nothing over [from, to), or none. */
function freeTrack(project: Project, name: string, from: number, to: number): string | undefined {
  return project.tracks.find((t) => t.name === name && !t.locked && t.clips.every((c) => ticksToSeconds(clipEnd(c)) <= from + 1e-6 || ticksToSeconds(c.start) >= to - 1e-6))?.id;
}


/** Whether a clip stops before its media does (cut to fit), so it fades out. */
function cutShort(c: Clip, project: Project): boolean {
  const a = c.assetId ? project.assets[c.assetId] : undefined;
  return !!a && ticksToSeconds(mediaWindow(c)[1]) < mediaInfo(a).duration - 0.1;
}


const AddArgs = z.strictObject({
  id: z.string().min(1).describe("The track's or sound effect's id, from music.search or sfx.search"),
  kind: z.enum(["music", "sfx"]).default("music"),
  title: z.string().optional().describe("Its title, for the file and the Media Bin"),
  time: z.number().nonnegative().optional().describe("Where it starts (timeline seconds); default the playhead (music: the in point of a range)"),
  to: z.number().positive().optional().describe("Music: where it ends; default the range's out point, else the end of the timeline"),
  fit: z.enum(["edit", "cut"]).default("edit").describe("Music: Epidemic re-cuts the track to the length (up to 5 min, its full mix), or it is cut there and faded out"),
  vocals: z.boolean().default(true).describe("Music: keep the track's singing; false takes its instruments alone (then cut to fit)"),
  duck: z.boolean().default(true).describe("Music: dip it under speech, as audio points"),
  level: Gain.default(MUSIC_DEFAULTS.level).describe("Music: its volume where no one speaks"),
  under: Gain.default(MUSIC_DEFAULTS.under).describe("Music: its volume under speech"),
});

const musicAdd = defineAction({
  id: "music.add",
  description:
    "Add music or a sound effect from Epidemic Sound (ids from music.search / sfx.search), downloaded on the user's account into the project's media folder. Music goes on a Music track over the in/out range (else from the playhead to the end of the timeline), fitted to it (`fit`) and ducked under speech; a sound effect goes on an SFX track at the playhead (or `time`). Runs as a job (job_status) when it has to download; one already in the project is placed at once. Only when the user asks: downloads count against their Epidemic Sound subscription",
  args: AddArgs,
  resolve: (a, ctx) => {
    const end = ticksToSeconds(projectDuration(ctx.project));
    const range = ctx.session.range;
    // A sound effect goes where the playhead is; music fills the range.
    const from = a.time ?? (range && a.kind === "music" ? range.in : ctx.session.playhead);
    const to = a.kind === "sfx" ? undefined : (a.to ?? (range && a.time === undefined ? range.out : end - from >= 1 ? end : undefined));
    if (to !== undefined && to <= from) throw new Error("the music would end before it starts: set an in/out range, or move the playhead");
    const length = to === undefined ? undefined : to - from;
    // Epidemic's edits are of the full mix, up to 5 min.
    const edit = a.kind === "music" && a.fit === "edit" && a.vocals && length !== undefined && length <= EDIT_MAX;
    const version = a.kind === "sfx" ? "full" : edit ? `edit:${length!.toFixed(2)}` : a.vocals ? "full" : "instruments";
    const title = a.title ?? (a.kind === "sfx" ? "Sound effect" : "Music");
    const label = a.kind === "sfx" ? "Add Sound Effect" : "Add Music";
    /** Places `asset`: one in the project already (with its id), else added first. */
    const place = (asset: Omit<Asset, "id"> & { id?: string }) => (ctx2: ActionContext): ActionPlan => {
      const duration = mediaInfo(asset as Asset).duration;
      const stop = to === undefined ? from + duration : Math.min(to, from + duration);
      const name = a.kind === "sfx" ? "SFX" : "Music";
      const track = freeTrack(ctx2.project, name, from, stop);
      const steps: ActionStep[] = [];
      if (!asset.id) steps.push({ command: "asset.add", args: asset });
      const assetAt = (r: unknown[]) => asset.id ?? (r[0] as string);
      // Music at the bottom, under everything; sound effects on top.
      if (!track) steps.push({ command: "track.add", args: { name, ...(a.kind === "music" ? { index: 0 } : {}) } });
      const trackAt = steps.length - 1;
      steps.push({ command: "asset.place", args: (r: unknown[]) => ({ asset: assetAt(r), time: from, track: track ?? r[trackAt] }) });
      const placed = steps.length - 1;
      const clip = (r: unknown[]) => (r[placed] as string[])[0]!;
      const cut = to !== undefined && from + duration > to + 1e-3;
      if (cut) steps.push({ command: "clip.trim", args: (r: unknown[]) => ({ clip: clip(r), end: to }) });
      if (a.kind === "music") {
        const points = duckPoints(from, stop, speechSpans(ctx2.project, ctx2.registry, ctx2.data), { level: a.level, under: a.under, duck: a.duck, fade: cut });
        steps.push({ command: "volume.setPoints", args: (r: unknown[]) => ({ clip: clip(r), points }) });
      }
      return { label, steps, after: (r) => [{ command: "selection.set", args: { clips: [clip(r)], linked: false } }] };
    };
    const have = Object.values(ctx.project.assets).find((x) => libraryOf(x)?.id === a.id && libraryOf(x)?.version === version);
    if (have) return place(have)(ctx);
    return {
      label,
      task: {
        label: `${a.kind === "sfx" ? "Download" : edit ? "Fit and download" : "Download"} “${title}” from Epidemic Sound`,
        run: async (env) => {
          const key = await keyOf(env.secret);
          const path = freePath(env.mediaDir, title, a.kind === "sfx" ? ".wav" : ".mp3");
          try {
            if (edit) {
              env.progress(0, "Epidemic Sound is fitting the track to the range");
              await downloadEdit(key, a.id, length!, path, (f) => env.progress(f * 0.8, "Epidemic Sound is fitting the track to the range"));
            } else {
              env.progress(0.1, "Downloading");
              await download(key, a.kind, a.id, path, a.vocals);
            }
            env.progress(0.9, "Adding it");
            const probed = await env.asset(path, "audio");
            const library: LibraryInfo = { source: "epidemic", kind: a.kind, id: a.id, title, version };
            const added = { ...probed, name: title, derived: { ...probed.derived, library } };
            env.progress(1, `On the ${a.kind === "sfx" ? "SFX" : "Music"} track; the file is in the project's media folder`);
            return place(added);
          } catch (e) {
            rmSync(path, { force: true });
            throw e;
          }
        },
      },
    };
  },
});

/** Pop-ins this close together are one: a picture and its frame, a title and its logo. */
const POP_GAP = 0.25;

/**
 * Where something comes onto the picture on the timeline: a motion graphic or B-roll (whoosh), or a picture, a
 * screenshot or logo (pop); not the recording itself, a held frame or a clip at the very start.
 */
export function popIns(project: Project, registry: FeatureRegistry): PopIn[] {
  const found: PopIn[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      const motion = registry.hasTrait(c.type, "motion") || registry.hasTrait(c.type, "broll");
      const picture = registry.hasTrait(c.type, "picture") && !registry.hasTrait(c.type, "video") && !registry.hasTrait(c.type, "hold") && !registry.hasTrait(c.type, "stitched");
      const time = ticksToSeconds(c.start);
      if ((!motion && !picture) || time < POP_GAP) continue;
      const asset = c.assetId ? project.assets[c.assetId] : undefined;
      found.push({ time, clip: c.id, name: asset ? assetName(asset) : motion ? "Motion graphic" : "Picture", kind: motion ? "motion" : "picture" });
    }
  }
  found.sort((a, b) => a.time - b.time);
  const kept: PopIn[] = [];
  for (const p of found) if (!kept.length || p.time - kept.at(-1)!.time >= POP_GAP) kept.push(p);
  return kept;
}

const Sound = z.strictObject({ id: z.string().min(1), title: z.string(), time: z.number().nonnegative() });

/** Sound effects placed at their times on SFX tracks (another added where they'd overlap), downloading those not in the project first. */
const sfxAddMany = defineAction({
  id: "sfx.addMany",
  description:
    "Add several Epidemic Sound sound effects at once (ids from sfx.search), each at its `time`, on SFX tracks on top (another SFX track where two would overlap), one undo step; those not in the project are downloaded first on the user's account, as a job. Only when the user asks",
  args: z.strictObject({ sounds: z.array(Sound).min(1) }),
  resolve: ({ sounds }, ctx) => {
    const label = sounds.length === 1 ? "Add Sound Effect" : "Add Sound Effects";
    const inProject = (id: string) => Object.values(ctx.project.assets).find((x) => libraryOf(x)?.id === id && libraryOf(x)?.version === "full");
    const place = (added: Map<string, Omit<Asset, "id">>) => (ctx2: ActionContext): ActionPlan => {
      const steps: ActionStep[] = [];
      // An asset by sound id: in the project already, or the result of its asset.add step.
      const assetRef = new Map<string, string | number>();
      for (const [id, a] of added) {
        steps.push({ command: "asset.add", args: a });
        assetRef.set(id, steps.length - 1);
      }
      const lengthOf = (id: string) => mediaInfo((added.get(id) ?? inProject(id)!) as Asset).duration;
      // SFX tracks as the document is, then those this adds, each with what is on it by then.
      const lanes: { ref: string | number; spans: [number, number][] }[] = ctx2.project.tracks
        .filter((t) => t.name === "SFX" && !t.locked)
        .map((t) => ({ ref: t.id, spans: t.clips.map((c) => [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))] as [number, number]) }));
      const placed: number[] = [];
      for (const s of [...sounds].sort((a, b) => a.time - b.time)) {
        const span: [number, number] = [s.time, s.time + lengthOf(s.id)];
        let lane = lanes.find((l) => l.spans.every(([a, b]) => b <= span[0] + 1e-6 || a >= span[1] - 1e-6));
        if (!lane) {
          steps.push({ command: "track.add", args: { name: "SFX" } });
          lane = { ref: steps.length - 1, spans: [] };
          lanes.push(lane);
        }
        lane.spans.push(span);
        const [asset, track] = [assetRef.get(s.id) ?? inProject(s.id)!.id, lane.ref];
        steps.push({ command: "asset.place", args: (r: unknown[]) => ({ asset: typeof asset === "number" ? r[asset] : asset, time: s.time, track: typeof track === "number" ? r[track] : track }) });
        placed.push(steps.length - 1);
      }
      return { label, steps, after: (r) => [{ command: "selection.set", args: { clips: placed.flatMap((i) => r[i] as string[]), linked: false } }] };
    };
    const missing = [...new Map(sounds.filter((s) => !inProject(s.id)).map((s) => [s.id, s])).values()];
    if (!missing.length) return place(new Map())(ctx);
    return {
      label,
      task: {
        label: `Download ${missing.length === 1 ? `“${missing[0]!.title}”` : `${missing.length} sound effects`} from Epidemic Sound`,
        run: async (env) => {
          const key = await keyOf(env.secret);
          const added = new Map<string, Omit<Asset, "id">>();
          const made: string[] = [];
          try {
            for (const [i, s] of missing.entries()) {
              env.progress(i / missing.length, `Downloading ${i + 1} of ${missing.length}`);
              const path = freePath(env.mediaDir, s.title, ".wav");
              made.push(path);
              await download(key, "sfx", s.id, path);
              const probed = await env.asset(path, "audio");
              const library: LibraryInfo = { source: "epidemic", kind: "sfx", id: s.id, title: s.title, version: "full" };
              added.set(s.id, { ...probed, name: s.title, derived: { ...probed.derived, library } });
            }
          } catch (e) {
            for (const path of made) rmSync(path, { force: true });
            throw e;
          }
          env.progress(1, `${sounds.length === 1 ? "On an SFX track" : `${sounds.length} on SFX tracks`}; the files are in the project's media folder`);
          return place(added);
        },
      },
    };
  },
});

const musicSuggest = defineAction({
  id: "music.suggest",
  description:
    "Suggest music and sound effects from the transcript (the Music panel's Suggest tab): B-roll's planner (Apple's on-device model, or OpenAI) reads the talk for the video's kind and each section's mood; each part gets three Epidemic Sound tracks (neighbouring sections of one mood share one), and each section change, key moment (about one every 30 s at most) and pop-in three sounds. Runs as a job; when done the Music panel's Suggest tab lists them (music.review `choose` swaps or unticks one) and music.apply adds them. Searching is free; nothing downloads until Apply",
  args: z.strictObject({}),
  resolve: (_, ctx) => {
    const pops = popIns(ctx.project, ctx.registry).map((p) => ({ time: p.time, kind: p.kind }));
    const data = ctx.data;
    return {
      label: "Suggest Music and Sounds",
      before: [{ command: "music.review", args: { tab: "suggest", suggesting: true } }],
      task: {
        label: "Suggest music and sounds",
        run: async (env) => {
          const suggestion = await suggest(ctx.project, ctx.registry, data, env, pops);
          return () => ({ label: "Suggest Music and Sounds", after: () => [{ command: "music.review", args: { tab: "suggest", suggestion, suggesting: false } }] });
        },
        failed: () => [{ command: "music.suggestFailed" }],
      },
    };
  },
});

const musicApply = defineAction({
  id: "music.apply",
  description: "Add what the open Music panel has picked, as it is set (its Apply button, ↩), and close the panel. Only when the user asks: it downloads on their Epidemic Sound account",
  args: z.strictObject({}),
  resolve: (_, ctx) => {
    const r = musicReview(ctx.session);
    if (!r) throw new Error("the Music panel isn't open: music.review opens it");
    if (r.tab === "suggest") {
      if (!r.suggestion) throw new Error(r.suggesting ? "Suggest is still reading the talk" : "nothing suggested yet: music.suggest first");
      const plan = applySuggestion(r.suggestion, ctx);
      return { ...plan, before: [...(plan.before ?? []), { command: "music.close" }] };
    }
    if (r.tab === "popins") {
      const sounds = popIns(ctx.project, ctx.registry).flatMap((p) => {
        const sound = r.pops.sounds[p.kind];
        return sound && !r.pops.off.includes(p.clip) ? [{ id: sound.id, title: sound.title, time: p.time }] : [];
      });
      if (!sounds.length) throw new Error("no pop-in has a sound: pick a sound for them, or tick one");
      const plan = sfxAddMany.resolve({ sounds }, ctx);
      return { ...plan, before: [...(plan.before ?? []), { command: "music.close" }] };
    }
    if (!r.pick) throw new Error(r.tab === "sfx" ? "pick a sound effect first" : "pick a track first");
    const vocals = r.vocals || !r.pick.vocals;
    const plan = musicAdd.resolve(AddArgs.parse({ id: r.pick.id, kind: r.tab, title: r.pick.title, fit: r.fit, vocals, duck: r.duck, level: r.level, under: r.under }), ctx);
    return { ...plan, before: [...(plan.before ?? []), { command: "music.close" }] };
  },
});

const musicDuck = defineAction({
  id: "music.duck",
  description:
    "Duck the selected music (or `clips`) under speech again, after the talk was edited: its audio points are replaced by `level` where no one speaks and `under` beneath speech (pauses under 0.8 s kept down), faded out at its end when it was cut short. `duck: false` sets it flat at `level`",
  args: z.strictObject({ clips: z.array(z.string().min(1)).min(1).optional(), duck: z.boolean().default(true), level: Gain.default(MUSIC_DEFAULTS.level), under: Gain.default(MUSIC_DEFAULTS.under) }),
  resolve: ({ clips: ids, ...o }, ctx) => {
    const pool = ids ? ctx.scope.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id)) : selectedClips(ctx);
    const music = pool.filter((c) => libraryOf(c.assetId ? ctx.project.assets[c.assetId] : undefined)?.kind === "music");
    if (!music.length) throw new Error("select music from Epidemic Sound first");
    const speech = speechSpans(ctx.project, ctx.registry, ctx.data);
    return {
      label: "Duck Music",
      steps: music.map((c) => ({ command: "volume.setPoints", args: { clip: c.id, points: duckPoints(ticksToSeconds(c.start), ticksToSeconds(clipEnd(c)), speech, { ...o, fade: cutShort(c, ctx.project) }) } })),
    };
  },
});

const Search = {
  term: z.string().optional().describe("Words: a mood, a genre, an instrument, what the video is about"),
  first: z.int().min(1).max(50).default(20),
  after: z.string().optional().describe("The `next` of the page before"),
};

/**
 * Music and sound effects from Epidemic Sound, on the user's own subscription (through Epidemic's MCP server, with a
 * key from their account): searched and previewed in the Music panel, placed fitted to a range, ducked under speech.
 */
export const music = defineFeature({
  id: "music",
  version: 1,
  panels: [{ open: (s) => !!musicReview(s), cancel: "music.close", apply: { action: "music.apply" } }],
  secrets: [{ id: KEY, title: "Epidemic Sound key" }],
  sessionCommands,
  queries: [
    defineQuery({
      id: "music.search",
      description:
        "Search Epidemic Sound's music (needs the user's Epidemic Sound key, set in Settings › AI): by `term`, `moods` and `genres` (slugs, e.g. happy, hip-hop), `length` and `bpm` ranges (seconds, beats a minute). Each track has its id, title, artist, length (ms), BPM, a preview MP3 to listen to (free), its moods and genres, and whether it has singing. Searching and previews don't count as downloads",
      args: z.strictObject({
        ...Search,
        moods: z.array(z.string().min(1)).optional(),
        genres: z.array(z.string().min(1)).optional(),
        length: z.strictObject({ min: z.number().nonnegative().optional(), max: z.number().positive().optional() }).optional(),
        bpm: z.strictObject({ min: z.int().positive().optional(), max: z.int().positive().optional() }).optional(),
      }),
      run: async (args, ctx): Promise<Page<Track>> => searchMusic(await keyOf(ctx.secret), args),
    }),
    defineQuery({
      id: "sfx.popIns",
      description: "Where things come onto the picture, for a sound on each (the Music panel's Pop-ins): each motion graphic and B-roll (kind motion: a whoosh) and picture, a screenshot or logo (kind picture: a pop), by start time; pop-ins within 0.25 s are one. sfx.addMany places sounds at these times",
      args: z.strictObject({}),
      run: (_, ctx): PopIn[] => popIns(ctx.project, ctx.registry),
    }),
    defineQuery({
      id: "sfx.search",
      description: "Search Epidemic Sound's sound effects by `term` (whoosh, pop, click, typing…; needs the user's Epidemic Sound key): each with its id, title, length (ms) and a preview MP3",
      args: z.strictObject(Search),
      run: async (args, ctx): Promise<Page<Effect>> => searchEffects(await keyOf(ctx.secret), args),
    }),
  ],
  actions: [musicAdd, musicApply, musicDuck, musicSuggest, sfxAddMany],
});
