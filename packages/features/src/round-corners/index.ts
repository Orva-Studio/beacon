import { z } from "zod";
import { defineFeature } from "@beacon/model";

/** Rounds the clip's corners. Radius in canvas pixels. */
export const roundCorners = defineFeature({
  id: "round-corners",
  panelItems: [{ id: "effect:round-corners", favorite: true }],
  version: 1,
  effects: [
    {
      id: "round-corners",
      description: "Rounded corners on the clip's content",
      traits: ["visual"],
      params: z.strictObject({
        radius: z.number().nonnegative().meta({ slider: { max: 200 } }),
        topLeft: z.boolean(),
        topRight: z.boolean(),
        bottomRight: z.boolean(),
        bottomLeft: z.boolean(),
      }),
      defaults: () => ({ radius: 20, topLeft: true, topRight: true, bottomRight: true, bottomLeft: true }),
    },
  ],
  camtasia: {
    effects: {
      RoundCorners: (fx, ctx) => {
        const on = (k: string) => Number(ctx.value(fx, k) ?? 1) !== 0;
        return {
          type: "round-corners",
          params: { radius: Number(ctx.value(fx, "radius") ?? 20), topLeft: on("top-left"), topRight: on("top-right"), bottomRight: on("bottom-right"), bottomLeft: on("bottom-left") },
        };
      },
    },
  },
  evaluate: {
    clip(e) {
      const fx = e.clip.effects.find((x) => x.type === "round-corners" && x.enabled);
      if (!fx || e.main?.kind !== "visual") return;
      const p = fx.params as { radius: number; topLeft: boolean; topRight: boolean; bottomRight: boolean; bottomLeft: boolean };
      const [a, b, c, d] = e.main.transform;
      const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
      const r = p.radius / scale;
      e.main.radius = [p.topLeft ? r : 0, p.topRight ? r : 0, p.bottomRight ? r : 0, p.bottomLeft ? r : 0];
    },
  },
});
