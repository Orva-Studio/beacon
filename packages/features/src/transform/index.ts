import { z } from "zod";
import { compose, defineFeature, fromAffine, multiply, placement, split, translate, type ClipEval, type EvalContext, type Layer, type Matrix3, type TransformValues } from "@beacon/model";

const transformGroup = z.strictObject({
  /** Canvas pixels from the canvas centre to the content centre; y points up. */
  x: z.number(),
  y: z.number(),
  /** Content pixels → canvas pixels. */
  scaleX: z.number(),
  scaleY: z.number(),
  /** Radians, about the content centre. */
  rotation: z.number(),
  /** Radians: 3D tilt about the clip's horizontal (X) and vertical (Y) axes, seen in perspective. */
  rotationX: z.number(),
  rotationY: z.number(),
  opacity: z.number().min(0).max(1),
});

const cropGroup = z.strictObject({
  /** Content pixels removed from each edge; the rest stays where it was. */
  left: z.number().nonnegative(),
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
});

/** `.cmproj` stores zero crops as ±1e-13. */
const nonNegative = (v: number) => Math.max(0, v);

/** Content pixels of a clip → canvas pixels, in perspective when tilted. */
export function contentToCanvas(e: ClipEval, ctx: EvalContext, size: [number, number]): Matrix3 {
  return placement(ctx.canvas, size, e.props.transform as unknown as TransformValues);
}

/** v2: the 3D tilts, flat in every clip that had a transform. */
function addTilt(doc: unknown): unknown {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const t = (o.props as Record<string, unknown> | undefined)?.transform as Record<string, unknown> | undefined;
    if (t && typeof t === "object") {
      t.rotationX ??= 0;
      t.rotationY ??= 0;
    }
    Object.values(o).forEach(visit);
  };
  visit(doc);
  return doc;
}

function multiplyOpacity(layer: Layer, k: number) {
  layer.opacity = (layer.opacity ?? 1) * k;
}

/**
 * Position, scale, rotation, opacity and crop of visual clips. Maps every
 * layer the clip drew in content space onto the canvas; crop applies to the
 * clip's own content only (the cursor is not cropped).
 */
export const transform = defineFeature({
  id: "transform",
  version: 2,
  migrations: [{ version: 2, migrate: addTilt }],
  props: [
    {
      id: "transform",
      description: "Position (from the canvas centre, y up), scale, rotation and opacity",
      traits: ["visual"],
      schema: transformGroup,
      defaults: () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 }),
      animatable: ["x", "y", "scaleX", "scaleY", "rotation", "rotationX", "rotationY", "opacity"],
    },
    {
      id: "crop",
      description: "Content pixels cropped from each edge",
      traits: ["visual"],
      schema: cropGroup,
      defaults: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
      animatable: ["left", "top", "right", "bottom"],
    },
  ],
  camtasia: {
    params(media, _clip, ctx) {
      ctx.param(media, "translation0", "transform.x");
      ctx.param(media, "translation1", "transform.y");
      ctx.param(media, "scale0", "transform.scaleX");
      ctx.param(media, "scale1", "transform.scaleY");
      ctx.param(media, "rotation0", "transform.rotationX");
      ctx.param(media, "rotation1", "transform.rotationY");
      ctx.param(media, "rotation2", "transform.rotation");
      ctx.param(media, "opacity", "transform.opacity");
      ctx.param(media, "geometryCrop0", "crop.left", nonNegative);
      ctx.param(media, "geometryCrop1", "crop.top", nonNegative);
      ctx.param(media, "geometryCrop2", "crop.right", nonNegative);
      ctx.param(media, "geometryCrop3", "crop.bottom", nonNegative);
      for (const [name, flat] of [["scale2", 1], ["translation2", 0]] as const) {
        const v = ctx.value(media, name);
        if (v !== undefined && Math.abs(Number(v) - flat) > 1e-9) ctx.report(`3D ${name} = ${v} ignored`);
      }
    },
  },
  evaluate: {
    clip(e, ctx) {
      if (!e.main || !e.props.transform) return;
      const toCanvas = contentToCanvas(e, ctx, e.main.size);
      const c = e.props.crop!;
      const place = (inner: Matrix3) => split(multiply(toCanvas, inner));
      for (const layer of e.layers) {
        const inner = layer === e.main && layer.kind === "visual" ? compose(translate(c.left, c.top), layer.transform) : layer.transform;
        if (layer === e.main && layer.kind === "visual") layer.crop = [c.left, c.top, c.right, c.bottom];
        const { transform, perspective } = place(fromAffine(inner));
        layer.transform = transform;
        // Backdrops (blur, spotlight regions) stay flat: the renderer tilts only drawn layers.
        if (perspective && layer.kind === "visual") layer.perspective = perspective;
        if (layer.kind === "visual" && layer.motion) layer.motion = layer.motion.map((m) => place(fromAffine(m)).transform);
        multiplyOpacity(layer, e.props.transform.opacity);
      }
    },
  },
});
