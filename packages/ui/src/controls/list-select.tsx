import { type HTMLAttributes, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface ListOption {
  id: string;
  label: string;
  title?: string;
  /** A heading drawn over the first option of each run with it ("Your looks"). */
  group?: string;
}

/**
 * A choice from a list drawn by Beacon rather than the system (whose menus tell the page nothing while open), so
 * moving over an option can preview it: `onPreview` with the option under the pointer or keys, and null when the
 * pointer leaves the list or it closes without a choice. ↑↓ move, ↩ chooses, Esc closes. The button carries
 * `data-value`, and each option `data-option`.
 */
export function ListSelect({
  options,
  value,
  onChange,
  onPreview,
  title,
  ...rest
}: { options: ListOption[]; value: string; onChange: (id: string) => void; onPreview?: (id: string | null) => void; title?: string } & Omit<HTMLAttributes<HTMLButtonElement>, "onChange">) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previewing = useRef(false);
  const onPreviewNow = useRef(onPreview);
  onPreviewNow.current = onPreview;
  const shown = options.find((o) => o.id === value);

  const preview = (id: string | null) => {
    if (id === null && !previewing.current) return;
    previewing.current = id !== null;
    onPreviewNow.current?.(id);
  };
  const close = () => {
    setOpen(false);
    preview(null);
  };
  const choose = (id: string) => {
    setOpen(false);
    // The edit lands before the preview ends, so the canvas doesn't flash the old look between them.
    previewing.current = false;
    onChange(id);
  };
  const show = (i: number, scroll: boolean) => {
    setActive(i);
    preview(options[i]!.id);
    if (scroll) list.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    if (!open) return;
    setActive(options.findIndex((o) => o.id === value));
    list.current?.focus();
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // Unmounted while open (the effect removed, another clip selected): the canvas goes back to what it is.
  useEffect(() => () => preview(null), []);

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <button
        {...rest}
        type="button"
        title={title}
        data-input
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md bg-chip px-2 py-1.5 text-left outline-none focus:ring-1 focus:ring-accent"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (open || !["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{shown?.label ?? ""}</span>
        <Icon name="caret-down" size={12} className="shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          tabIndex={-1}
          className="absolute top-full left-0 z-50 mt-1 w-max min-w-full max-w-64 max-h-72 overflow-y-auto rounded-md border border-field-edge bg-tile py-1 shadow-lg outline-none"
          onMouseLeave={() => {
            setActive(options.findIndex((o) => o.id === value));
            preview(null);
          }}
          onKeyDown={(e) => {
            // The window's keys (arrows move the playhead) wait until the list is closed.
            e.stopPropagation();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              show(Math.max(0, Math.min(options.length - 1, (active < 0 ? (step > 0 ? -1 : options.length) : active) + step)), true);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (active >= 0) choose(options[active]!.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          {options.map((o, i) => [
            o.group && o.group !== options[i - 1]?.group && (
              <div key={`group-${o.group}`} className="px-2 pt-2 pb-1 text-caption font-medium text-text-faint" data-option-group>
                {o.group}
              </div>
            ),
            <div
              key={o.id}
              role="option"
              data-option={o.id}
              data-index={i}
              aria-selected={o.id === value}
              title={o.title}
              className={`cursor-default truncate px-2 py-1 ${i === active ? "bg-accent-wash text-text-strong" : o.id === value ? "text-text-strong" : "text-text"}`}
              onMouseEnter={() => {
                if (i !== active || !previewing.current) show(i, false);
              }}
              onClick={() => choose(o.id)}
            >
              {o.label}
            </div>,
          ])}
        </div>
      )}
    </div>
  );
}
