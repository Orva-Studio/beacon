/**
 * The pictures on the tool panels' tiles (effects, annotations, audio effects), in one style.
 *
 *   bun scripts/effect-art.ts generate [id...]   draw them with OpenAI (OPENAI_API_KEY), every one or those named
 *   bun scripts/effect-art.ts css                inline packages/ui/src/art/*.webp into art.css
 *
 * `generate` keeps the full-size PNG beside the build (`--keep <dir>`) and writes a 384×256 WebP per tile;
 * `css` then gives each tile's picture a class, `art-<id>`, inlined as the fonts are so the view needs no files.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ART = join(import.meta.dir, "../packages/ui/src/art");

const STYLE =
  "Style: clean semi-flat illustration with minimal depth: flat dark charcoal and slate shapes with subtle soft gradients, crisp edges, " +
  "thin mint-green (#3ee68d) accent lines with a gentle glow, near-black background (#141615). No glossy reflections, no metal, no bevels, " +
  "no 3D product shot: a modern app illustration, depth only from soft flat shadows. Centered, generous margins, reads clearly at small thumbnail size.";

/** Every picture but Text's: words would be noise at tile size. */
const NO_TEXT = "No text, no letters, no logos, no watermark.";

/** What each tile shows, by its id: an annotation preset, an effect type, or an audio effect. */
const SUBJECTS: Record<string, string> = {
  text: 'The word "Text" in a bold, clean geometric sans-serif, white, with a short mint-green underline, on a flat dark screen panel. Only that one word, spelled exactly "Text". No other text, no logos, no watermark.',
  rectangle: `A plain flat dark screen panel with one solid rounded rectangle in its centre, filled flat mid-grey with a thin mint-green outline. Nothing else: no picture, no landscape. ${NO_TEXT}`,
  spotlight: `A flat screen panel showing a simple landscape, covered by a heavy dark overlay so it is almost black, except one rounded rectangle in the middle cut out of the overlay where the landscape shows bright and clear, its edge outlined in mint-green: a clear spotlight on one area. ${NO_TEXT}`,
  blur: `A flat screen panel showing a simple landscape with crisp detail, except one rounded rectangular patch in the middle that is heavily blurred like frosted glass, outlined in thin mint-green. ${NO_TEXT}`,
  pixelate: `A flat screen panel showing a simple landscape with crisp detail, except one rounded rectangular patch in the middle broken into large square mosaic pixels, outlined in thin mint-green. ${NO_TEXT}`,
  "round-corners": `A flat rectangular video frame showing a simple landscape, its corners dramatically rounded, the curved corners traced by thin mint-green arcs. ${NO_TEXT}`,
  "crt-monitor": `A flat video frame showing a simple landscape with a retro CRT screen effect applied to it: bold horizontal scanlines across the whole picture, edges bulging with barrel curvature, red and cyan colour fringing at the edges, a soft glow and vignette. Just the frame with the effect, no television set or monitor casing. ${NO_TEXT}`,
  "drop-shadow": `A flat rectangular video frame showing a simple landscape, floating above a flat surface and casting a soft, offset drop shadow down and to the right. The shadow is the clear focus. ${NO_TEXT}`,
  "motion-blur": `A flat rectangular video frame showing a simple landscape, moving fast from left to right, smeared by strong horizontal motion-blur streaks trailing behind it. ${NO_TEXT}`,
  "fade-in": `A mint-green audio waveform running left to right across a flat dark panel, starting flat and silent at the left and growing smoothly to full loudness at the right. ${NO_TEXT}`,
  "fade-out": `A mint-green audio waveform running left to right across a flat dark panel, at full loudness at the left and shrinking smoothly to flat silence at the right. ${NO_TEXT}`,
};

async function draw(id: string, keep: string) {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: `${SUBJECTS[id]} ${STYLE}`, size: "1536x1024", quality: "medium", n: 1 }),
  });
  const j = (await r.json()) as { data?: { b64_json: string }[]; error?: { message: string } };
  if (!j.data) throw new Error(`${id}: ${j.error?.message ?? r.status}`);
  const png = join(keep, `${id}.png`);
  await Bun.write(png, Buffer.from(j.data[0]!.b64_json, "base64"));
  const ff = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", png, "-vf", "scale=384:256", "-c:v", "libwebp", "-quality", "82", join(ART, `${id}.webp`)]);
  if (ff.exitCode !== 0) throw new Error(`${id}: ffmpeg failed: ${ff.stderr}`);
  console.log(`drew ${id}`);
}

function css() {
  const files = readdirSync(ART).filter((f) => f.endsWith(".webp")).sort();
  const rules = files.map((f) => `.art-${basename(f, ".webp")} {\n  background-image: url("data:image/webp;base64,${readFileSync(join(ART, f)).toString("base64")}");\n}`);
  writeFileSync(join(ART, "art.css"), `/* Generated by scripts/effect-art.ts from the .webp files beside it. */\n${rules.join("\n")}\n`);
  console.log(`art.css: ${files.length} pictures`);
}

const [mode, ...rest] = Bun.argv.slice(2);
if (mode === "generate") {
  const k = rest.indexOf("--keep");
  const keep = k >= 0 ? rest.splice(k, 2)[1]! : mkdtempSync(join(tmpdir(), "beacon-art-"));
  const ids = rest.length ? rest : Object.keys(SUBJECTS);
  const unknown = ids.filter((id) => !SUBJECTS[id]);
  if (unknown.length) throw new Error(`no subject for ${unknown.join(", ")}`);
  await Promise.all(ids.map((id) => draw(id, keep)));
  console.log(`full-size PNGs in ${keep}`);
  css();
} else if (mode === "css") css();
else console.log("usage: bun scripts/effect-art.ts generate [id...] [--keep dir] | css");
