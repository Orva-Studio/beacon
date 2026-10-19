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
  panelItems: [{ id: "effect:crt-monitor", favorite: true }],
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
      apply(e, p) {
        (e.main.passes ??= []).unshift({
          pass: "crt-monitor",
          params: [p.brightness, p.chromaticShift, p.cornerRadius, p.scanlineBrightness, p.scanlineSpacing, p.vignetteIntensity, p.vignetteShape, p.warp],
        });
      },
    },
  ],
  passes: [{ id: "crt-monitor", wgsl, steps: ["fs_crt"] }],
  camtasia: {
    effects: {
      "CRT Monitor": (fx, ctx) => ({
        type: "crt-monitor",
        params: ctx.numbers(fx, {
          brightness: "Brightness",
          chromaticShift: "ChromaticShift",
          cornerRadius: "CornerRadius",
          scanlineBrightness: "ScanlineBrightness",
          scanlineSpacing: "ScanlineSpacing",
          vignetteIntensity: "VignetteIntensity",
          vignetteShape: "VignetteShape",
          warp: "Warp",
        }),
      }),
    },
  },
});
