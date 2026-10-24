import { z } from "zod";
import type { Preferences } from "@beacon/model";

/**
 * How B-roll footage looks: wording added to every prompt a clip's footage is made from (and given to the planner
 * as its style guide). Built in (the user's picks, 2026-10-24), or the user's own: typed in Settings › AI, or a
 * text file imported there (a `.md` skill, a `.txt`).
 */
export interface Style {
  id: string;
  name: string;
  /** Its menu section. */
  group: string;
  text: string;
}

export const NONE = "none";

export const BUILT_IN: Style[] = [
  { id: NONE, name: "None", group: "", text: "" },
  { id: "documentary", name: "Documentary", group: "Film looks", text: "Documentary footage: natural light, handheld camera, real places and textures, observational framing." },
  { id: "vintage-film", name: "Vintage film", group: "Film looks", text: "Shot on vintage 16mm film: warm faded colours, visible grain, soft halation, gentle gate weave." },
  { id: "black-and-white", name: "Black and white", group: "Film looks", text: "Black and white: rich contrast, deep blacks, fine grain, classic cinematic lighting." },
  { id: "timelapse", name: "Timelapse", group: "Film looks", text: "Timelapse: hours compressed into seconds, steady locked-off camera, moving clouds, light and crowds." },
  { id: "tech-abstract", name: "Tech abstract", group: "Product and tech", text: "Abstract technology visuals: glowing data streams, networks of light, particles and soft gradients on a dark background; no screens, no readable text." },
  { id: "studio-product", name: "Studio product shot", group: "Product and tech", text: "Studio product shot: one object on a clean seamless background, soft key light, slow turntable or slider move, shallow depth of field." },
  { id: "macro", name: "Macro close-up", group: "Product and tech", text: "Macro close-up: extreme detail, very shallow depth of field, slow gentle camera drift, crisp textures." },
];

export const CustomStyleSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1).max(80), text: z.string().min(1).max(20_000) });
export const CustomStylesSchema = z.array(CustomStyleSchema).max(200);
export type CustomStyle = z.infer<typeof CustomStyleSchema>;

export const STYLES_PREF = "brollStyles";

/** The user's own styles, as Settings › AI keeps them (unreadable: none). */
export function customStyles(pref: Preferences): CustomStyle[] {
  try {
    return CustomStylesSchema.parse(JSON.parse(pref(STYLES_PREF) || "[]"));
  } catch {
    return [];
  }
}

/** Every style a clip can pick: the built-ins, then the user's own under "Your styles". */
export const allStyles = (pref: Preferences): Style[] => [...BUILT_IN, ...customStyles(pref).map((s) => ({ ...s, group: "Your styles" }))];

/** A style by id; one deleted since a clip picked it reads as None. */
export const styleOf = (id: string, pref: Preferences): Style => allStyles(pref).find((s) => s.id === id) ?? BUILT_IN[0]!;

/** How much of a style a video prompt carries: a long skill is the planner's guide, but a model reads a few lines. */
export const PROMPT_STYLE_CHARS = 400;

/**
 * A style read from a text file: a skill's `name` (its front matter) or first heading, else the file's name; its
 * body without the front matter.
 */
export function styleFromFile(fileName: string, content: string): { name: string; text: string } {
  const front = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = (front ? content.slice(front[0].length) : content).trim();
  const named = front?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { name: (named || heading || fileName.replace(/\.[^.]+$/, "")).slice(0, 80), text: body.slice(0, 20_000) };
}
