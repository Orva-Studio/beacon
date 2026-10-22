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
  "Style: clean semi-flat illustration with minimal depth: flat shapes with subtle soft gradients and crisp edges on a deep charcoal " +
  "background (#141615), lit by the picture's own vivid accent colour with a gentle glow. No glossy reflections, no metal, no bevels, " +
  "no 3D product shot: a modern, colourful creator-app illustration, depth only from soft flat shadows. Centered, generous margins, " +
  "reads clearly at small thumbnail size.";

/** Every picture but Text's: words would be noise at tile size. */
const NO_TEXT = "No text, no letters, no logos, no watermark.";

/** A simple flat landscape, in colour, for the pictures that show an effect on a video frame. */
const SCENE = "a simple flat landscape at sunset (purple and pink sky, orange sun, teal mountains, a lake)";

/** What each tile shows, by its id (an annotation preset, an effect type, or an audio effect), each with its own accent colour. */
const SUBJECTS: Record<string, string> = {
  text: 'The word "Text" in a bold, clean geometric sans-serif, white, with a short electric-violet (#8b5cf6) underline and a soft violet glow, on a flat dark screen panel. Only that one word, spelled exactly "Text". No other text, no logos, no watermark.',
  rectangle: `A plain flat dark screen panel with one solid rounded rectangle in its centre, filled flat coral (#ff7a59). Nothing else: no picture, no landscape. ${NO_TEXT}`,
  spotlight: `A flat screen panel showing ${SCENE}, covered by a heavy dark overlay so it is almost black, except one rounded rectangle in the middle cut out of the overlay where the scene shows bright and vivid, ringed by a warm amber (#ffb020) glow: a clear spotlight on one area. ${NO_TEXT}`,
  blur: `A flat screen panel showing ${SCENE} with crisp detail, except one rounded rectangular patch in the middle heavily blurred like frosted glass, outlined in thin sky blue (#38bdf8). ${NO_TEXT}`,
  pixelate: `A flat screen panel showing ${SCENE} with crisp detail, except one rounded rectangular patch in the middle broken into large square mosaic pixels, outlined in thin magenta (#e44dd8). ${NO_TEXT}`,
  "round-corners": `A flat rectangular video frame showing ${SCENE}, its corners dramatically rounded, the curved corners traced by glowing teal (#2dd4bf) arcs. ${NO_TEXT}`,
  "crt-monitor": `A flat video frame showing ${SCENE} with a retro CRT screen effect applied to it: bold horizontal scanlines across the whole picture, edges bulging with barrel curvature, red and cyan colour fringing at the edges, a soft phosphor glow and vignette. Just the frame with the effect, no television set or monitor casing. ${NO_TEXT}`,
  "drop-shadow": `A flat rectangular video frame showing ${SCENE}, floating above a flat surface and casting a soft, deep indigo (#4f46e5) drop shadow offset down and to the right. The shadow is the clear focus. ${NO_TEXT}`,
  "motion-blur": `A flat rectangular video frame showing ${SCENE}, moving fast from left to right: the whole frame is smeared horizontally by strong motion blur, with bright orange (#ff8a1f) speed streaks trailing far behind it. ${NO_TEXT}`,
  // The fades keep Beacon's mint: the user preferred it for them.
  "fade-in": `A mint-green (#3ee68d) audio waveform running left to right across a flat dark panel, starting flat and silent at the left and growing smoothly to full loudness at the right. ${NO_TEXT}`,
  "fade-out": `A mint-green (#3ee68d) audio waveform running left to right across a flat dark panel, at full loudness at the left and shrinking smoothly to flat silence at the right. ${NO_TEXT}`,
  "remove-silences": `A flat dark panel with an audio waveform in vivid cyan (#22d3ee) running left to right in three loud bursts of speech, the two flat silent gaps between them cut out and the bursts sliding together, each removed gap marked by a thin dashed cyan cut line and a small sparkle. ${NO_TEXT}`,
  "remove-fillers": `A flat dark panel with a row of rounded speech-bubble shapes in vivid coral pink (#fb7185), two small wobbly bubbles among them (the hesitations) lifting out of the row and fading, the bubbles either side sliding together to close the gap, a thin dashed coral cut line and a small sparkle where each one left. ${NO_TEXT}`,
  "film-look": `A flat panel showing ${SCENE} as a frame of film: warm amber tones, a soft red-orange glow blooming around the bright sun (halation), fine film grain over the picture, gently faded blacks and a soft dark vignette at the corners, a thin strip of film sprocket holes along the top and bottom edges in warm amber (#f59e0b). ${NO_TEXT}`,
  "remove-retakes": `A flat dark panel with three stacked horizontal rows of rounded speech-bubble shapes in vivid amber (#fbbf24), the same line said three times: the top two rows dimmed and short, each ending early in a thin dashed amber cut line, the bottom row complete, bright and glowing with a small sparkle, as the take that is kept. ${NO_TEXT}`,
  "noise-removal": `A flat dark panel with an audio waveform in vivid violet (#a78bfa) running left to right: at the left it is buried in a grainy haze of fine static speckles, and through the middle a soft glowing sweep clears the haze so at the right the waveform stands clean and sharp on the dark background. ${NO_TEXT}`,
  lut: `A flat panel showing ${SCENE} split down the middle: the left half flat and washed out, the right half graded with rich teal shadows and warm orange highlights, and floating in front of the split a small glowing cube made of a 3D grid of tiny colour dots shading from teal to orange, outlined in vivid teal (#2dd4bf). ${NO_TEXT}`,
  "remove-background": `A flat dark panel with a presenter's head-and-shoulders silhouette in soft warm tones, cut out cleanly: on its left half the room behind them (a plain wall and a lamp) still shows, and on its right half that background has been lifted away to a checkerboard of transparency, a glowing vivid sky-blue (#38bdf8) outline tracing the person's edge where the cut runs, with a small sparkle. ${NO_TEXT}`,
  "clip-speed": `A flat rectangular video frame showing ${SCENE}, with a bold speedometer dial in front of it, its needle swung far to the right and its arc glowing vivid lime (#a3e635), two chevron fast-forward arrows beside it in the same lime. ${NO_TEXT}`,
  captions: `A flat dark video frame with a softly lit presenter silhouette, and across its lower third a rounded dark caption bar holding three short pill-shaped word blocks in white, the middle one glowing vivid yellow (#facc15) as the word being spoken, a small sound-wave glyph beside the bar. ${NO_TEXT}`,
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
