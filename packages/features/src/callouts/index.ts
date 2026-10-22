import { z } from "zod";
import { defineFeature, defineQuery, IDENTITY, RgbaSchema, solidLayer, walkClips, ticksToSeconds, type CamtasiaObject, type ClipEval, type EvalContext, type RGBA, type VisualLayer } from "@beacon/model";
import { fontFamilies, textLayout } from "@beacon/media";
import { flattenPath, trimLines } from "./svg-path";

const textSchema = z.strictObject({
  text: z.string(),
  font: z.string(),
  weight: z.number(),
  italic: z.boolean(),
  size: z.number().positive(),
  color: RgbaSchema,
  tracking: z.number(),
  lineSpacing: z.number(),
  align: z.enum(["left", "center", "right"]),
  valign: z.enum(["top", "center", "bottom"]),
});

const calloutSchema = z.strictObject({
  shape: z.enum(["text", "rectangle", "sketch"]),
  /** Box size in content pixels; the transform scales it. */
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  fill: RgbaSchema.optional(),
  stroke: z.strictObject({ color: RgbaSchema, width: z.number().nonnegative() }).optional(),
  text: textSchema.optional(),
  /** A hand-drawn stroke that draws itself on (sketch motion callouts). */
  sketch: z
    .strictObject({
      /** SVG path data; its bounds are stretched to the box. */
      paths: z.array(z.string()),
      viewBox: z.tuple([z.number(), z.number()]),
      /** Seconds to draw the stroke from the clip's start. */
      drawTime: z.number().nonnegative(),
    })
    .optional(),
});

export type Callout = z.infer<typeof calloutSchema>;

/** Raster resolution for text: the on-canvas scale, in quarter steps so animated scale reuses rasters. */
function rasterScale(e: ClipEval): number {
  const t = e.props.transform;
  const s = t ? Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY)) : 1;
  return Math.min(4, Math.max(1, Math.ceil(s * 4) / 4));
}

/** A closed rounded rectangle through the middle of a stroke `sw` wide inside a `w` × `h` box. */
function outline(w: number, h: number, radius: number, sw: number): [number, number][] {
  const i = sw / 2;
  const r = Math.min(Math.max(0, radius - i), (w - sw) / 2, (h - sw) / 2);
  const corners: [number, number, number][] = [
    [w - i - r, i + r, -Math.PI / 2],
    [w - i - r, h - i - r, 0],
    [i + r, h - i - r, Math.PI / 2],
    [i + r, i + r, Math.PI],
  ];
  const points = corners.flatMap(([cx, cy, a0]) =>
    Array.from({ length: 9 }, (_, k): [number, number] => [cx + r * Math.cos(a0 + (k * Math.PI) / 16), cy + r * Math.sin(a0 + (k * Math.PI) / 16)]),
  );
  return [...points, points[0]!];
}

