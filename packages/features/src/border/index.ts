import { z } from "zod";
import { defineFeature, eachRawClip, RgbaSchema } from "@beacon/model";
import wgsl from "./border.wgsl" with { type: "text" };

/** Clip types that had the Border effect and take the property now (v1 was an effect on any visual clip). */
const PICTURES = new Set(["screen", "video", "image", "still", "stitched"]);

/** v2: the Border effect became a property of video and images; other clips (annotations) drop it. */
function effectToProp(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    if (!Array.isArray(o.effects) || !o.props || typeof o.props !== "object") return;
    const effects = o.effects as { type: string; enabled: boolean; params: { thickness: number; color: number[] } }[];
    const fx = effects.find((e) => e.type === "border" && e.enabled);
    if (fx && PICTURES.has(String(o.type))) o.props.border = { thickness: fx.params.thickness, color: fx.params.color };
    o.effects = effects.filter((e) => e.type !== "border");
  });
  return doc;
}

/** A band of colour just inside a video or image's edge (and Round Corners' curve). Thickness in canvas pixels; 0 is none. */
export const border = defineFeature({
  id: "border",
  version: 2,
  migrations: [{ version: 2, migrate: effectToProp }],
  props: [
    {
      id: "border",
      description: "A coloured border just inside the clip's edge, following Round Corners; thickness in canvas pixels, 0 for none",
      traits: ["picture"],
      schema: z.strictObject({ thickness: z.number().nonnegative(), color: RgbaSchema }),
      defaults: () => ({ thickness: 0, color: [1, 1, 1, 1] }),
    },
  ],
  passes: [{ id: "border", wgsl, steps: ["fs_border"] }],
  evaluate: {
    clip(e) {
      const p = e.props.border as { thickness: number; color: [number, number, number, number] } | undefined;
      if (!p || p.thickness <= 0 || p.color[3] <= 0 || e.main?.kind !== "visual") return;
      (e.main.passes ??= []).push({ pass: "border", params: [p.thickness, ...p.color] });
    },
  },
});
