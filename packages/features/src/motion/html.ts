import type { RGBA } from "@beacon/model";
import type { Piece } from "./blocks";
import type { Look } from "./looks";

/** Behind a graphic in its box: nothing, the whole box filled, or a rounded card; in any colour and opacity. */
export interface Backdrop {
  kind: "none" | "full" | "card";
  color: RGBA;
}

export type Timing = "speech" | "together";

export interface PageEnv {
  width: number;
  height: number;
  /** Seconds the clip lasts. */
  length: number;
  look: Look;
  /** The Text annotation's font: a Look's when it names none. */
  fallbackFont: string;
  backdrop: Backdrop;
  timing: Timing;
}

const css = (c: RGBA, alpha = c[3]) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${+alpha.toFixed(3)})`;
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
Write only the inside of <body>: HTML and one <style> block. No scripts, no external files, fonts or images (they are blocked).
Use the Look's variables, never your own fonts or colours: var(--heading) and var(--body) fonts, var(--text), var(--accent), var(--card) colours, var(--shadow) as a text-shadow or box-shadow.
Classes Beacon animates for you:
- span.w: one word that comes in when it is said: data-t="<seconds from the clip's start>" (from the word times given). Wrap every shown word that is said in one.
- .in: any element that comes in at data-t="<seconds>" (a bar, a card, an icon, a line not said aloud).
- .count: a number counting from data-from to data-to over data-for seconds from data-t (data-decimals, data-prefix, data-suffix); leave it empty.
Everything fades out at the clip's end by itself. You may add your own @keyframes (they are seeked frame by frame), but no transitions.
Lay out with flexbox or absolute positions in px within the box; keep text large enough to read on a phone, and inside the box with a margin.`;

/** The whole page a composition is drawn in: the Look as CSS variables, the backdrop, Beacon's classes and its seekable runtime. */
export function page(body: string, env: PageEnv): string {
  const { look } = env;
  const k = env.height / 1080;
  const s = look.shadow;
  const shadow = s ? `${(Math.cos(s.angle) * s.offset * k).toFixed(1)}px ${(-Math.sin(s.angle) * s.offset * k).toFixed(1)}px ${(s.blur * k).toFixed(1)}px ${css(s.color, s.opacity)}` : "none";
  const inset = Math.min(env.width, env.height) * 0.05;
  const backdrop =
    env.backdrop.kind === "none"
      ? ""
      : `#beacon-backdrop { position: absolute; ${env.backdrop.kind === "card" ? `inset: ${inset}px; border-radius: ${inset * 0.6}px;` : "inset: 0;"} background: ${css(env.backdrop.color)}; animation: fade 0.3s ease-out both; }`;
  const d = (0.6 / look.speed).toFixed(3);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-beacon'; img-src data:; font-src data:">
<style>
:root { --heading: ${font(look.heading.font, env.fallbackFont)}; --body: ${font(look.body.font, env.fallbackFont)}; --heading-weight: ${look.heading.weight}; --body-weight: ${look.body.weight}; --text: ${css(look.text)}; --accent: ${css(look.accent)}; --card: ${css(look.card)}; --shadow: ${shadow}; --come: ${d}s; --ease: ${EASE[look.easing]}; }
html, body { margin: 0; width: ${Math.round(env.width)}px; height: ${Math.round(env.height)}px; overflow: hidden; background: transparent; }
body { position: relative; font-family: var(--body); font-weight: var(--body-weight); color: var(--text); -webkit-font-smoothing: antialiased; }
#beacon-stage { position: absolute; inset: 0; animation: out 0.35s ease-in both; animation-delay: ${Math.max(0, env.length - 0.35).toFixed(3)}s; }
${backdrop}
.w, .in { display: inline-block; animation: come var(--come) var(--ease) both; }
${keyframes(look)}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes out { from { opacity: 1; } to { opacity: 0; } }
</style></head>
<body><div id="beacon-stage">${backdrop ? '<div id="beacon-backdrop"></div>' : ""}
${body}
</div>
<script nonce="beacon">
(() => {
  const together = ${env.timing === "together"};
  const words = [...document.querySelectorAll(".w")];
  words.forEach((w, i) => { w.style.animationDelay = (together ? i * 0.06 : Number(w.dataset.t) || 0) + "s"; });
  for (const el of document.querySelectorAll(".in")) el.style.animationDelay = (Number(el.dataset.t) || 0) + "s";
  const counts = [...document.querySelectorAll(".count")];
  const fmt = (el, v) => {
    const d = Number(el.dataset.decimals) || 0;
    return (el.dataset.prefix || "") + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + (el.dataset.suffix || "");
  };
  window.__seek = (t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
    for (const el of counts) {
      const [from, to, at, span] = [Number(el.dataset.from) || 0, Number(el.dataset.to) || 0, Number(el.dataset.t) || 0, Number(el.dataset.for) || 1.2];
      const k = Math.min(1, Math.max(0, (t - at) / span));
      el.textContent = fmt(el, from + (to - from) * (1 - Math.pow(1 - k, 3)));
    }
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
