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
      apply(e, p) {
        const [a, b, c, d] = e.main.transform;
        const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
        const r = p.radius / scale;
        e.main.radius = [p.topLeft ? r : 0, p.topRight ? r : 0, p.bottomRight ? r : 0, p.bottomLeft ? r : 0];
      },
    },
  ],
  camtasia: {
    effects: {
      RoundCorners: (fx, ctx) => {
        const corners = ctx.numbers(fx, { topLeft: "top-left", topRight: "top-right", bottomRight: "bottom-right", bottomLeft: "bottom-left" });
        return { type: "round-corners", params: { ...ctx.numbers(fx, { radius: "radius" }), ...Object.fromEntries(Object.entries(corners).map(([k, v]) => [k, v !== 0])) } };
      },
    },
  },
});
