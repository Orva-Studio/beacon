import { useEffect, useRef, type CSSProperties } from "react";
import { PLAIN_TEXT } from "./controls/buttons";

/**
 * Names a section (Intro, Demo…). Enter saves, Esc leaves it as it was; a press outside saves what was typed. An empty
 * name removes the section, or doesn't make a new one.
 */
export function SectionNamer({ value, style, onDone }: { value: { name: string }; style: CSSProperties; onDone: (name: string | null) => void }) {
  const name = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  const save = () => {
    const t = (name.current?.value ?? "").trim();
    finish(t === value.name ? null : t);
  };
  useEffect(() => {
    requestAnimationFrame(() => (name.current?.focus(), name.current?.select()));
    // A press anywhere else saves. Not on blur: the app blurs fields on any press.
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && save();
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") finish(null);
  };
  return (
    <div ref={box} className="absolute z-20 flex w-60 flex-col gap-2 rounded-lg border border-divider bg-panel p-2 shadow-2xl" style={style} onPointerDown={(e) => e.stopPropagation()} data-section-namer>
      <input
        {...PLAIN_TEXT}
        ref={name}
        defaultValue={value.name}
        placeholder="Name (Intro, Demo…)"
        className="rounded-sm border border-divider bg-well px-2 py-1 text-body text-text-strong outline-none focus:border-accent"
        onKeyDown={keys}
        data-section-name
      />
    </div>
  );
}
