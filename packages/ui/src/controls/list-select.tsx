import { type CSSProperties, type HTMLAttributes, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface ListOption {
  id: string;
  label: string;
  title?: string;
  /** A heading drawn over the first option of each run with it ("Your looks"). */
  group?: string;
  /** A picture beside the option's name (a shot's blueprint): the list then shows them large, the button small. */
  art?: string;
  /** The same as a class from art/art.css (`art-caption-classic`), for pictures inlined there. */
  artClass?: string;
  /** How the option's name is drawn, in the list and on the button (a font in its own face). */
  style?: CSSProperties;
}

/**
 * A choice from a list drawn by Beacon rather than the system (whose menus tell the page nothing while open), so
 * moving over an option can preview it: `onPreview` with the option under the pointer or keys, and null when the
 * pointer leaves the list or it closes without a choice. ↑↓ move, ↩ chooses, Esc closes. With `search` (its
 * placeholder), typing narrows the list to the names containing what's typed. The button carries `data-value`, and
 * each option `data-option`.
 */
export function ListSelect({
  options,
  value,
  onChange,
  onPreview,
  title,
  search,
  ...rest
}: { options: ListOption[]; value: string; onChange: (id: string) => void; onPreview?: (id: string | null) => void; title?: string; search?: string } & Omit<HTMLAttributes<HTMLButtonElement>, "onChange">) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const previewing = useRef(false);
  const onPreviewNow = useRef(onPreview);
  onPreviewNow.current = onPreview;
  const shown = options.find((o) => o.id === value);
  const pictures = options.some((o) => o.art || o.artClass);
  const needle = query.trim().toLowerCase();
  const listed = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

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
    preview(listed[i]!.id);
    if (scroll) list.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(options.findIndex((o) => o.id === value));
    (field.current ?? list.current)?.focus();
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
        {shown?.art && <img src={shown.art} alt="" className="h-[27px] w-12 shrink-0 rounded-sm" draggable={false} />}
        {shown?.artClass && <span className={`h-8 w-12 shrink-0 rounded-sm bg-cover bg-center ${shown.artClass}`} />}
        <span className="min-w-0 flex-1 truncate" style={shown?.style}>
          {shown?.label ?? ""}
        </span>
        <Icon name="caret-down" size={12} className="shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          className={`absolute top-full left-0 z-50 mt-1 flex w-max min-w-full flex-col ${pictures ? "max-h-[420px] max-w-72" : "max-h-72 max-w-64"} rounded-md border border-field-edge bg-tile shadow-lg`}
          onMouseLeave={() => {
            setActive(listed.findIndex((o) => o.id === value));
            preview(null);
          }}
          onKeyDown={(e) => {
            // The window's keys (arrows move the playhead) wait until the list is closed.
            e.stopPropagation();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!listed.length) return;
              const step = e.key === "ArrowDown" ? 1 : -1;
              show(Math.max(0, Math.min(listed.length - 1, (active < 0 ? (step > 0 ? -1 : listed.length) : active) + step)), true);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (listed[active]) choose(listed[active]!.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          {search && (
            <input
              ref={field}
              type="text"
              value={query}
              placeholder={search}
              spellCheck={false}
              data-list-search
              className="m-1 mb-0 shrink-0 rounded bg-chip px-2 py-1 text-text-strong outline-none placeholder:text-text-faint"
              onChange={(e) => {
                setQuery(e.target.value);
                const next = e.target.value.trim().toLowerCase();
                const first = next ? options.find((o) => o.label.toLowerCase().includes(next)) : undefined;
                // The canvas shows the first match as it's highlighted, and what is chosen once none is.
                setActive(first ? 0 : next ? -1 : options.findIndex((o) => o.id === value));
                preview(first?.id ?? null);
                list.current?.scrollTo({ top: 0 });
              }}
            />
          )}
          <div ref={list} role="listbox" tabIndex={-1} className="min-h-0 overflow-y-auto py-1 outline-none">
          {search && !listed.length && <div className="px-2 py-1 text-text-faint">No matches</div>}
          {listed.map((o, i) => [
            o.group && o.group !== listed[i - 1]?.group && (
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
              style={o.style}
              className={`cursor-default truncate px-2 py-1 ${search ? "[contain-intrinsic-size:auto_28px] [content-visibility:auto]" : ""} ${o.art || o.artClass ? "flex items-center gap-2.5" : ""} ${i === active ? "bg-accent-wash text-text-strong" : o.id === value ? "text-text-strong" : "text-text"}`}
              onMouseEnter={() => {
                if (i !== active || !previewing.current) show(i, false);
              }}
              onClick={() => choose(o.id)}
            >
              {o.art && <img src={o.art} alt="" className="h-[54px] w-24 shrink-0 rounded-sm" draggable={false} />}
              {o.artClass && <span className={`h-16 w-24 shrink-0 rounded-sm bg-cover bg-center ${o.artClass}`} data-option-art />}
              {o.label}
            </div>,
          ])}
          </div>
        </div>
      )}
    </div>
  );
}
