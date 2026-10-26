import type { Easing, RGBA } from "@beacon/model";

/** How a part comes in: from below, from the left, growing, or wiped in from its left edge. */
export type Entrance = "rise" | "slide" | "scale" | "wipe";

/**
 * A motion graphic's design, held to by every piece: type, colours, shadow and motion. A font left empty is the Text
 * annotation's, so graphics match text added by hand.
 */
export interface Look {
  id: string;
  name: string;
  description: string;
  heading: { font: string; weight: number };
  body: { font: string; weight: number };
  text: RGBA;
  accent: RGBA;
  /** Bars, cards and the Card background. */
  card: RGBA;
  /** A drop shadow (angle in radians, offset and blur in pixels at 1080p), or none. */
  shadow: { color: RGBA; opacity: number; blur: number; offset: number; angle: number } | null;
  entrance: Entrance;
  easing: Easing;
  /** Faster above 1. */
  speed: number;
  /** The motion blur effect's intensity on moving parts; 0 is none. */
  motionBlur: number;
}

const WHITE: RGBA = [1, 1, 1, 1];
const DOWN_RIGHT = 5.49779;

export const LOOKS: Look[] = [
  {
    id: "clean",
    name: "Clean",
    description: "The Text annotation's font, white, a green accent and a soft shadow; words rise into place",
    heading: { font: "", weight: 700 },
    body: { font: "", weight: 400 },
    text: WHITE,
    accent: [0.24, 0.86, 0.52, 1],
    card: [0.05, 0.05, 0.06, 0.78],
    shadow: { color: [0, 0, 0, 1], opacity: 0.4, blur: 10, offset: 6, angle: DOWN_RIGHT },
    entrance: "rise",
    easing: "backOut",
    speed: 1,
    motionBlur: 0,
  },
  {
    id: "bold",
    name: "Bold",
    description: "Heavy condensed capitals in yellow and white, a hard shadow; pieces punch in with motion blur",
    heading: { font: "DIN Condensed", weight: 700 },
    body: { font: "Avenir Next", weight: 700 },
    text: WHITE,
    accent: [1, 0.82, 0.1, 1],
    card: [0.08, 0.08, 0.08, 0.92],
    shadow: { color: [0, 0, 0, 1], opacity: 0.85, blur: 2, offset: 8, angle: DOWN_RIGHT },
    entrance: "scale",
    easing: "backOut",
    speed: 1.3,
    motionBlur: 1,
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "A serif heading over a light sans, warm white on a cream card; slow and calm",
    heading: { font: "Didot", weight: 700 },
    body: { font: "Avenir Next", weight: 400 },
    text: [0.98, 0.96, 0.92, 1],
    accent: [0.86, 0.62, 0.38, 1],
    card: [0.16, 0.13, 0.11, 0.82],
    shadow: { color: [0, 0, 0, 1], opacity: 0.3, blur: 18, offset: 4, angle: DOWN_RIGHT },
    entrance: "rise",
    easing: "easeOut",
    speed: 0.75,
    motionBlur: 0,
  },
  {
    id: "tech",
    name: "Tech",
    description: "Monospaced type, a cyan accent and glow on a dark card; pieces slide in with motion blur",
    heading: { font: "Menlo", weight: 700 },
    body: { font: "Menlo", weight: 400 },
    text: [0.9, 0.98, 1, 1],
    accent: [0.2, 0.85, 1, 1],
    card: [0.03, 0.06, 0.09, 0.88],
    shadow: { color: [0.2, 0.85, 1, 1], opacity: 0.55, blur: 16, offset: 0, angle: DOWN_RIGHT },
    entrance: "slide",
    easing: "easeOut",
    speed: 1.15,
    motionBlur: 0.8,
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Helvetica Neue in white, no shadow, wiped in plainly",
    heading: { font: "Helvetica Neue", weight: 500 },
    body: { font: "Helvetica Neue", weight: 400 },
    text: WHITE,
    accent: WHITE,
    card: [0, 0, 0, 0.6],
    shadow: null,
    entrance: "wipe",
    easing: "easeInOut",
    speed: 1,
    motionBlur: 0,
  },
];

export const DEFAULT_LOOK = "clean";

export function lookOf(id: string): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0]!;
}
