import { z } from "zod";

/** Where in the box a piece goes. */
export const AREAS = ["full", "top", "middle", "bottom", "left", "right"] as const;
export type Area = (typeof AREAS)[number];

export const KINDS = ["title", "lowerThird", "number", "list", "text"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * One piece of a composition, as the AI writes it: what it is, its words, when it shows (seconds from the clip's
 * start) and where in the box. Fields a kind doesn't use are empty.
 */
export const PieceSchema = z.strictObject({
  kind: z.enum(KINDS),
  start: z.number(),
  end: z.number(),
  area: z.enum(AREAS),
  /** The title, the name (lower third), the label under a number, or the line of text. */
  text: z.string().max(120),
  /** The line under a title, or the role under a name. */
  detail: z.string().max(120),
  /** A number's value, and what goes before and after it ("$", "%"). */
  value: z.number(),
  prefix: z.string().max(8),
  suffix: z.string().max(12),
  /** A list's items. */
  items: z.array(z.string().max(80)).max(6),
});
export type Piece = z.infer<typeof PieceSchema>;

/** What the kinds are, for the AI and for agents. */
export const KIND_GUIDE: Record<Kind, string> = {
  title: "a few large words coming in one after another (`text`), an optional smaller line under them (`detail`)",
  lowerThird: "a name (`text`) and a role or place (`detail`) on a bar that wipes in, low and to the left",
  number: "a number counting up to `value`, with `prefix` / `suffix` (\"$\", \"%\", \"x\") and a label under it (`text`)",
  list: "2 to 5 short `items`, each coming in after the one before, with a dot",
  text: "one line of text (`text`)",
};

/** A piece made usable: inside the clip, at least half a second long, with what its kind needs. */
export function tidy(p: Piece, length: number): Piece | undefined {
  const start = Math.min(Math.max(0, p.start), Math.max(0, length - 0.5));
  const end = Math.min(length, Math.max(start + 0.5, p.end));
  const piece = { ...p, start, end, text: p.text.trim(), detail: p.detail.trim() };
  const needs = p.kind === "list" ? piece.items.some((s) => s.trim()) : p.kind === "number" ? Number.isFinite(p.value) : !!piece.text;
  return needs && end - start >= 0.5 - 1e-6 ? piece : undefined;
}
