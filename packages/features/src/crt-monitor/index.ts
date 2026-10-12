import { z } from "zod";
import { defineFeature } from "@beacon/model";
import wgsl from "./crt.wgsl" with { type: "text" };

// `slider`: the properties panel's range, not a limit; `percent`: shown ×100.
const params = z.strictObject({
  brightness: z.number().meta({ slider: { max: 3 } }),
  chromaticShift: z.number().meta({ slider: { max: 10 } }),
  cornerRadius: z.number().nonnegative().meta({ slider: { max: 100 } }),
  scanlineBrightness: z.number().meta({ slider: { max: 1 }, percent: true }),
  scanlineSpacing: z.number().positive().meta({ slider: { min: 1, max: 50 } }),
  vignetteIntensity: z.number().meta({ slider: { max: 1 }, percent: true }),
  vignetteShape: z.number().meta({ slider: { max: 10 } }),
  warp: z.number().meta({ slider: { max: 1 }, percent: true }),
});

/** Old-monitor look: barrel warp, scanlines, colour fringing, vignette. */
export const crtMonitor = defineFeature({
  id: "crt-monitor",
  version: 1,
  effects: [
    {
      id: "crt-monitor",
      description: "Old CRT monitor look",
      traits: ["visual"],
      params,
      defaults: () => ({
        brightness: 1,
        chromaticShift: 0,
        cornerRadius: 0,
        scanlineBrightness: 0.8,
        scanlineSpacing: 16.5288,
        vignetteIntensity: 0.2,
        vignetteShape: 5,
        warp: 0.0573914,
      }),
    },
  ],
  passes: [{ id: "crt-monitor", wgsl, steps: ["fs_crt"] }],
  camtasia: {
    effects: {
      "CRT Monitor": (fx, ctx) => {
        const n = (k: string, d: number) => Number(ctx.value(fx, k) ?? d);
        return {
          type: "crt-monitor",
          params: {
            brightness: n("Brightness", 1),
            chromaticShift: n("ChromaticShift", 0),
            cornerRadius: n("CornerRadius", 0),
            scanlineBrightness: n("ScanlineBrightness", 0.8),
            scanlineSpacing: n("ScanlineSpacing", 16.5288),
            vignetteIntensity: n("VignetteIntensity", 0.2),
            vignetteShape: n("VignetteShape", 5),
            warp: n("Warp", 0.0573914),
          },
        };
      },
    },
  },
  evaluate: {
    clip(e) {
      const fx = e.clip.effects.find((x) => x.type === "crt-monitor" && x.enabled);
      if (!fx || e.main?.kind !== "visual") return;
      const p = fx.params as z.infer<typeof params>;
      (e.main.passes ??= []).unshift({
        pass: "crt-monitor",
        params: [p.brightness, p.chromaticShift, p.cornerRadius, p.scanlineBrightness, p.scanlineSpacing, p.vignetteIntensity, p.vignetteShape, p.warp],
      });
    },
  },
});
