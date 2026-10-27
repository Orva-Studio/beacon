import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineCommand, defineFeature, defineQuery, eachRawClip, KeptLooksSchema, ticksToSeconds, walkClips, type EffectPreset, type KeptLook, type Preferences } from "@beacon/model";
import wgsl from "./film-look.wgsl" with { type: "text" };
import LOOKS from "./looks.json";
import { fromHlook, KELVIN_PER_WARMTH, splitToneShifts, WARMTH_RANGE, type FilmLookParams } from "./hlook";

export { fromHlook, type FilmLookParams } from "./hlook";

// `slider`: the properties panel's range, not a limit; `percent`: shown ×100; `hue`: degrees on a hue track.
const params = z.strictObject({
  strength: z.number().min(0).max(1).meta({ percent: true }).describe("How much of the look shows over the clip"),
  exposure: z.number().min(-2).max(2).meta({ slider: { min: -2, max: 2 } }),
  warmth: z.number().min(-WARMTH_RANGE).max(WARMTH_RANGE).meta({ slider: { min: -WARMTH_RANGE, max: WARMTH_RANGE } }).describe(`White balance: each 1 is ${KELVIN_PER_WARMTH} K warmer than daylight, cooler below 0`),
  tint: z.number().min(-1).max(1).meta({ percent: true }).describe("Greener above 0, more magenta below"),
  fade: z.number().min(0).max(1).meta({ percent: true }).describe("Lifted blacks and flatter contrast"),
  contrast: z.number().min(0).max(3).meta({ slider: { max: 2 } }),
  saturation: z.number().min(0).max(3).meta({ slider: { max: 2 } }),
  grain: z.number().min(0).max(1).meta({ percent: true }).describe("Film grain: 100% is hance's ISO 3200"),
  grainSize: z.number().min(0).max(5).meta({ slider: { max: 5 } }),
  halation: z.number().min(0).max(1).meta({ percent: true }).describe("The red glow film gives around bright highlights"),
  halationSize: z.number().min(1).max(100).meta({ slider: { min: 1, max: 40 } }),
  vignette: z.number().min(0).max(1).meta({ percent: true }),
  splitTone: z.number().min(0).max(1).meta({ percent: true }).describe("Split tone: the shadows tinted one hue and the highlights another"),
  shadowHue: z.number().min(0).max(360).meta({ hue: true }).describe("The shadows' tint, in degrees (30 orange, 210 teal)"),
  highlightHue: z.number().min(0).max(360).meta({ hue: true }).describe("The highlights' tint, in degrees"),
  highlightStrength: z.number().min(0).max(1).meta({ percent: true }).describe("How strongly the highlights are tinted, against the shadows"),
});

/** hance's Default look, without the bloom, aberration and camera shake Film Look doesn't have. */
const DEFAULTS: FilmLookParams = { strength: 1, exposure: 0, warmth: 0, tint: 0, fade: 0, contrast: 1, saturation: 1, grain: 0.125, grainSize: 0, halation: 0.25, halationSize: 4, vignette: 0.25, splitTone: 0, shadowHue: 30, highlightHue: 210, highlightStrength: 0.5 };

/** v2: Tint and split tone, off on a Film Look saved before them. */
function addSplitTone(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    for (const e of Array.isArray(o.effects) ? (o.effects as { type: string; params: Record<string, unknown> }[]) : []) {
      if (e.type === "film-look") e.params = { tint: 0, splitTone: 0, shadowHue: 30, highlightHue: 210, highlightStrength: 0.5, ...e.params };
    }
  });
  return doc;
}

const looks = LOOKS.looks as { id: string; name: string; description: string; params: Record<string, unknown> }[];

/** The `.hlook` files the user imported, kept for every project. */
const KEPT = "filmLookLooks";

const keptLooks = (pref: Preferences): KeptLook[] => {
  try {
    return KeptLooksSchema.parse(JSON.parse(pref(KEPT) || "[]"));
  } catch {
    return [];
  }
};

/** hance's built-in looks on Film Look's sliders. */
const PRESETS: EffectPreset[] = looks.map((l) => {
  const { params: p, notReproduced } = fromHlook(l);
  return { id: l.id, title: l.name, description: l.description, params: { ...p }, ...(notReproduced.length ? { notes: notReproduced } : {}) };
});

/** A `.hlook` is a few hundred bytes; anything far larger isn't one. */
const MAX_LOOK_BYTES = 1 << 20;

