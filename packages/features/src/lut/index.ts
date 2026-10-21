import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { defineFeature } from "@beacon/model";
import wgsl from "./lut.wgsl" with { type: "text" };

/** `Asset.derived.lut`: what a `.cube` file holds, read as it is imported. */
export interface CubeInfo {
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

/** Reads a 3D `.cube` (Adobe's Cube format) and checks it is whole: its size and domain, refusing a 1D table. */
export async function readCube(path: string): Promise<CubeInfo> {
  const text = await readFile(path, "utf8");
  const bad = (why: string) => new Error(`${basename(path)} isn't a LUT Beacon can read: ${why}`);
  let size = 0;
  let title = basename(path, ".cube");
  let domainMin: CubeInfo["domainMin"] = [0, 0, 0];
  let domainMax: CubeInfo["domainMax"] = [1, 1, 1];
  let values = 0;
  const triple = (words: string[]) => words.slice(1, 4).map(Number) as [number, number, number];
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const words = line.split(/\s+/);
    if (words[0] === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "") || title;
    else if (words[0] === "LUT_3D_SIZE") size = Number(words[1]);
    else if (words[0] === "LUT_1D_SIZE") throw bad("it is a 1D LUT, and only 3D LUTs are");
    else if (words[0] === "DOMAIN_MIN") domainMin = triple(words);
    else if (words[0] === "DOMAIN_MAX") domainMax = triple(words);
    else if (/^[-+.\d]/.test(words[0]!)) {
      if (words.length !== 3 || words.some((w) => !Number.isFinite(Number(w)))) throw bad(`"${line}" isn't three numbers`);
      values++;
    }
  }
  if (!Number.isInteger(size) || size < 2 || size > 256) throw bad("it has no LUT_3D_SIZE");
  if (values !== size ** 3) throw bad(`it has ${values} entries for a ${size}³ table`);
  return { title, size, domainMin, domainMax };
}

const params = z.strictObject({
  lut: z.string().nullable().meta({ asset: "file", extensions: ["cube"] }).describe("The LUT: a .cube file's asset id (media_import it first)"),
  intensity: z.number().min(0).max(1).meta({ percent: true }).describe("How much of the LUT's grade shows over the clip"),
});

/**
 * LUT: a `.cube` grade on a clip, the file copied into the project so it travels with it, with an Intensity. Drawn
 * before Film Look (a LUT first, a look on top); preview equal to export.
 */
export const lut = defineFeature({
  id: "lut",
  version: 1,
  importers: [{ id: "cube", extensions: [".cube"], kind: "file", copyIn: true, probe: async (path) => ({ lut: await readCube(path) }), clips: () => [] }],
  effects: [
    {
      id: "lut",
      title: "LUT",
      description: "A colour grade from a .cube LUT file, mixed in by Intensity; the file is copied into the project",
      traits: ["visual"],
      params,
      defaults: () => ({ lut: null, intensity: 1 }),
      apply(e, raw, ctx) {
        const p = raw as z.infer<typeof params>;
        const asset = p.lut ? ctx.project.assets[p.lut] : undefined;
        const info = asset?.derived.lut as CubeInfo | undefined;
        if (!asset || !info || p.intensity <= 0) return;
        (e.main.passes ??= []).push({ pass: "lut", params: [p.intensity, ...info.domainMin, ...info.domainMax], lut: asset.path });
      },
    },
  ],
  passes: [{ id: "lut", wgsl, steps: ["fs_lut"] }],
});
