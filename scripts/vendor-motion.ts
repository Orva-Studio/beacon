/**
 * The libraries motion graphics' pages may use, copied from the pinned devDependencies of @beacon/features into
 * `packages/features/src/motion/vendor`, where they are inlined into a page that uses them. Run after bumping one.
 * GSAP, TopoJSON and world-atlas are copied as they are; three.js ships only ES modules, so it is bundled into one
 * script that sets the global `THREE`.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modules = join(import.meta.dir, "../packages/features/node_modules");
const out = join(import.meta.dir, "../packages/features/src/motion/vendor");

copyFileSync(join(modules, "gsap/dist/gsap.min.js"), join(out, "gsap.min.js"));
copyFileSync(join(modules, "topojson-client/dist/topojson-client.min.js"), join(out, "topojson-client.min.js"));
copyFileSync(join(modules, "world-atlas/countries-50m.json"), join(out, "countries-50m.json"));

const dir = mkdtempSync(join(tmpdir(), "beacon-three-"));
try {
  const entry = join(dir, "entry.js");
  writeFileSync(entry, `import * as THREE from ${JSON.stringify(join(modules, "three/build/three.module.js"))};\nwindow.THREE = THREE;\n`);
  const built = await Bun.build({ entrypoints: [entry], format: "iife", minify: true, target: "browser" });
  if (!built.success) throw new AggregateError(built.logs, "three.js didn't bundle");
  const version = (await Bun.file(join(modules, "three/package.json")).json()).version as string;
  writeFileSync(join(out, "three.min.js"), `/* three.js ${version}, https://threejs.org, Copyright 2010-2026 three.js authors, MIT License */\n${await built.outputs[0]!.text()}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`motion graphics' libraries in ${out}`);
