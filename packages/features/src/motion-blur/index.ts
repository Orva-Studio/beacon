import { z } from "zod";
import { defineFeature, secondsToTicks } from "@beacon/model";
import { SHUTTER } from "../cursor";

/**
 * Blurs a clip along its animated motion by averaging its transform over the
 * shutter interval before each frame. Register after `transform`: it reads canvas-space transforms.
 */
export const motionBlur = defineFeature({
  id: "motion-blur",
  version: 1,
  effects: [
    {
      id: "motion-blur",
      description: "Blur along the clip's motion",
      traits: ["visual"],
      params: z.strictObject({ intensity: z.number().nonnegative() }),
      defaults: () => ({ intensity: 1 }),
    },
  ],
  camtasia: { effects: { MotionBlur: (fx, ctx) => ({ type: "motion-blur", params: { intensity: Number(ctx.value(fx, "intensity") ?? 1) } }) } },
  evaluate: {
    clip(e, ctx) {
      const fx = e.clip.effects.find((x) => x.type === "motion-blur" && x.enabled);
      if (!fx || e.sample || e.main?.kind !== "visual") return;
      const index = e.layers.indexOf(e.main);
      const shutter = ctx.frameSeconds * Math.min(1, SHUTTER * (fx.params.intensity as number));
      const n = 16;
      const motion = [];
      for (let i = 1; i < n; i++) {
        const s = ctx.evalClip(e.clip, e.track, e.time - secondsToTicks((shutter * i) / n), { sample: true });
        const layer = s.layers[index];
        if (layer?.kind === "visual") motion.push(layer.transform);
      }
      if (motion.some((m) => m.some((v, k) => Math.abs(v - e.main!.transform[k]!) > 1e-3))) e.main.motion = motion;
    },
  },
});