/** A `.hlook` file's text: only a regular file (not a pipe or a device, which would block), and not a huge one. */
function readLookFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} isn't a .hlook: not a file`);
    if (st.size > MAX_LOOK_BYTES) throw new Error(`${path} isn't a .hlook: ${Math.round(st.size / 1e6)} MB`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** A look by a built-in's id, or a `.hlook` file's path or contents. */
function readLook({ look, path, json }: { look?: string; path?: string; json?: string }) {
  const given = [look, path, json].filter((x) => x !== undefined).length;
  if (given !== 1) throw new Error("one of `look` (a built-in's id), `path` (a .hlook file) or `json` (its contents)");
  if (look !== undefined) {
    const l = looks.find((x) => x.id === look);
    if (!l) throw new Error(`no built-in look "${look}": ${looks.map((x) => x.id).join(", ")}`);
    return fromHlook(l);
  }
  const text = path !== undefined ? readLookFile(path) : json!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path ?? "the look"} isn't a .hlook: not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { params?: unknown }).params !== "object") throw new Error(`${path ?? "the look"} isn't a .hlook: no params`);
  return fromHlook(parsed as Parameters<typeof fromHlook>[0]);
}

const LookArgs = {
  look: z.string().optional().describe("A built-in look's id (filmLook.looks lists them)"),
  path: z.string().optional().describe("A hance .hlook file"),
  json: z.string().optional().describe("A .hlook's contents"),
};

/** hance's film look, small: grade, halation, grain and vignette on a clip, with hance's looks as presets and its `.hlook` files imported. */
export const filmLook = defineFeature({
  id: "film-look",
  version: 2,
  migrations: [{ version: 2, migrate: addSplitTone }],
  effects: [
    {
      id: "film-look",
      title: "Film Look",
      description: "hance's film look: warmth, tint, fade, contrast, saturation, grain, halation, vignette and split tone, with its looks (CineStill, Portra…) and .hlook files",
      traits: ["visual"],
      params,
      defaults: () => ({ ...DEFAULTS }),
      apply(e, p, ctx) {
        const f = p as FilmLookParams;
        (e.main.passes ??= []).push({
          pass: "film-look",
          params: [f.strength, 6500 - f.warmth * KELVIN_PER_WARMTH, f.fade, f.contrast, f.saturation, f.exposure, f.grain, f.grainSize, f.halation, f.halationSize, f.vignette, Math.round(ticksToSeconds(e.time) / ctx.frameSeconds) % 9973, f.tint, ...splitToneShifts(f)],
        });
      },
      presets: PRESETS,
      importFile: { label: "Import .hlook…", extensions: ["hlook"], query: "filmLook.read", keep: KEPT },
    },
  ],
  passes: [{ id: "film-look", wgsl, steps: ["fs_highlights", "fs_scatter_h", "fs_scatter_v", "fs_look"] }],
  preferences: [
    {
      id: KEPT,
      title: "Your looks",
      description: "The .hlook files imported into Film Look, kept for every project: each a name and its values on Film Look's sliders",
      options: [],
      schema: KeptLooksSchema,
      default: "[]",
    },
  ],
  queries: [
    defineQuery({
      id: "filmLook.looks",
      description: "The looks Film Look offers: hance's built-ins (each one's id, name, description, its values on Film Look's sliders and what of it Film Look can't reproduce, `notes`), then the user's own imported .hlook files (`yours`; give a clip one with effect.set and its `params`)",
      args: z.strictObject({}),
      run: (_, { pref }) => [...PRESETS, ...keptLooks(pref).map((l) => ({ id: l.id, title: l.name, params: l.params, ...(l.notes?.length ? { notes: l.notes } : {}), yours: true }))],
    }),
    defineQuery({
      id: "filmLook.read",
      description: "A hance look on Film Look's sliders, without applying it: `params`, and `notReproduced`, what the look does that Film Look can't (bloom, chromatic aberration, colour wheels…) or only partly",
      args: z.strictObject(LookArgs),
      run: (args) => readLook(args),
    }),
  ],
  commands: [
    defineCommand({
      id: "filmLook.load",
      description:
        "Give `clips` a hance look, one undo step: a built-in's id (`look`), a .hlook file (`path`) or its contents (`json`). Their Film Look effect takes its values, or one is added; answers the values and `notReproduced`, what of the look Film Look can't do, for telling the user",
      args: z.strictObject({ clips: z.array(z.string()).min(1), ...LookArgs }),
      apply(doc, { clips, ...args }, ctx) {
        const look = readLook(args);
        for (const id of clips) {
          const clip = [...walkClips(doc.tracks, ctx.registry)].find((l) => l.clip.id === id)?.clip;
          if (!clip) throw new Error(`no clip "${id}"`);
          if (!ctx.registry.effect("film-look").traits.some((t) => ctx.registry.hasTrait(clip.type, t))) throw new Error(`${clip.type} clips can't take Film Look`);
          const fx = clip.effects.find((e) => e.type === "film-look");
          if (fx) fx.params = { ...look.params };
          else clip.effects.push({ id: ctx.newId("fx"), type: "film-look", enabled: true, params: { ...look.params } });
        }
        return look;
      },
    }),
  ],
});
