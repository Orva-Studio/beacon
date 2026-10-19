import { z } from "zod";
import { defineFeature, RgbaSchema, type CamtasiaContext, type CamtasiaObject } from "@beacon/model";
import wgsl from "./drop-shadow.wgsl" with { type: "text" };

export interface ShadowParams {
  /** Radians; 0 points right, counter-clockwise. */
  angle: number;
  /** Canvas pixels. */
  offset: number;
  blur: number;
  opacity: number;
  color: [number, number, number, number];
}

/** Pass params for a shadow. Blur → sigma is a placeholder. */
export function shadowParams(p: ShadowParams): number[] {
  return [
    Math.cos(p.angle) * p.offset,
    -Math.sin(p.angle) * p.offset,
    p.blur / 2,
    p.color[0],
    p.color[1],
    p.color[2],
    p.color[3] * p.opacity,
  ];
}

/** A Camtasia shadow's params it has; a colour with any channel set is black where the others are missing, as Camtasia's. */
export function shadowFromCamtasia(fx: CamtasiaObject, ctx: CamtasiaContext): Partial<ShadowParams> {
  const c = ctx.numbers(fx, { r: "color-red", g: "color-green", b: "color-blue", a: "color-alpha" });
  const color: ShadowParams["color"] | undefined = Object.keys(c).length ? [c.r ?? 0, c.g ?? 0, c.b ?? 0, c.a ?? 1] : undefined;
  return { ...ctx.numbers(fx, { angle: "angle", offset: "offset", blur: "blur", opacity: "opacity" }), ...(color ? { color } : {}) };
}

export const shadowSchema = z.strictObject({
  angle: z.number().meta({ degrees: true }),
  offset: z.number().meta({ slider: { max: 100 } }),
  blur: z.number().nonnegative().meta({ slider: { max: 100 } }),
  opacity: z.number().min(0).max(1).meta({ percent: true }),
  color: RgbaSchema,
});

/** A blurred, offset copy of the clip's alpha drawn under it. */
export const dropShadow = defineFeature({
  id: "drop-shadow",
  panelItems: [{ id: "effect:drop-shadow", favorite: true }],
  version: 1,
  effects: [
    {
      id: "drop-shadow",
      description: "Shadow behind the clip",
      traits: ["visual"],
      params: shadowSchema,
      defaults: () => ({ angle: 5.49779, offset: 10, blur: 10, opacity: 0.4, color: [0.1216, 0.1216, 0.1216, 1] }),
      apply(e, p) {
        (e.main.passes ??= []).push({ pass: "drop-shadow", params: shadowParams(p as ShadowParams) });
      },
    },
  ],
  passes: [{ id: "drop-shadow", wgsl, steps: ["fs_mask", "fs_blur_h", "fs_blur_v", "fs_combine"] }],
  camtasia: { effects: { DropShadow: (fx, ctx) => ({ type: "drop-shadow", params: shadowFromCamtasia(fx, ctx) }) } },
});
