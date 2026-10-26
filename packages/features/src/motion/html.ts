import type { RGBA } from "@beacon/model";
import type { Piece } from "./blocks";
import type { Look } from "./looks";
import map from "./kits/map.js" with { type: "text" };
import countries from "./vendor/countries-50m.json" with { type: "text" };
import gsap from "./vendor/gsap.min.js" with { type: "text" };
import three from "./vendor/three.min.js" with { type: "text" };
import topojson from "./vendor/topojson-client.min.js" with { type: "text" };

export type Timing = "speech" | "together";

export interface PageEnv {
  width: number;
  height: number;
  /** Seconds the clip lasts. */
  length: number;
  look: Look;
  /** The Text annotation's font: a Look's when it names none. */
  fallbackFont: string;
  timing: Timing;
}

export const css = (c: RGBA, alpha = c[3]) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${+alpha.toFixed(3)})`;
const font = (f: string, fallback: string) => `"${(f || fallback).replace(/"/g, "")}", "${fallback.replace(/"/g, "")}", "Helvetica Neue", sans-serif`;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** How a `.w` word or `.in` element comes in, per the Look's entrance. */
function keyframes(look: Look): string {
  const from = {
    rise: "transform: translateY(0.45em); opacity: 0; filter: blur(6px);",
    slide: "transform: translateX(-0.8em); opacity: 0; filter: blur(4px);",
    scale: "transform: scale(0.6); opacity: 0; filter: blur(8px);",
    wipe: "clip-path: inset(0 100% 0 0); opacity: 0.2;",
  }[look.entrance];
  return `@keyframes come { from { ${from} } to { transform: none; opacity: 1; filter: none; clip-path: inset(0 0 0 0); } }`;
}

const EASE: Record<Look["easing"], string> = {
  linear: "linear",
  easeIn: "cubic-bezier(0.55, 0, 1, 0.45)",
  easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
  easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  backOut: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};

/**
 * What a composition may use, and what Beacon draws around it: told to the AI that writes one, and kept in step with
 * `page`'s style and runtime.
 */
export const CONTRACT = `The page is exactly the box, its background transparent: the video shows wherever nothing is drawn.
Write only the inside of <body>: HTML, <style> and <script> blocks, inline SVG. Nothing loads from outside the page (no network, no external files, fonts or images): draw with CSS and SVG.
Design freely with any CSS: gradients, filters and blur, blend modes, masks, clip-path, SVG shapes and strokes. (backdrop-filter does nothing: the video isn't behind the page.)
The Look is the default design, as variables: var(--heading) and var(--body) fonts with var(--heading-weight) and var(--body-weight), var(--text), var(--accent) and var(--card) colours, var(--shadow) for a text-shadow or box-shadow. When the brief asks for other colours, fonts or styles, the brief wins: use your own.
Animate, every way seekable (Beacon seeks the page to each frame's time; there is no real time):
- CSS @keyframes animations, their animation-delay in seconds from the clip's start.
- GSAP 3 (the global gsap, core only, no plugins): tweens and timelines built when the page loads, positioned in seconds from the clip's start. Optionally register a paused timeline as window.__timelines = { main: tl }.
- window.__frame = (t) => { ... }: called with each frame's time in seconds, for anything drawn from the time: a <canvas> (2D or WebGL), particles, a shader.
No requestAnimationFrame, timers, transitions, Date.now() or Math.random(): they don't follow the seek. Randomness comes from a seeded generator (e.g. mulberry32), and a particle's position is a function of t, not of the frame before.
Libraries, used by naming them (each is there when the page uses it):
- THREE: three.js 0.186 (core, no addons) for 3D: new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }), its canvas appended to the page, and renderer.render(scene, camera) inside window.__frame(t) after setting the scene for t. Shadows, lights, materials, CanvasTexture for text on meshes.
- BeaconMap: real world geography (Natural Earth countries). const m = BeaconMap.create({ width, height, center: [lon, lat], zoom: 1, projection: "mercator" | "equirectangular" }) gives m.land, m.borders, m.country("Japan"), m.graticule(15) as SVG path data in page pixels, m.project([lon, lat]) → [x, y], and m.arc(from, to, bend) a curved route between two [lon, lat] as path data. zoom 1 fits 360° of longitude to the width; centre on the region the story is in (the Pacific for San Francisco → Tokyo: center [-170, 35]). To zoom in during the clip, scale a wrapper around the <svg> with transform-origin at the projected point and vector-effect: non-scaling-stroke on strokes. A non-scaling stroke measures stroke-dasharray and stroke-dashoffset in screen pixels, so a line drawn on with dashes inside a scaled group must multiply them by the scale (or skip non-scaling-stroke on it and divide its stroke-width instead).
Optional helpers Beacon animates in the Look's entrance:
- span.w: one word that comes in when it is said, data-t="<seconds from the clip's start>" (from the word times given). Keep a space between words; in a flex or grid row, give the row a gap.
- .in: any element that comes in at data-t="<seconds>" (a card, a bar, a line not said aloud). An .in without data-t holding .w words comes in with its first word, so a card never shows empty.
- .count: a number counting from data-from to data-to over data-for seconds from data-t (data-decimals, data-prefix, data-suffix); leave it empty.
Nothing fades in or out by itself: the graphic shows as designed from the clip's first frame to its last. Animate an entrance or exit only as the brief asks, or where the design calls for one.
Background: unless the brief asks for alpha (transparent, no background, over the video), fill the whole box with a background you choose for this graphic (a colour, a gradient, soft light) from the first frame; it covers the video. Asked for alpha, leave the page transparent so the video shows, and keep text readable over video (a card, a shadow).
Size cards and bars to their content (width: fit-content, inline-flex), not stretched across the box. Lay out in px within the box, text large enough to read on a phone and inside the box with a margin.`;

/** Libraries a composition may use, each inlined (they are large: GSAP 70 KB, three.js 750 KB, the map 760 KB) only into a page that names it. */
const KITS = [
  {
    used: /\bgsap\b/,
    // Held at 0 before the composition's scripts run, so their tweens start at the clip's start, and kept when done so a seek back finds them.
    scripts: [gsap, "gsap.globalTimeline.pause(0); gsap.globalTimeline.autoRemoveChildren = false;"],
  },
  { used: /\bTHREE\b/, scripts: [three] },
  { used: /\bBeaconMap\b/, scripts: [topojson, `const BEACON_COUNTRIES = ${countries};`, map] },
];

/** Whether a brief asks for the video to show through: else a graphic has a background of its own. */
export const wantsAlpha = (brief: string) => /\b(alpha|transparent|transparency|see-through|no background|without (a )?background|over the (video|footage|speaker|talk))\b/i.test(brief);

/** A background filling the box from the first frame: a template's when its brief doesn't ask for alpha. */
export const fill = (background: string) => `<div data-beacon-fill style="position: absolute; inset: 0; background: ${background};"></div>`;

/** The whole page a composition is drawn in: the Look as CSS variables, Beacon's helpers and its seekable runtime. */
export function page(body: string, env: PageEnv): string {
  const { look } = env;
  const k = env.height / 1080;
  const s = look.shadow;
  const shadow = s ? `${(Math.cos(s.angle) * s.offset * k).toFixed(1)}px ${(-Math.sin(s.angle) * s.offset * k).toFixed(1)}px ${(s.blur * k).toFixed(1)}px ${css(s.color, s.opacity)}` : "none";
  const d = (0.6 / look.speed).toFixed(3);
  const libraries = KITS.filter((kit) => kit.used.test(body))
    .map((kit) => kit.scripts.map((js) => `<script>${js}</script>`).join("\n"))
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">
<style>
:root { --heading: ${font(look.heading.font, env.fallbackFont)}; --body: ${font(look.body.font, env.fallbackFont)}; --heading-weight: ${look.heading.weight}; --body-weight: ${look.body.weight}; --text: ${css(look.text)}; --accent: ${css(look.accent)}; --card: ${css(look.card)}; --shadow: ${shadow}; --come: ${d}s; --ease: ${EASE[look.easing]}; }
html, body { margin: 0; width: ${Math.round(env.width)}px; height: ${Math.round(env.height)}px; overflow: hidden; background: transparent; }
body { position: relative; font-family: var(--body); font-weight: var(--body-weight); color: var(--text); -webkit-font-smoothing: antialiased; }
#beacon-stage { position: absolute; inset: 0; }
.w, .in { display: inline-block; animation: come var(--come) var(--ease) both; }
${keyframes(look)}
/* Backgrounds set before the brief picked them (motion v4) still fade in with it. */
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
</style>
${libraries}</head>
<body><div id="beacon-stage">
${body}
</div>
<script>
(() => {
  const together = ${env.timing === "together"};
  const words = [...document.querySelectorAll(".w")];
  words.forEach((w, i) => {
    w.style.animationDelay = (together ? i * 0.06 : Number(w.dataset.t) || 0) + "s";
    const next = w.nextSibling;
    // Words written back to back would run together.
    if (next && next.nodeType === 1 && next.classList.contains("w")) w.after(" ");
  });
  for (const row of new Set(words.map((w) => w.parentElement))) {
    const st = row && getComputedStyle(row);
    // A flex or grid row drops the spaces between its words.
    if (st && /flex|grid/.test(st.display) && (st.columnGap === "normal" || st.columnGap === "0px")) row.style.columnGap = "0.28em";
  }
  for (const el of document.querySelectorAll(".in")) {
    const first = el.dataset.t === undefined && el.querySelector(".w");
    const t = first ? first.style.animationDelay : (Number(el.dataset.t) || 0) + "s";
    el.style.animationDelay = t;
  }
  const counts = [...document.querySelectorAll(".count")];
  const fmt = (el, v) => {
    const d = Number(el.dataset.decimals) || 0;
    return (el.dataset.prefix || "") + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + (el.dataset.suffix || "");
  };
  window.__seek = (t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
    if (window.gsap) gsap.globalTimeline.time(t, false);
    for (const tl of Object.values(window.__timelines || {})) tl && tl.time && (tl.pause(), tl.time(t, false));
    for (const el of counts) {
      const [from, to, at, span] = [Number(el.dataset.from) || 0, Number(el.dataset.to) || 0, Number(el.dataset.t) || 0, Number(el.dataset.for) || 1.2];
      const k = Math.min(1, Math.max(0, (t - at) / span));
      el.textContent = fmt(el, from + (to - from) * (1 - Math.pow(1 - k, 3)));
    }
    if (typeof window.__frame === "function") window.__frame(t);
    return document.fonts.ready;
  };
})();
</script></body></html>`;
}

/** The words said over a piece, each wrapped to come in when it is said; text not said comes in with the first. */
function said(text: string, start: number, words: { text: string; start: number }[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  let from = 0;
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      // The next time this word is said, in order; else just after the word before.
      const k = words.findIndex((w, j) => j >= from && norm(w.text) === norm(word));
      const t = k >= 0 ? words[k]!.start : start + i * 0.08;
      if (k >= 0) from = k + 1;
      return `<span class="w" data-t="${Math.max(start, t).toFixed(2)}">${escape(word)}</span>`;
    })
    .join(" ");
}

