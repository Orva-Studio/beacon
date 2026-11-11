import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SECTION_NAMES, type Project } from "@beacon/model";
import { PLAIN_TEXT } from "./controls/buttons";

/** The names offered: this project's own first (as the video's other parts were named), then Beacon's. A long one is an
 * old comment typed as a name, so it isn't offered. */
export function sectionNames(project: Project): string[] {
  return [...new Set([...project.sections.map((s) => s.name).filter((n) => n && n.split(/\s+/).length <= 3), ...SECTION_NAMES])];
}

export type SectionText = { name: string; comment: string; clearReply?: boolean };

/**
 * Names a section and says what should change there (a comment, for an agent). Enter or a picked name saves, ⇧Enter
 * starts a new line in the comment, Esc leaves it as it was; a press outside saves what was typed (a long comment
 * shouldn't be lost to a stray click). The agent's reply, once it has done the comment, shows under it to clear.
 */
export function SectionNamer({ project, value, style, onDone }: { project: Project; value: { name: string; comment?: string; reply?: string }; style: CSSProperties; onDone: (text: SectionText | null) => void }) {
  const name = useRef<HTMLInputElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const [reply, setReply] = useState(value.reply);
  const cleared = useRef(false);
  const finish = (text: SectionText | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  const typed = (picked?: string): SectionText => ({
    name: (picked ?? name.current?.value ?? "").trim(),
    comment: (comment.current?.value ?? "").trim(),
    ...(cleared.current ? { clearReply: true } : {}),
  });
  const save = (picked?: string) => {
    const t = typed(picked);
    const same = t.name === value.name && t.comment === (value.comment ?? "") && !t.clearReply;
    finish(same ? null : t);
  };
  const grow = () => {
    const el = comment.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(() => {
    grow();
    const first = value.comment ? comment.current : name.current;
    requestAnimationFrame(() => (first?.focus(), first?.select()));
    // A press anywhere else saves. Not on blur: the app blurs fields on any press, a name picked too.
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && save();
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") finish(null);
  };
  const field = "rounded-sm border border-divider bg-well px-2 py-1 text-body text-text-strong outline-none focus:border-accent";
  return (
    <div
      ref={box}
      className="absolute z-20 flex w-72 flex-col gap-2 rounded-lg border border-divider bg-panel p-2 shadow-2xl"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      data-section-namer
    >
      <input {...PLAIN_TEXT} ref={name} defaultValue={value.name} placeholder="Name (Intro, Demo…)" className={field} onKeyDown={keys} data-section-name />
      <textarea
        {...PLAIN_TEXT}
        ref={comment}
        defaultValue={value.comment ?? ""}
        rows={2}
        placeholder="Comment: what should change here"
        className={`${field} resize-none leading-snug`}
        onInput={grow}
        onKeyDown={keys}
        data-section-comment
      />
      {reply && (
        <div className="flex items-start gap-2 rounded-sm bg-chip px-2 py-1 text-label text-text-muted" data-section-reply>
          <span className="flex-1">
            <span className="text-accent">Done: </span>
            {reply}
          </span>
          <button className="text-text-muted hover:text-text-strong" onClick={() => ((cleared.current = true), setReply(undefined))} data-section-reply-clear>
            Clear
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {sectionNames(project).map((n) => (
          <button key={n} className="rounded-sm bg-chip px-1.5 py-0.5 text-label text-text-muted hover:bg-item-hover hover:text-text-strong" onClick={() => save(n)} data-section-pick={n}>
            {n}
          </button>
        ))}
      </div>
      <div className="text-label text-text-muted">Enter saves · ⇧Enter new line · Esc cancels</div>
    </div>
  );
}
