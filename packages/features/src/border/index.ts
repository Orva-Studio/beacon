import { z } from "zod";
import { defineFeature, RgbaSchema } from "@beacon/model";
import wgsl from "./border.wgsl" with { type: "text" };

/** A band of colour just inside the clip's edge (and Round Corners' curve). Thickness in canvas pixels. */
export const border = defineFeature({
  id: "border",
  version: 1,
  effects: [
    {
      id: "border",
      description: "A coloured border just inside the clip's edge",
      traits: ["visual"],
      params: z.strictObject({
        thickness: z.number().nonnegative().meta({ slider: { max: 100 } }),
        color: RgbaSchema,
      }),
      defaults: () => ({ thickness: 8, color: [1, 1, 1, 1] }),
    },
  ],
  passes: [{ id: "border", wgsl, steps: ["fs_border"] }],
  evaluate: {
    clip(e) {
      const fx = e.clip.effects.find((x) => x.type === "border" && x.enabled);
      if (!fx || e.main?.kind !== "visual") return;
      const p = fx.params as { thickness: number; color: [number, number, number, number] };
      if (p.thickness <= 0 || p.color[3] <= 0) return;
      (e.main.passes ??= []).push({ pass: "border", params: [p.thickness, ...p.color] });
    },
  },
});