const AREA: Record<Piece["area"], string> = {
  full: "inset: 0;",
  top: "left: 0; right: 0; top: 0; height: 33.3%;",
  middle: "left: 0; right: 0; top: 33.3%; height: 33.3%;",
  bottom: "left: 0; right: 0; bottom: 0; height: 33.3%;",
  left: "left: 0; top: 0; bottom: 0; width: 50%;",
  right: "right: 0; top: 0; bottom: 0; width: 50%;",
};

/** A piece as a composition, for when the planner (Apple's on-device model) picks a kind rather than writing HTML. */
export function template(p: Piece, words: { text: string; start: number }[], env: Pick<PageEnv, "width" | "height">): string {
  const u = Math.min(env.width / 1920, env.height / 1080);
  const area = (inner: string, place = "align-items: center; justify-content: center; text-align: center;") =>
    `<div style="position: absolute; ${AREA[p.area]} display: flex; flex-direction: column; ${place} padding: ${Math.round(60 * u)}px; box-sizing: border-box;">${inner}</div>`;
  const heading = (size: number) => `font-family: var(--heading); font-weight: var(--heading-weight); font-size: ${Math.round(size * u)}px; line-height: 1.05; text-shadow: var(--shadow);`;
  const t0 = p.start;
  switch (p.kind) {
    case "title":
      return area(
        `<div style="${heading(150)}">${said(p.text, t0, words)}</div>` +
          (p.detail ? `<div class="in" data-t="${(t0 + 0.4).toFixed(2)}" style="margin-top: ${Math.round(20 * u)}px; font-size: ${Math.round(52 * u)}px; opacity: 0.85; text-shadow: var(--shadow);">${escape(p.detail)}</div>` : ""),
      );
    case "lowerThird":
      return area(
        `<div class="in" data-t="${t0.toFixed(2)}" style="background: var(--card); border-left: ${Math.round(10 * u)}px solid var(--accent); border-radius: ${Math.round(8 * u)}px; padding: ${Math.round(26 * u)}px ${Math.round(40 * u)}px; box-shadow: var(--shadow); text-align: left;">` +
          `<div style="${heading(76)} text-shadow: none;">${said(p.text, t0, words)}</div>` +
          (p.detail ? `<div class="in" data-t="${(t0 + 0.3).toFixed(2)}" style="margin-top: ${Math.round(8 * u)}px; font-size: ${Math.round(40 * u)}px; opacity: 0.8;">${escape(p.detail)}</div>` : "") +
          `</div>`,
        `justify-content: flex-end; align-items: flex-start; padding-bottom: ${Math.round(110 * u)}px;`,
      );
    case "number": {
      const decimals = Number.isInteger(p.value) ? 0 : Math.min(2, (String(p.value).split(".")[1] ?? "").length);
      return area(
        `<div class="in count" data-t="${t0.toFixed(2)}" data-from="0" data-to="${p.value}" data-for="${Math.min(1.6, Math.max(0.4, (p.end - p.start) * 0.45)).toFixed(2)}" data-decimals="${decimals}" data-prefix="${escape(p.prefix)}" data-suffix="${escape(p.suffix)}" style="${heading(260)} color: var(--accent);"></div>` +
          (p.text ? `<div style="margin-top: ${Math.round(12 * u)}px; font-size: ${Math.round(56 * u)}px; text-shadow: var(--shadow);">${said(p.text, t0 + 0.3, words)}</div>` : ""),
      );
    }
    case "list":
      return area(
        `<div style="display: flex; flex-direction: column; gap: ${Math.round(22 * u)}px; text-align: left;">` +
          p.items
            .filter((it) => it.trim())
            .slice(0, 5)
            .map(
              (it, i) =>
                `<div style="display: flex; align-items: center; gap: ${Math.round(24 * u)}px; font-size: ${Math.round(70 * u)}px; text-shadow: var(--shadow);"><span class="in" data-t="${(t0 + i * 0.25).toFixed(2)}" style="width: ${Math.round(22 * u)}px; height: ${Math.round(22 * u)}px; border-radius: 50%; background: var(--accent);"></span><span>${said(it, t0 + i * 0.25, words)}</span></div>`,
            )
            .join("") +
          `</div>`,
      );
    case "text":
      return area(`<div style="font-size: ${Math.round(84 * u)}px; font-weight: 600; text-shadow: var(--shadow);">${said(p.text, t0, words)}</div>`);
  }
}
