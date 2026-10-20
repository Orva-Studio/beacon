/** Film Look's sliders. */
export interface FilmLookParams {
  strength: number;
  exposure: number;
  warmth: number;
  fade: number;
  contrast: number;
  saturation: number;
  grain: number;
  grainSize: number;
  halation: number;
  halationSize: number;
  vignette: number;
}

/** hance's own defaults for what a `.hlook` leaves out ("anything omitted falls back to the default look"). */
const HANCE_DEFAULTS: Record<string, unknown> = {
  blend: 1,
  exposure: 0,
  contrast: 1,
  highlights: 0,
  fade: 0,
  "fade-color": "neutral",
  "white-balance": 6500,
  tint: 0,
  "subtractive-sat": 1,
  richness: 1,
  "bleach-bypass": 0,
  "film-density-amount": 0,
  "halation-amount": 0.25,
  "halation-radius": 4,
  "halation-highlights-only": true,
  aberration: 0.3,
  "bloom-amount": 0.25,
  "bloom-radius": 10,
  "grain-iso": 400,
  "grain-size": 0,
  "grain-saturation": 0.3,
  "vignette-amount": 0.25,
  "vignette-size": 0.25,
  "split-tone-amount": 0,
  "camera-shake-amount": 0.25,
  "camera-shake-rate": 0.5,
};

/** Warmth 1 is this many kelvin warmer than daylight (6500 K), as hance's white balance multiplies the picture. */
export const KELVIN_PER_WARMTH = 2000;
export const WARMTH_RANGE = 2;

const ISO_MAX = 3200;

