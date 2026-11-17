import { z } from "zod";
import { defineCommand, snapSeconds, ticksToSeconds, IdSchema as Id, SecondsSchema as Seconds, SECTION_COLORS, type Project, type Section, type Ticks } from "@beacon/model";

const Color = z.enum(SECTION_COLORS);

/** Seconds, to two places, for messages. */
const at = (t: Ticks) => `${ticksToSeconds(t).toFixed(2)} s`;

function place(doc: Project, section: Section, others: Section[]) {
  if (section.end <= section.start) throw new Error("a section ends after it starts");
  if (section.start < 0) throw new Error("a section starts at 0 s or later");
  const hit = others.find((o) => o.start < section.end && section.start < o.end);
  if (hit) throw new Error(`sections can't overlap: "${hit.name}" is ${at(hit.start)}–${at(hit.end)}`);
  doc.sections = [...others, section].sort((a, b) => a.start - b.start);
}

function find(doc: Project, id: string): Section {
  const s = doc.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section "${id}"; project_describe lists them`);
  return s;
}

export const sectionCommands = [
  defineCommand({
    id: "section.add",
    description:
      "Name a part of the video (Intro, Explanation, Demo, Outro…): a section of the main timeline from `start` to `end` (seconds), optionally with a `color` (else its name picks one). Sections can't overlap; gaps are fine. What the user wants changed is a comment (comment_add), not a section. Returns its id",
    args: z.strictObject({ start: Seconds, end: Seconds, name: z.string().trim().min(1, "a section needs a name"), color: Color.optional() }),
    apply(doc, { start, end, name, color }, ctx) {
      const id = ctx.newId("section");
      place(doc, { id, start: snapSeconds(start, doc.settings.fps), end: snapSeconds(end, doc.settings.fps), name, ...(color ? { color } : {}) }, doc.sections);
      return id;
    },
  }),
  defineCommand({
    id: "section.set",
    description:
      "Rename a section, change its `color` (null: back to the colour its name picks), or move its start or end (seconds); it still can't overlap another",
    args: z.strictObject({
      section: Id,
      name: z.string().trim().min(1, "a section needs a name").optional(),
      color: Color.nullable().optional(),
      start: Seconds.optional(),
      end: Seconds.optional(),
    }),
    apply(doc, { section, name, color, start, end }) {
      const s = find(doc, section);
      const fps = doc.settings.fps;
      const next: Section = { ...s, ...(name !== undefined ? { name } : {}), ...(start !== undefined ? { start: snapSeconds(start, fps) } : {}), ...(end !== undefined ? { end: snapSeconds(end, fps) } : {}) };
      if (color === null) delete next.color;
      else if (color !== undefined) next.color = color;
      place(doc, next, doc.sections.filter((x) => x.id !== section));
    },
  }),
  defineCommand({
    id: "section.remove",
    description: "Remove a section (the clips under it stay)",
    args: z.strictObject({ section: Id }),
    apply(doc, { section }) {
      find(doc, section);
      doc.sections = doc.sections.filter((x) => x.id !== section);
    },
  }),
];

/** Sections after [a, b) is cut out of the timeline: those after move back, one across it shrinks, one inside goes. */
export function cutSections(doc: Project, a: Ticks, b: Ticks) {
  const map = (t: Ticks) => (t < a ? t : t < b ? a : t - (b - a));
  doc.sections = doc.sections.map((s) => ({ ...s, start: map(s.start), end: map(s.end) })).filter((s) => s.end > s.start);
}

/** Sections after `d` ticks of time is opened at `t`: those after move on, one across it grows. */
export function openSections(doc: Project, t: Ticks, d: Ticks) {
  for (const s of doc.sections) {
    if (s.start >= t) s.start += d;
    if (s.end > t) s.end += d;
  }
}
