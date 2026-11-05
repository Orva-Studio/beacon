/** What comes onto the picture with a sound: a motion graphic or B-roll (a whoosh), or a picture, a screenshot or logo (a pop). */
export type PopKind = "motion" | "picture";

/** What Pop-ins searches for first, by kind. */
export const POP_TERMS: Record<PopKind, string> = { motion: "whoosh", picture: "pop" };
