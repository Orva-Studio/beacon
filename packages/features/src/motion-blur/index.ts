import { z } from "zod";
import { defineFeature, shutterTimes } from "@beacon/model";

/**
 * Blurs a clip along its animated motion by averaging its transform over the
 * shutter interval before each frame. Register after `transform`: it reads canvas-space transforms.
 */
export const motionBlur = defineFeature({
  id: "motion-blur",
  panelItems: [{ id: "effect:motion-blur", favorite: true }],
  version: 1,
  effects: [
    {
      id: "motion-blur",
      description: "Blur along the clip's motion",
      traits: ["visual"],
      params: z.strictObject({ intensity: z.number().nonnegative().meta({ slider: { max: 2 } }) }),
      defaults: () => ({ intensity: 1 }),
      apply(e, p, ctx) {
        if (e.sample) return;
        const index = e.layers.indexOf(e.main);
        const motion = [];
        const perspective: [number, number][] = [];
        for (const time of shutterTimes(e.time, ctx.frameSeconds, p.intensity)) {
          const s = ctx.evalClip(e.clip, e.track, time, { sample: true });
          const layer = s.layers[index];
          if (layer?.kind !== "visual") continue;
          motion.push(layer.transform);
          perspective.push(layer.perspective ?? [0, 0]);
        }
        const main = e.main.perspective ?? [0, 0];
        const moves = motion.some((m) => m.some((v, k) => Math.abs(v - e.main!.transform[k]!) > 1e-3));
        const tilts = perspective.some((p) => Math.abs(p[0] - main[0]) + Math.abs(p[1] - main[1]) > 1e-9);
        if (!moves && !tilts) return;
        e.main.motion = motion;
        // Read after `transform`, which tilts only the motion it finds; each sample's own tilt, or the copies draw flat.
        if (perspective.some((p) => p[0] || p[1])) e.main.motionPerspective = perspective;
      },
    },
  ],
  camtasia: { effects: { MotionBlur: (fx, ctx) => ({ type: "motion-blur", params: ctx.numbers(fx, { intensity: "intensity" }) }) } },
});
