import { ticksToSeconds } from "@beacon/model";
import { useEffect, useRef, type CSSProperties } from "react";
import { copiedIds } from "./clip-ids";
import { PLAIN_TEXT } from "./controls/buttons";
import { replica } from "./store";

/** Add Comment (⇧M, the menu bar): the editor for a new comment at the playhead, on the main timeline. */
export function newComment() {
  const session = replica.get().session;
  if (!session) return;
  if (session.group) return replica.status("Close the group (⌃⇧U) to add a comment");
  replica.editComment({ start: session.playhead });
}

/**
 * Comment on Clip (the clip menu): a new comment over the clicked clip, or the selection it is in, from the first's
 * start to the last's end, its text starting with their ids so an agent knows which clips it means.
 */
export function clipComment(clip: string) {
  const { session, project } = replica.get();
  if (!session || !project) return;
  if (session.group) return replica.status("Close the group (⌃⇧U) to add a comment");
  const ids = copiedIds(session.selection, clip).split(", ");
  const on = project.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id));
  if (!on.length) return;
  const start = Math.min(...on.map((c) => c.start));
  const end = Math.max(...on.map((c) => c.start + c.duration));
  replica.editComment({ start: ticksToSeconds(start), end: ticksToSeconds(end), text: `[${on.map((c) => c.id).join(", ")}] ` });
}

/**
 * Writes a comment: what should change there, for an agent, or a note. Enter saves, ⇧Enter starts a new line, Esc
 * leaves it as it was; a press outside saves what was typed (a long comment shouldn't be lost to a stray click).
 */
/** `opening`: text a new comment starts with, saved even if nothing is typed after it. */
export function CommentEditor({ value, opening, where, style, onDone }: { value: string; opening?: string; where: string; style: CSSProperties; onDone: (text: string | null) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  const save = () => {
    const t = (field.current?.value ?? "").trim();
    finish(t === value ? null : t);
  };
  const grow = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(() => {
    grow();
    // Opening words stay, the caret after them; otherwise all of it selected, to type over.
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      if (opening) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    });
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && save();
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") finish(null);
  };
  return (
    <div
      ref={box}
      className="absolute z-20 flex w-72 flex-col gap-2 overflow-y-auto rounded-lg border border-divider bg-panel p-2 shadow-2xl"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      data-comment-editor
    >
      <div className="text-label text-text-muted">Comment {where}</div>
      <textarea
        {...PLAIN_TEXT}
        ref={field}
        defaultValue={opening ?? value}
        rows={2}
        placeholder="What should change here"
        className="resize-none rounded-sm border border-divider bg-well px-2 py-1 text-body leading-snug text-text-strong outline-none focus:border-accent"
        onInput={grow}
        onKeyDown={keys}
        data-comment-text
      />
      <div className="-mt-1 text-label text-text-muted">Enter saves · ⇧Enter new line · Esc cancels</div>
    </div>
  );
}
