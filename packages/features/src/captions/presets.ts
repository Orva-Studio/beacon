import type { RGBA } from "@beacon/model";
import type { DynamicStyle, Emphasis } from "./dynamic";

export interface CaptionPreset {
  id: string;
  title: string;
  description: string;
  /** For headlines on their own track rather than the captions' line. */
  headline?: boolean;
  style: (canvas: { width: number; height: number }) => Partial<Omit<DynamicStyle, "emphasis">> & { emphasis?: Partial<Emphasis> };
}

const WHITE: RGBA = [1, 1, 1, 1];
const NONE: RGBA = [0, 0, 0, 0];
const SHADOW: RGBA = [0, 0, 0, 0.85];

/** The serif Beacon ships (packages/engine/fonts): the editorial looks' face. */
const SERIF = "Instrument Serif";
const CREAM: RGBA = [0.99, 0.94, 0.88, 1];

/**
 * Looks a caption track takes in one step; afterwards each field is the user's to change. Placed for 9:16 Reels
 * (and Shorts, TikTok): above the bottom quarter and clear of the right edge, where their buttons and caption sit.
 */
const LOOKS: CaptionPreset[] = [
  {
    id: "classic",
    title: "Classic",
    description: "A line of words in a dark box, the spoken word in yellow",
    style: () => ({}),
  },
  {
    id: "editorial-line",
    title: "Editorial Line",
    description: "A small, quiet serif line, no box",
    style: ({ height }) => ({
      font: SERIF,
      weight: 400,
      size: Math.round(height * 0.032),
      background: NONE,
      highlight: NONE,
      shadow: [0, 0, 0, 0.35],
      shadowBlur: Math.round(height * 0.006),
      anchorY: "bottom",
      offsetY: Math.round(height * 0.29),
      maxWidth: 0.62,
      emphasis: { color: WHITE, scale: 1, font: SERIF, weight: 400, italic: true },
    }),
  },
  {
    id: "karaoke",
    title: "Karaoke",
    description: "Dim words turning white as said, spoken one yellow",
    style: ({ height }) => ({ font: "Avenir Next", weight: 700, background: NONE, upcoming: [1, 1, 1, 0.45], shadow: SHADOW, shadowBlur: Math.round(8 * (height / 1080)), anchorY: "bottom", offsetY: Math.round(height * 0.28), maxWidth: 0.72 }),
  },
  {
    id: "word-pop",
    title: "Word Pop",
    description: "Big bold capitals popping in, keywords yellow",
    style: ({ height }) => {
      const k = height / 1080;
      return {
        font: "Avenir Next",
        weight: 800,
        size: Math.round(68 * k),
        uppercase: true,
        background: NONE,
        color: WHITE,
        shadow: SHADOW,
        shadowBlur: Math.round(10 * k),
        reveal: "word",
        enter: "pop",
        highlight: [0.45, 1, 0.35, 1],
        anchorY: "bottom",
        offsetY: Math.round(height * 0.3),
        maxWidth: 0.72,
        emphasis: { color: [1, 0.86, 0.15, 1], scale: 1.15, weight: 800 },
      };
    },
  },
  {
    id: "serif-accent",
    title: "Serif Accent",
    description: "A clean line building word by word, keywords in a cream italic serif",
    style: ({ height }) => {
      const k = height / 1080;
      return {
        font: "Avenir Next",
        weight: 600,
        size: Math.round(44 * k),
        background: NONE,
        highlight: NONE,
        shadow: [0, 0, 0, 0.6],
        shadowBlur: Math.round(8 * k),
        reveal: "word",
        anchorY: "bottom",
        offsetY: Math.round(height * 0.28),
        maxWidth: 0.72,
        emphasis: { color: CREAM, font: SERIF, italic: true, weight: 400, scale: 1.3 },
      };
    },
  },
  {
    id: "editorial-headline",
    title: "Editorial Headline",
    description: "Huge serif words across the top, stretched to fill",
    headline: true,
    style: ({ height }) => ({
      layout: "headline",
      font: SERIF,
      weight: 400,
      size: Math.round(height * 0.075),
      color: CREAM,
      background: NONE,
      highlight: NONE,
      shadow: [0, 0, 0, 0.25],
      shadowBlur: Math.round(height * 0.01),
      reveal: "word",
      exit: "blur",
      anchorX: "center",
      offsetX: 0,
      anchorY: "top",
      offsetY: Math.round(height * 0.14),
      maxWidth: 0.84,
      lineWords: 2,
      stretch: true,
      countUp: true,
      emphasis: { color: CREAM, scale: 1.5, font: SERIF, weight: 400, italic: false, glow: NONE, decoration: "none" },
    }),
  },
  {
    id: "headline",
    title: "Headline",
    description: "Beside the speaker: small lines around one big keyword",
    headline: true,
    style: ({ width, height }) => {
      const k = height / 1080;
      return {
        layout: "headline",
        font: "Avenir Next",
        weight: 700,
        size: Math.round(40 * k),
        background: NONE,
        highlight: NONE,
        shadow: [0, 0, 0, 0.55],
        shadowBlur: Math.round(10 * k),
        reveal: "word",
        enter: "rise",
        exit: "fade",
        anchorX: "right",
        offsetX: Math.round(width * 0.08),
        anchorY: "middle",
        offsetY: Math.round(-height * 0.14),
        maxWidth: 0.5,
        emphasis: { color: CREAM, scale: 2, weight: 800, decoration: "underline", decorationColor: CREAM },
      };
    },
  },
  {
    id: "headline-glow",
    title: "Headline Glow",
    description: "Beside the speaker: keyword in glowing yellow",
    headline: true,
    style: ({ width, height }) => {
      const k = height / 1080;
      return {
        layout: "headline",
        font: "Avenir Next",
        weight: 700,
        size: Math.round(40 * k),
        background: NONE,
        highlight: NONE,
        shadow: [0, 0, 0, 0.55],
        shadowBlur: Math.round(10 * k),
        reveal: "word",
        enter: "pop",
        exit: "fade",
        anchorX: "right",
        offsetX: Math.round(width * 0.08),
        anchorY: "middle",
        offsetY: Math.round(-height * 0.14),
        maxWidth: 0.5,
        emphasis: { color: [1, 0.9, 0.2, 1], scale: 2, weight: 800, glow: [1, 0.8, 0.1, 0.7] },
      };
    },
  },
];

/** Each look's shadow falls straight down at 0.3 of its softness, as captions' shadows did before they had a distance. */
export const PRESETS: CaptionPreset[] = LOOKS.map((p) => ({
  ...p,
  style: (canvas) => {
    const s = p.style(canvas);
    return s.shadowBlur !== undefined && s.shadowDistance === undefined ? { ...s, shadowDistance: Math.round(s.shadowBlur * 0.3) } : s;
  },
}));
