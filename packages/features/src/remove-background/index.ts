import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { makeMatte, type Matte } from "@beacon/media";
import { defineFeature, IDENTITY, RgbaSchema, type Asset, type Layer, type RGBA, type VisualLayer } from "@beacon/model";
import { mediaInfo, sourceOf } from "../media";
import wgsl from "./remove-background.wgsl" with { type: "text" };

/** `matte` data: each video stream's person matte, by video stream index; a screen recording's streams have none. */
export interface MatteData {
  streams: Record<number, Matte>;
}

/** The video streams a person can be in: every one but a recording's screen. */
const peopleStreams = (asset: Asset) =>
  asset.kind === "image" || !asset.derived.media ? [] : mediaInfo(asset).streams.filter((s) => s.kind === "video").flatMap((s, i) => (s.role === "screen" ? [] : [{ s, i }]));

const params = z.strictObject({
  background: z.enum(["transparent", "blur", "color", "image"]).describe("What shows behind the person: the clips below (transparent), the clip's own picture blurred, a colour or an image"),
  blur: z.number().min(0).max(1).meta({ percent: true, when: { background: "blur" } }).describe("How blurred the clip's own picture is behind the person (background blur)"),
  color: RgbaSchema.meta({ when: { background: "color" } }).describe("The colour behind the person (background color)"),
  image: z.string().nullable().meta({ asset: "image", when: { background: "image" } }).describe("The image behind the person (background image): an image asset's id, filling the clip"),
  softness: z.number().min(0).max(1).meta({ percent: true }).describe("How soft the person's edge is"),
  shrink: z.number().min(-1).max(1).meta({ percent: true }).describe("Moves the person's edge in (above 0) or out (below 0)"),
});
type Params = z.infer<typeof params>;

/** Matte brightness drawn clear and drawn opaque, from the edge's softness and shrink. */
export const matteRange = (p: Pick<Params, "softness" | "shrink">): [number, number] => {
  const [middle, half] = [0.5 + 0.4 * p.shrink, 0.02 + 0.48 * p.softness];
  return [middle - half, middle + half];
};

/** The clip's own picture blurred, drawn small (a heavy blur at full size costs a tap per pixel of it), then scaled up. */
function blurred(content: VisualLayer["content"], size: [number, number], amount: number): Layer {
  const sigma = amount * 0.03 * Math.max(...size);
  const k = Math.min(16, Math.max(1, sigma / 4));
  const small: [number, number] = [Math.max(1, Math.round(size[0] / k)), Math.max(1, Math.round(size[1] / k))];
  const copy: VisualLayer = { kind: "visual", content, size, transform: [small[0] / size[0], 0, 0, small[1] / size[1], 0, 0], passes: [{ pass: "remove-background-blur", params: [sigma / k] }] };
  return { kind: "visual", content: { type: "group", background: [0, 0, 0, 0], layers: [copy] }, size: small, transform: [size[0] / small[0], 0, 0, size[1] / small[1], 0, 0] };
}

/** An image filling a box `size` (cropped to it, centred). */
function filling(source: string, image: [number, number], size: [number, number]): Layer {
  const s = Math.max(size[0] / image[0], size[1] / image[1]);
  return { kind: "visual", content: { type: "source", source }, size: image, transform: [s, 0, 0, s, (size[0] - image[0] * s) / 2, (size[1] - image[1] * s) / 2] };
}

/**
 * Remove Background: a camera or video clip's background taken away with no green screen. Apple's Vision finds the
 * person in each frame once per medium (the `matte` job, cached like proxies); the clip is then drawn through that
 * matte, over the clips below or over a blur of itself, a colour or an image. Preview and export read the same matte.
 */
export const removeBackground = defineFeature({
  id: "remove-background",
  version: 1,
  jobAnalyzers: [
    {
      id: "matte",
      description: "The person in each frame of a camera or video stream (Apple's Vision), as a grey movie: what Remove Background draws through",
      version: 1,
      when: "asked",
      folder: "mattes",
      applies: (asset) => peopleStreams(asset).length > 0,
      async analyze(asset, progress, { cacheDir, quiet }) {
        const streams = peopleStreams(asset);
        const key = new Bun.CryptoHasher("sha256").update(`${asset.path}\0${asset.fingerprint}`).digest("hex").slice(0, 16);
        const out: MatteData["streams"] = {};
        for (const [n, { s, i }] of streams.entries()) {
          const src = sourceOf(asset, "video", i);
          out[i] = await makeMatte(src.path, src.stream, join(cacheDir, "mattes", `${key}-v${i}.mov`), s.duration || mediaInfo(asset).duration, {
            quiet,
            onProgress: (f) => progress((n + f) / streams.length),
          });
        }
        return { streams: out } satisfies MatteData;
      },
      discard(result) {
        for (const m of Object.values((result as MatteData).streams ?? {})) rmSync(m.path, { force: true });
      },
      revive(result, { cacheDir }) {
        const data = result as MatteData;
        const streams: MatteData["streams"] = {};
        for (const [i, m] of Object.entries(data.streams ?? {})) {
          const path = existsSync(m.path) ? m.path : join(cacheDir, "mattes", basename(m.path));
          if (!existsSync(path)) return undefined;
          streams[Number(i)] = { ...m, path };
        }
        return Object.entries(streams).some(([i, m]) => m.path !== data.streams[Number(i)]!.path) ? ({ streams } satisfies MatteData) : result;
      },
    },
  ],
  effects: [
    {
      id: "remove-background",
      title: "Remove Background",
      description:
        "Takes the background away from a person on camera, no green screen needed: the clips below show through, or the clip's own picture blurred, a colour or an image. Finding the person takes a while the first time for each medium (about a minute per minute of video); until then the clip shows as it is",
      traits: ["video"],
      params,
      needs: ["matte"],
      preparing: "Finding the person",
      defaults: () => ({ background: "transparent", blur: 0.5, color: [0.07, 0.07, 0.08, 1], image: null, softness: 0.5, shrink: 0 }) satisfies Params,
      apply(e, raw, ctx) {
        const p = raw as Params;
        const stream = (e.props.media as { stream: number } | undefined)?.stream ?? 0;
        const matte = e.clip.assetId ? ctx.data<MatteData>(e.clip.assetId, "matte")?.streams[stream] : undefined;
        if (!matte || e.main.content.type !== "source") return;
        const source = ctx.source({ kind: "video", path: matte.path, stream: 0 });
        const person: VisualLayer["matte"] = { source, time: e.main.content.time ?? 0, range: matteRange(p) };
        const size = e.main.size;
        const image = p.background === "image" && p.image ? ctx.project.assets[p.image] : undefined;
        const picture = image?.derived.media ? mediaInfo(image).streams.find((s) => s.kind === "video") : undefined;
        const behind: Layer | undefined =
          p.background === "blur"
            ? blurred(e.main.content, size, p.blur)
            : p.background === "color"
              ? { kind: "visual", content: { type: "solid", color: p.color as RGBA }, size, transform: IDENTITY }
              : image && picture?.width && picture.height
                ? filling(ctx.source({ kind: "image", path: image.path }), [picture.width, picture.height], size)
                : undefined;
        if (!behind) return void (e.main.matte = person);
        // The person over what is behind them, as one picture: effects after this one (a look, rounded corners) take both.
        e.main.content = { type: "group", background: [0, 0, 0, 0], layers: [behind, { kind: "visual", content: e.main.content, size, transform: IDENTITY, matte: person }] };
      },
    },
  ],
  passes: [{ id: "remove-background-blur", wgsl, steps: ["fs_blur_h", "fs_blur_v", "fs_fill"] }],
});
