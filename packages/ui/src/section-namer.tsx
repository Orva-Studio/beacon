import { useEffect, useRef, type CSSProperties } from "react";
import { SECTION_NAMES, type Project } from "@beacon/model";
import { PLAIN_TEXT } from "./controls/buttons";

/** The names offered: this project's own first (as the video's other parts were named), then Beacon's. */
export function sectionNames(project: Project): string[] {
  return [...new Set([...project.sections.map((s) => s.name), ...SECTION_NAMES])];
}

/**
 * Names a section: type one or pick one of the names offered. Enter or a pick names it; Esc or a press outside
 * leaves it unnamed (a new section isn't made).
 */
export function SectionNamer({ project, value, style, onDone }: { project: Project; value: string; style: CSSProperties; onDone: (name: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name?.trim() || null);
  };
  useEffect(() => {
    requestAnimationFrame(() => (input.current?.focus(), input.current?.select()));
    // A press anywhere else leaves it unnamed. Not on blur: the app blurs fields on any press, a name picked too.
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && finish(null);
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  return (
    <div
      ref={box}
      className="absolute z-20 flex w-64 flex-col gap-2 rounded-lg border border-divider bg-panel p-2 shadow-2xl"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      data-section-namer
    >
      <input
        {...PLAIN_TEXT}
        ref={input}
        defaultValue={value}
        placeholder="Name this part (Intro, Demo…)"
        className="rounded-sm border border-accent bg-well px-2 py-1 text-body text-text-strong outline-none"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(e.currentTarget.value);
          if (e.key === "Escape") finish(null);
        }}
        data-section-name
      />
      <div className="flex flex-wrap gap-1">
        {sectionNames(project).map((n) => (
          <button key={n} className="rounded-sm bg-chip px-1.5 py-0.5 text-label text-text-muted hover:bg-item-hover hover:text-text-strong" onClick={() => finish(n)} data-section-pick={n}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