/** What the look's file sets about how hance exports, not how it looks. */
const EXPORT_KEYS = new Set(["encode-preset", "crf"]);
/** Read with their parent: they change nothing while it is off. */
const DEPENDENT: Record<string, string> = {
  "bloom-radius": "bloom-amount",
  "camera-shake-rate": "camera-shake-amount",
  "split-tone-shadow-hue": "split-tone-amount",
  "split-tone-highlight-hue": "split-tone-amount",
  "split-tone-highlight-strength": "split-tone-amount",
  "split-tone-pivot": "split-tone-amount",
  "split-tone-protect-neutrals": "split-tone-amount",
  "film-density-preset": "film-density-amount",
  "grain-softness": "grain-iso",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** hance's controls Film Look doesn't have, in words, with what the look sets them to. */
const LABELS: Record<string, (v: unknown, p: Record<string, unknown>) => string | undefined> = {
  highlights: (v) => (num(v, 0) !== 0 ? `highlights ${v}` : undefined),
  "fade-color": (v) => (v && v !== "neutral" ? `${v} fade colour` : undefined),
  tint: (v) => (num(v, 0) !== 0 ? `tint ${v}` : undefined),
  "bleach-bypass": (v) => (num(v, 0) > 0 ? `bleach bypass ${v}` : undefined),
  "film-density-amount": (v, p) => (num(v, 0) > 0 ? `film density curve ${v} (${p["film-density-preset"] ?? "warm-classic"})` : undefined),
  "halation-highlights-only": (v) => (v === false ? "halation over the whole picture (Film Look's is on highlights)" : undefined),
  aberration: (v) => (num(v, 0) > 0 ? `chromatic aberration ${v}` : undefined),
  "bloom-amount": (v, p) => (num(v, 0) > 0 ? `bloom ${v} (radius ${p["bloom-radius"] ?? 10})` : undefined),
  "grain-saturation": (v) => (num(v, 0.3) !== 0.3 ? `grain colour ${v} (Film Look's is 0.3)` : undefined),
  "vignette-size": (v) => (num(v, 0.25) !== 0.25 ? `vignette size ${v} (Film Look's is 0.25)` : undefined),
  "split-tone-amount": (v, p) => (num(v, 0) > 0 ? `split tone ${v} (shadows ${p["split-tone-shadow-hue"] ?? 30}°, highlights ${p["split-tone-highlight-hue"] ?? 210}°)` : undefined),
  "camera-shake-amount": (v) => (num(v, 0) > 0 ? `camera shake ${v}` : undefined),
  "input-lut-profile": (v) => (v && v !== "rec709" ? `input LUT ${v}` : undefined),
};

/** Lift, gamma and gain per channel: neutral at 0, 1 and 1. */
const WHEELS: Record<string, number> = { "lift-r": 0, "lift-g": 0, "lift-b": 0, "gamma-r": 1, "gamma-g": 1, "gamma-b": 1, "gain-r": 1, "gain-g": 1, "gain-b": 1 };

const MAPPED = new Set(["blend", "exposure", "white-balance", "fade", "contrast", "subtractive-sat", "richness", "grain-iso", "grain-size", "halation-amount", "halation-radius", "vignette-amount"]);

/**
 * A hance look (`.hlook`: `{ name, params, preLut? }`) on Film Look's sliders, and what it does that Film Look can't
 * (bloom, aberration, split tone…) or only partly (a warmth beyond its range), listed rather than dropped. What the
 * file leaves out is hance's default, as hance reads it.
 */
export function fromHlook(look: { name?: unknown; params?: unknown; preLut?: unknown }): { name: string; params: FilmLookParams; notReproduced: string[] } {
  const own = (look.params && typeof look.params === "object" ? look.params : {}) as Record<string, unknown>;
  const p: Record<string, unknown> = { ...HANCE_DEFAULTS, ...own, ...(look.preLut ? { "input-lut-profile": look.preLut } : {}) };
  const notes: string[] = [];
  const kelvin = num(p["white-balance"], 6500);
  const warmth = (6500 - kelvin) / KELVIN_PER_WARMTH;
  if (Math.abs(warmth) > WARMTH_RANGE) notes.push(`white balance ${kelvin} K (Film Look's warmth reaches ${6500 - WARMTH_RANGE * KELVIN_PER_WARMTH}–${6500 + WARMTH_RANGE * KELVIN_PER_WARMTH} K)`);
  const iso = num(p["grain-iso"], 400);
  if (iso > ISO_MAX) notes.push(`grain ISO ${iso} (Film Look's grain stops at ISO ${ISO_MAX})`);
  const saturation = num(p["subtractive-sat"], 1) * num(p.richness, 1);
  for (const [key, label] of Object.entries(LABELS)) {
    const note = label(p[key], p);
    if (note) notes.push(note);
  }
  const wheels = Object.entries(WHEELS).filter(([k, d]) => num(p[k], d) !== d);
  if (wheels.length) notes.push(`colour wheels (${wheels.map(([k]) => `${k} ${p[k]}`).join(", ")})`);
  for (const key of Object.keys(own)) {
    if (MAPPED.has(key) || key in LABELS || key in WHEELS || key in DEPENDENT || EXPORT_KEYS.has(key)) continue;
    notes.push(`${key} ${JSON.stringify(own[key])} (unknown to Film Look)`);
  }
  return {
    name: typeof look.name === "string" && look.name ? look.name : "Look",
    params: {
      strength: round(clamp(num(p.blend, 1), 0, 1)),
      exposure: round(clamp(num(p.exposure, 0), -2, 2)),
      warmth: round(clamp(warmth, -WARMTH_RANGE, WARMTH_RANGE)),
      fade: round(clamp(num(p.fade, 0), 0, 1)),
      contrast: round(clamp(num(p.contrast, 1), 0, 3)),
      saturation: round(clamp(saturation, 0, 3)),
      grain: round(clamp(iso / ISO_MAX, 0, 1)),
      grainSize: round(clamp(num(p["grain-size"], 0), 0, 5)),
      halation: round(clamp(num(p["halation-amount"], 0.25), 0, 1)),
      halationSize: round(clamp(num(p["halation-radius"], 4), 1, 100)),
      vignette: round(clamp(num(p["vignette-amount"], 0.25), 0, 1)),
    },
    notReproduced: notes,
  };
}