function evaluateCallout(e: ClipEval, ctx: EvalContext) {
  const c = e.props.callout as Callout;
  const size: [number, number] = [c.width, c.height];
  if (c.shape === "rectangle") {
    const sw = c.stroke && c.stroke.color[3] > 0 ? c.stroke.width : 0;
    // Under an opaque fill a solid box shows only as the stroke; under a see-through fill (or none) the stroke must be a ring.
    const opaque = !!c.fill && c.fill[3] >= 1;
    let ring: VisualLayer | undefined;
    if (sw > 0 && opaque) e.layers.push(solidLayer(c.stroke!.color, size, c.cornerRadius));
    if (c.fill) e.layers.push(solidLayer(c.fill, [Math.max(1, c.width - 2 * sw), Math.max(1, c.height - 2 * sw)], Math.max(0, c.cornerRadius - sw), [sw, sw]));
    if (sw > 0 && !opaque) {
      const source = ctx.source({ kind: "strokes", lines: [outline(c.width, c.height, c.cornerRadius, sw)], width: c.width, height: c.height, strokeWidth: sw, color: c.stroke!.color, scale: rasterScale(e) });
      ring = { kind: "visual", content: { type: "source", source }, size, transform: IDENTITY };
      e.layers.push(ring);
    }
    // The box is the clip's content for effects and the transform, even when only its stroke is drawn.
    e.main = ring ?? e.layers[0] ?? solidLayer([0, 0, 0, 0], size, c.cornerRadius);
    if (!e.layers.length) e.layers.push(e.main);
    e.main.size = size;
    return;
  }
  if (c.shape === "sketch") {
    if (!c.sketch || !c.stroke) return;
    const raw = c.sketch.paths.flatMap((d) => flattenPath(d));
    const xs = raw.flat().map((p) => p[0]);
    const ys = raw.flat().map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const fx = c.width / Math.max(x1 - x0, 1e-6);
    const fy = c.height / Math.max(y1 - y0, 1e-6);
    const lines = raw.map((l) => l.map(([x, y]): [number, number] => [(x - x0) * fx, (y - y0) * fy]));
    const since = ticksToSeconds(e.time - e.clip.start);
    // Draw-on is fast then slow (quadratic ease-out fitted to a Camtasia export).
    const t = c.sketch.drawTime > 0 ? Math.min(1, since / c.sketch.drawTime) : 1;
    const progress = 1 - (1 - t) ** 2;
    // The stroke width is in canvas pixels: it does not scale with the callout.
    const tr = e.props.transform;
    const strokeWidth = c.stroke.width / Math.max(1e-3, tr ? Math.sqrt(Math.abs(tr.scaleX * tr.scaleY)) : 1);
    const main: VisualLayer = {
      kind: "visual",
      content: {
        type: "source",
        source: ctx.source({ kind: "strokes", lines: trimLines(lines, progress), width: c.width, height: c.height, strokeWidth, color: c.stroke.color, scale: rasterScale(e) }),
      },
      size,
      transform: IDENTITY,
    };
    e.layers.push(main);
    e.main = main;
    return;
  }
  if (!c.text) return;
  const main: VisualLayer = {
    kind: "visual",
    content: { type: "source", source: ctx.source({ kind: "text", ...c.text, width: c.width, height: c.height, scale: rasterScale(e) }) },
    size,
    transform: IDENTITY,
  };
  e.layers.push(main);
  e.main = main;
}

/** `.cmproj` def values are plain or `{ defaultValue }`. */
function num(v: unknown, fallback: number): number {
  const x = v !== null && typeof v === "object" ? (v as { defaultValue?: unknown }).defaultValue : v;
  return typeof x === "number" ? x : fallback;
}

/** `"(255,255,255,255)"` → RGBA. */
function parseColor(s: string): RGBA | undefined {
  const m = /\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/.exec(s);
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, Number(m[4]) / 255] : undefined;
}

