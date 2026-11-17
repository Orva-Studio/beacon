import { z } from "zod";
import { defineCommand, snapSeconds, IdSchema as Id, SecondsSchema as Seconds, type Comment, type Project, type Ticks } from "@beacon/model";

function find(doc: Project, id: string): Comment {
  const c = doc.comments.find((x) => x.id === id);
  if (!c) throw new Error(`no comment "${id}"; project_describe lists them`);
  return c;
}

function place(doc: Project, comment: Comment) {
  if (comment.start < 0) throw new Error("a comment starts at 0 s or later");
  if (comment.end !== undefined && comment.end <= comment.start) throw new Error("a comment ends after it starts (leave out `end` for one at a moment)");
  doc.comments = [...doc.comments.filter((c) => c.id !== comment.id), comment].sort((a, b) => a.start - b.start);
}

export const commentCommands = [
  defineCommand({
    id: "comment.add",
    description:
      "Add a comment on the main timeline: what the user wants changed there, or a note. Over a stretch from `start` to `end` (seconds), or at one moment with no `end`. Comments may overlap each other and sections. Returns its id",
    args: z.strictObject({ start: Seconds, end: Seconds.optional(), text: z.string().trim() }),
    apply(doc, { start, end, text }, ctx) {
      const fps = doc.settings.fps;
      const id = ctx.newId("comment");
      place(doc, { id, start: snapSeconds(start, fps), ...(end !== undefined ? { end: snapSeconds(end, fps) } : {}), text });
      return id;
    },
  }),
  defineCommand({
    id: "comment.set",
    description: "Change a comment's text, or move its start or end (seconds); `end: null` makes it a comment at a moment",
    args: z.strictObject({ comment: Id, text: z.string().trim().optional(), start: Seconds.optional(), end: Seconds.nullable().optional() }),
    apply(doc, { comment, text, start, end }) {
      const c = find(doc, comment);
      const fps = doc.settings.fps;
      const next: Comment = { ...c, ...(text !== undefined ? { text } : {}), ...(start !== undefined ? { start: snapSeconds(start, fps) } : {}) };
      if (end === null) delete next.end;
      else if (end !== undefined) next.end = snapSeconds(end, fps);
      place(doc, next);
    },
  }),
  defineCommand({
    id: "comment.remove",
    description: "Remove a comment. Once you have done what a comment asks, remove it: the user's list of comments is what is left to do",
    args: z.strictObject({ comment: Id }),
    apply(doc, { comment }) {
      find(doc, comment);
      doc.comments = doc.comments.filter((c) => c.id !== comment);
    },
  }),
];

/**
 * Comments after [a, b) is cut out of the timeline: those after move back, one across it shrinks, one over a stretch
 * inside it goes. One at a moment inside it goes too, or with `keepMoments`, stays at `a`.
 */
export function cutComments(doc: Project, a: Ticks, b: Ticks, keepMoments = false) {
  const map = (t: Ticks) => (t < a ? t : t < b ? a : t - (b - a));
  doc.comments = doc.comments
    .filter((c) => c.end !== undefined || keepMoments || c.start < a || c.start >= b)
    .map((c) => (c.end === undefined ? { ...c, start: map(c.start) } : { ...c, start: map(c.start), end: map(c.end) }))
    .filter((c) => c.end === undefined || c.end > c.start);
}

/** Comments after `d` ticks of time is opened at `t`: those after move on, one across it grows. */
export function openComments(doc: Project, t: Ticks, d: Ticks) {
  for (const c of doc.comments) {
    if (c.start >= t) c.start += d;
    if (c.end !== undefined && c.end > t) c.end += d;
  }
}
