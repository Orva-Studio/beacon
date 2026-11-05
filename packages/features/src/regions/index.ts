import { z } from "zod";
import { defineFeature, eachRawClip, IDENTITY, RgbaSchema, type BackdropLayer, type RGBA } from "@beacon/model";
import wgsl from "./regions.wgsl" with { type: "text" };

const regionSchema = z.strictObject({
  kind: z.enum(["blur", "spotlight", "highlight"]),
  /** Box size in content pixels; the transform scales it. */
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  intensity: z.number().nonnegative(),
  /** Blur outside the box instead of inside (spotlight always works outside). */
  invert: z.boolean(),
  /** A highlight's colour, multiplied onto the picture under it at `intensity` (its opacity). */
  color: RgbaSchema,
});

/** Camtasia's highlighter yellow; a highlight's opacity starts at half, as Camtasia's does. */
const YELLOW: RGBA = [1, 0.93, 0.25, 1];

/** Camtasia's pixelate comes in as a blur (Beacon's Pixelate went, the user, 2026-11-05): what it hid stays hidden. */
const KINDS: Record<string, "blur" | "spotlight"> = { TypeWinBlur: "blur", TypeWinPixelate: "blur", TypeWinSpotlight: "spotlight" };

function num(v: unknown, fallback: number): number {
  const x = v !== null && typeof v === "object" ? (v as { defaultValue?: unknown }).defaultValue : v;
  return typeof x === "number" ? x : fallback;
}

/** An Annotations panel preset: a 640 × 360 box. */
const preset = (kind: string, intensity: number, title: string, color: RGBA = YELLOW) => ({
  type: "region",
  title,
  props: { region: { kind, width: 640, height: 360, cornerRadius: kind === "highlight" ? 0 : 6, intensity, invert: false, color } },
});

/** v2: a colour, for highlights (the user, 2026-10-27). */
function regionColor(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const r = o.props?.region as Record<string, unknown> | undefined;
    if (r) r.color ??= YELLOW;
  });
  return doc;
}

/**
 * v3: Pixelate went (the user, 2026-11-05: never used); a pixelated box becomes a blur about as strong (its blocks
 * were `intensity` × 60 px, a blur's radius is `intensity` × 8, half a block blurs about as much), so what it hid
 * stays hidden.
 */
function pixelateToBlur(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const r = o.props?.region as Record<string, unknown> | undefined;
    if (r?.kind !== "pixelate") return;
    r.kind = "blur";
    r.intensity = Math.max(1, (typeof r.intensity === "number" ? r.intensity : 0.33) * 3.75);
  });
  return doc;
}

/**
 * Blur, spotlight and highlight regions: boxes that change what is already
 * composited under them. Intensity → strength mappings are guesses.
 */
export const regions = defineFeature({
  id: "regions",
  panelItems: [
    { id: "annotation:spotlight", label: "Spotlight", title: "Darken everything outside the box", command: "edit.addAnnotation", args: { preset: "spotlight" }, seconds: 5 },
    { id: "annotation:blur", label: "Blur", title: "Blur what is inside the box", command: "edit.addAnnotation", args: { preset: "blur" }, seconds: 5 },
    { id: "annotation:highlight", label: "Highlight", title: "A highlighter's colour over what is inside the box, the text under it still readable", command: "edit.addAnnotation", args: { preset: "highlight" }, seconds: 5 },
  ],
  annotations: {
    spotlight: preset("spotlight", 0.5, "Add Spotlight"),
    blur: preset("blur", 2, "Add Blur"),
    highlight: preset("highlight", 0.5, "Add Highlight"),
  },
  version: 3,
  migrations: [
    { version: 2, migrate: regionColor },
    { version: 3, migrate: pixelateToBlur },
  ],
  clipTypes: [{ id: "region", description: "A blur, spotlight or highlight region", traits: ["visual", "region"] }],
  props: [
    {
      id: "region",
      description: "What the region does to the image under it, its box and strength",
      traits: ["region"],
      tab: { title: "Annotation Properties", icon: "chat-centered-text", order: 3 },
      schema: regionSchema,
      defaults: () => ({ kind: "blur", width: 400, height: 200, cornerRadius: 6, intensity: 1, invert: false, color: YELLOW }),
      animatable: ["width", "height", "intensity"],
    },
  ],
  passes: [
    { id: "region-blur", wgsl, steps: ["fs_blur_h", "fs_blur_v"] },
    { id: "region-darken", wgsl, steps: ["fs_darken"] },
    { id: "region-highlight", wgsl, steps: ["fs_highlight"] },
  ],
  camtasia: {
    clipTypes: { Callout: (m) => (KINDS[m.def?.kind] ? { type: "region" } : null) },
    params(media, clip) {
      if (clip.type !== "region") return;
      const d = media.def ?? {};
      clip.props.region = {
        kind: KINDS[d.kind]!,
        width: num(d.width, 400),
        height: num(d.height, 200),
        cornerRadius: num(d["corner-radius"], 6),
        intensity: num(d.intensity, 1),
        invert: num(d["blur-invert"], 0) !== 0,
        color: YELLOW,
      };
    },
  },
  evaluate: {
    clip(e) {
      const r = e.props.region;
      if (e.clip.type !== "region" || !r) return;
      const passes =
        r.kind === "blur"
          ? [{ pass: "region-blur", params: [r.intensity * 8] }]
          : r.kind === "highlight"
            ? [{ pass: "region-highlight", params: [r.color[0], r.color[1], r.color[2], Math.min(1, r.intensity) * r.color[3]] }]
            : [{ pass: "region-darken", params: [Math.min(1, r.intensity)] }];
      const layer: BackdropLayer = {
        kind: "backdrop",
        size: [r.width, r.height],
        transform: IDENTITY,
        radius: [r.cornerRadius, r.cornerRadius, r.cornerRadius, r.cornerRadius],
        invert: r.kind === "spotlight" ? true : r.invert,
        passes,
      };
      e.layers.push(layer);
      e.main = layer;
    },
  },
});