function calloutFromCamtasia(media: CamtasiaObject, report: (m: string) => void): Callout | null {
  const d = media.def ?? {};
  const width = num(d.width, 400);
  const height = num(d.height, 200);
  const cornerRadius = num(d["corner-radius"], 0);
  if (d.shape === "shape-rectangle") {
    const color = (p: string): RGBA => [num(d[`${p}-red`], 0), num(d[`${p}-green`], 0), num(d[`${p}-blue`], 0), num(d[`${p}-opacity`], 1)];
    if (d["fill-style"] && d["fill-style"] !== "solid") report(`fill style "${d["fill-style"]}" drawn as solid`);
    return { shape: "rectangle", width, height, cornerRadius, fill: color("fill-color"), stroke: { color: color("stroke-color"), width: num(d["stroke-width"], 0) } };
  }
  if (d.kind === "TypeWinSVG") {
    const xml = String(d.xmlContent ?? "");
    const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(xml);
    const paths = [...xml.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    if (/<(ellipse|circle|line|polyline|polygon|rect)\b/.test(xml)) report("sketch shapes other than <path> are not drawn");
    return {
      shape: "sketch",
      width,
      height,
      cornerRadius,
      stroke: { color: [num(d.borderColorRed, 1), num(d.borderColorGreen, 0), num(d.borderColorBlue, 0), 1], width: num(d.borderWidth, 10) },
      sketch: { paths, viewBox: [vb ? Number(vb[1]) : 420, vb ? Number(vb[2]) : 420], drawTime: num(d.DrawTime, 1) },
    };
  }
  if (d.shape !== "text") return null;
  const font = d.font ?? {};
  const text: Callout["text"] = {
    text: String(d.text ?? ""),
    font: String(font.name ?? "Helvetica Neue"),
    weight: font.weight === "Bold" ? 700 : 400,
    italic: false,
    size: num(font.size, 64),
    color: [num(font["color-red"], 1), num(font["color-green"], 1), num(font["color-blue"], 1), 1],
    tracking: num(font.tracking, 0),
    lineSpacing: num(d["line-spacing"], 0),
    align: (["left", "center", "right"].includes(d["horizontal-alignment"]) ? d["horizontal-alignment"] : "center") as "center",
    valign: (["top", "center", "bottom"].includes(d["vertical-alignment"]) ? d["vertical-alignment"] : "center") as "center",
  };
  // Per-range attributes override the def; ranges covering only part of the text are not supported.
  const ranges: CamtasiaObject[] = d.textAttributes?.keyframes?.[0]?.value ?? [];
  const len = text.text.length;
  for (const a of ranges) {
    if (a.rangeStart !== 0 || a.rangeEnd < len) {
      report(`text attribute "${a.name}" on part of the text applied to all of it`);
    }
    if (a.name === "fontName") text.font = String(a.value);
    else if (a.name === "fontWeight") text.weight = Number(a.value);
    else if (a.name === "fontSize") text.size = Number(a.value);
    else if (a.name === "fontItalic") text.italic = Number(a.value) !== 0;
    else if (a.name === "kerning") text.tracking = Number(a.value);
    else if (a.name === "fgColor") text.color = parseColor(String(a.value)) ?? text.color;
  }
  if (num(d["text-stroke-width"], 0) > 0) report("text stroke is not supported");
  return { shape: "text", width, height, cornerRadius, text };
}

/** Text, rectangle and sketch callouts (and sketch motion callouts). */
export const callouts = defineFeature({
  id: "callouts",
  panelItems: [
    { id: "annotation:text", label: "Text", title: "White text with a drop shadow", command: "edit.addAnnotation", args: { preset: "text" }, seconds: 5, favorite: true },
    { id: "annotation:rectangle", label: "Rectangle", title: "A black rounded rectangle", command: "edit.addAnnotation", args: { preset: "rectangle" }, seconds: 5, favorite: true },
  ],
  // The settings the user's projects use most.
  annotations: {
    text: {
      type: "callout",
      title: "Add Text",
      effects: [{ type: "drop-shadow", params: {} }],
      props: { callout: { shape: "text", width: 900, height: 200, cornerRadius: 8, text: { text: "Text", font: "Suisse Intl", weight: 500, italic: false, size: 96, color: [1, 1, 1, 1], tracking: 0, lineSpacing: 0, align: "center", valign: "center" } } },
    },
    rectangle: { type: "callout", title: "Add Rectangle", props: { callout: { shape: "rectangle", width: 640, height: 360, cornerRadius: 8, fill: [0, 0, 0, 1] } } },
  },
  version: 1,
  clipTypes: [{ id: "callout", description: "A text or rectangle annotation", traits: ["visual", "callout"] }],
  queries: [
    defineQuery({
      id: "callout.textLayout",
      description: "A text callout's lines as the renderer lays them out, in box units (y down): each line's text range, top, bottom and caret positions. For editing text in place",
      args: z.strictObject({ clip: z.string() }),
      run({ clip }, { project, registry }) {
        const c = [...walkClips(project.tracks, registry)].find((l) => l.clip.id === clip)?.clip.props.callout as z.infer<typeof calloutSchema> | undefined;
        if (!c?.text) throw new Error(`clip "${clip}" is not a text callout`);
        return textLayout({ ...c.text, width: c.width, height: c.height, scale: 2 });
      },
    }),
    defineQuery({
      id: "callout.fonts",
      description: "Every font family installed, for a callout's font",
      args: z.strictObject({}),
      run: () => fontFamilies(),
    }),
  ],
  props: [
    {
      id: "callout",
      description: "Shape, box size, fill, stroke and text of a callout",
      traits: ["callout"],
      tab: { title: "Annotation Properties", icon: "chat-centered-text", order: 2 },
      schema: calloutSchema,
      defaults: () => ({ shape: "text", width: 400, height: 200, cornerRadius: 0 }),
    },
  ],
  camtasia: {
    clipTypes: {
      Callout: (m) =>
        (m.def?.kind === "remix" && ["text", "shape-rectangle"].includes(m.def?.shape)) || m.def?.kind === "TypeWinSVG" ? { type: "callout" } : null,
    },
    params(media, clip, ctx) {
      if (clip.type !== "callout") return;
      const c = calloutFromCamtasia(media, (m) => ctx.report(m));
      if (c) clip.props.callout = c;
    },
  },
  evaluate: {
    clip(e, ctx) {
      if (e.clip.type === "callout" && e.props.callout) evaluateCallout(e, ctx);
    },
  },
});
