import { z } from "zod";
import { defineFeature, IDENTITY, type BackdropLayer } from "@beacon/model";
import wgsl from "./regions.wgsl" with { type: "text" };

const regionSchema = z.strictObject({
  kind: z.enum(["blur", "pixelate", "spotlight"]),
  /** Box size in content pixels; the transform scales it. */
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  intensity: z.number().nonnegative(),
  /** Blur outside the box instead of inside (spotlight always works outside). */
  invert: z.boolean(),
});

const KINDS: Record<string, "blur" | "pixelate" | "spotlight"> = { TypeWinBlur: "blur", TypeWinPixelate: "pixelate", TypeWinSpotlight: "spotlight" };

function num(v: unknown, fallback: number): number {
  const x = v !== null && typeof v === "object" ? (v as { defaultValue?: unknown }).defaultValue : v;
  return typeof x === "number" ? x : fallback;
}

/** An Annotations panel preset: a 640 × 360 box. */
const preset = (kind: string, intensity: number, title: string) => ({
  type: "region",
  title,
  props: { region: { kind, width: 640, height: 360, cornerRadius: 6, intensity, invert: false } },
});

/**
 * Blur, pixelate and spotlight regions: boxes that change what is already
 * composited under them. Intensity → strength mappings are guesses.
 */
export const regions = defineFeature({
  id: "regions",
  panelItems: [
    { id: "annotation:spotlight", label: "Spotlight", title: "Darken everything outside the box", command: "edit.addAnnotation", args: { preset: "spotlight" }, seconds: 5, favorite: true },
    { id: "annotation:blur", label: "Blur", title: "Blur what is inside the box", command: "edit.addAnnotation", args: { preset: "blur" }, seconds: 5 },
    { id: "annotation:pixelate", label: "Pixelate", title: "Pixelate what is inside the box", command: "edit.addAnnotation", args: { preset: "pixelate" }, seconds: 5 },
  ],
  annotations: { spotlight: preset("spotlight", 0.5, "Add Spotlight"), blur: preset("blur", 2, "Add Blur"), pixelate: preset("pixelate", 0.33, "Add Pixelate") },
  version: 1,
  clipTypes: [{ id: "region", description: "A blur, pixelate or spotlight region", traits: ["visual", "region"] }],
  props: [
    {
      id: "region",
      description: "What the region does to the image under it, its box and strength",
      traits: ["region"],
      schema: regionSchema,
      defaults: () => ({ kind: "blur", width: 400, height: 200, cornerRadius: 6, intensity: 1, invert: false }),
      animatable: ["width", "height", "intensity"],
    },
  ],
  passes: [
    { id: "region-blur", wgsl, steps: ["fs_blur_h", "fs_blur_v"] },
    { id: "region-pixelate", wgsl, steps: ["fs_pixelate"] },
    { id: "region-darken", wgsl, steps: ["fs_darken"] },
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
          : r.kind === "pixelate"
            ? [{ pass: "region-pixelate", params: [Math.max(2, r.intensity * 60)] }]
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
