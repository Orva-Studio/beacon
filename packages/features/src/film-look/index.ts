import { readFileSync } from "node:fs";
import { z } from "zod";
import { defineCommand, defineFeature, defineQuery, ticksToSeconds, walkClips, type EffectPreset } from "@beacon/model";
import wgsl from "./film-look.wgsl" with { type: "text" };
import LOOKS from "./looks.json";
import { fromHlook, KELVIN_PER_WARMTH, WARMTH_RANGE, type FilmLookParams } from "./hlook";

export { fromHlook, type FilmLookParams } from "./hlook";

// `slider`: the properties panel's range, not a limit; `percent`: shown ×100.
const params = z.strictObject({
  strength: z.number().min(0).max(1).meta({ percent: true }).describe("How much of the look shows over the clip"),
  exposure: z.number().min(-2).max(2).meta({ slider: { min: -2, max: 2 } }),
  warmth: z.number().min(-WARMTH_RANGE).max(WARMTH_RANGE).meta({ slider: { min: -WARMTH_RANGE, max: WARMTH_RANGE } }).describe(`White balance: each 1 is ${KELVIN_PER_WARMTH} K warmer than daylight, cooler below 0`),
  fade: z.number().min(0).max(1).meta({ percent: true }).describe("Lifted blacks and flatter contrast"),
  contrast: z.number().min(0).max(3).meta({ slider: { max: 2 } }),
  saturation: z.number().min(0).max(3).meta({ slider: { max: 2 } }),
  grain: z.number().min(0).max(1).meta({ percent: true }).describe("Film grain: 100% is hance's ISO 3200"),
  grainSize: z.number().min(0).max(5).meta({ slider: { max: 5 } }),
  halation: z.number().min(0).max(1).meta({ percent: true }).describe("The red glow film gives around bright highlights"),
  halationSize: z.number().min(1).max(100).meta({ slider: { min: 1, max: 40 } }),
  vignette: z.number().min(0).max(1).meta({ percent: true }),
});

/** hance's Default look, without the bloom, aberration and camera shake Film Look doesn't have. */
const DEFAULTS: FilmLookParams = { strength: 1, exposure: 0, warmth: 0, fade: 0, contrast: 1, saturation: 1, grain: 0.125, grainSize: 0, halation: 0.25, halationSize: 4, vignette: 0.25 };

const looks = LOOKS.looks as { id: string; name: string; description: string; params: Record<string, unknown> }[];

/** hance's built-in looks on Film Look's sliders. */
const PRESETS: EffectPreset[] = looks.map((l) => {
  const { params: p, notReproduced } = fromHlook(l);
  return { id: l.id, title: l.name, description: l.description, params: { ...p }, ...(notReproduced.length ? { notes: notReproduced } : {}) };
});

/** A look by a built-in's id, or a `.hlook` file's path or contents. */
function readLook({ look, path, json }: { look?: string; path?: string; json?: string }) {
  const given = [look, path, json].filter((x) => x !== undefined).length;
  if (given !== 1) throw new Error("one of `look` (a built-in's id), `path` (a .hlook file) or `json` (its contents)");
  if (look !== undefined) {
    const l = looks.find((x) => x.id === look);
    if (!l) throw new Error(`no built-in look "${look}": ${looks.map((x) => x.id).join(", ")}`);
    return fromHlook(l);
  }
  const text = path !== undefined ? readFileSync(path, "utf8") : json!;
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
  version: 1,
  effects: [
    {
      id: "film-look",
      title: "Film Look",
      description: "hance's film look: warmth, fade, contrast, saturation, grain, halation and vignette, with its looks (CineStill, Portra…) and .hlook files",
      traits: ["visual"],
      params,
      defaults: () => ({ ...DEFAULTS }),
      apply(e, p, ctx) {
        const f = p as FilmLookParams;
        (e.main.passes ??= []).push({
          pass: "film-look",
          params: [f.strength, 6500 - f.warmth * KELVIN_PER_WARMTH, f.fade, f.contrast, f.saturation, f.exposure, f.grain, f.grainSize, f.halation, f.halationSize, f.vignette, Math.round(ticksToSeconds(e.time) / ctx.frameSeconds) % 9973],
        });
      },
      presets: PRESETS,
      importFile: { label: "Import .hlook…", extensions: ["hlook"], query: "filmLook.read" },
    },
  ],
  passes: [{ id: "film-look", wgsl, steps: ["fs_highlights", "fs_scatter_h", "fs_scatter_v", "fs_look"] }],
  queries: [
    defineQuery({
      id: "filmLook.looks",
      description: "hance's built-in looks Film Look offers: each one's id, name, description, its values on Film Look's sliders and what of it Film Look can't reproduce (`notes`)",
      args: z.strictObject({}),
      run: () => PRESETS,
    }),
    defineQuery({
      id: "filmLook.read",
      description: "A hance look on Film Look's sliders, without applying it: `params`, and `notReproduced`, what the look does that Film Look can't (bloom, chromatic aberration, split tone…) or only partly",
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
