import { useEffect, useRef, type CSSProperties } from "react";
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
 * Writes a comment: what should change there, for an agent, or a note. Enter saves, ⇧Enter starts a new line, Esc
 * leaves it as it was; a press outside saves what was typed (a long comment shouldn't be lost to a stray click).
 */
export function CommentEditor({ value, where, style, onDone }: { value: string; where: string; style: CSSProperties; onDone: (text: string | null) => void }) {
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
    requestAnimationFrame(() => (field.current?.focus(), field.current?.select()));
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
        defaultValue={value}
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
