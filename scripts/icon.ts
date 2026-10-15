#!/usr/bin/env bun
/**
 * Renders the app icon (packages/desktop/icon.svg, drawn by hand) into the icon.iconset Electrobun builds the
 * app's .icns from: every size macOS asks for, each drawn from the vector rather than scaled down.
 *
 *   bun scripts/icon.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const DESKTOP = join(import.meta.dir, "../packages/desktop");
const svg = readFileSync(join(DESKTOP, "icon.svg"), "utf8");
const out = join(DESKTOP, "icon.iconset");
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    const png = new Resvg(svg, { fitTo: { mode: "width", value: size * scale } }).render().asPng();
    writeFileSync(join(out, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), png);
  }
console.log(`icon set in ${out}`);
