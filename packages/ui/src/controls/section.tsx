import { useState, type ReactNode } from "react";
import { Check } from "./fields";
import { Icon } from "./icons";

/**
 * A section that folds, as effects and Clip Speed: a dark header with a chevron, the title
 * (clicking it calls `onSelect`, e.g. to select an effect for ⌘C), a trash button (`remove`), "•••" with `menu`'s items, an optional on/off tick.
 */
export function FoldSection({
  title,
  selected,
  onSelect,
  selectHint,
  remove,
  menu,
  enabled,
  onEnable,
  children,
}: {
  title: string;
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  selectHint?: string;
  /** The section's own removal (Remove Effect): a trash icon, the label as its tooltip. */
  remove?: { label: string; run: () => void };
  menu?: { label: string; run: () => void }[];
  enabled?: boolean;
  onEnable?: (on: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div className="border-b border-divider">
      <div data-fold-head className={`relative flex h-10 items-center gap-2 px-3 ${selected ? "bg-accent-wash" : "bg-section-head"}`}>
        <button className="flex h-6 w-5 items-center justify-center text-text-strong" title={open ? "Hide the settings" : "Show the settings"} onClick={() => setOpen(!open)}>
          <Icon name="caret-down" size={14} className={open ? "" : "-rotate-90"} />
        </button>
        <span className="flex-1 cursor-default truncate text-[14px] font-semibold text-text-strong" title={selectHint} onClick={onSelect}>
          {title}
        </span>
        {remove && <TrashButton label={remove.label} onClick={remove.run} />}
        {menu && (
          <button className="px-1 text-text-strong" title="More" onClick={() => setShowMenu(!showMenu)}>
            <Icon name="dots-three" size={18} />
          </button>
        )}
        {menu && showMenu && (
          <div className="absolute top-9 right-12 z-10 rounded-sm border border-divider bg-panel py-1 shadow-lg" onMouseLeave={() => setShowMenu(false)}>
            {menu.map((m) => (
              <button key={m.label} className="block w-full px-3 py-1 text-left hover:bg-item-hover" onClick={() => (setShowMenu(false), m.run())}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        {onEnable && <Check checked={!!enabled} title={enabled ? `Turn ${title} off` : `Turn ${title} on`} onChange={onEnable} />}
      </div>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  );
}

/** Removes what it sits beside (an effect, an animation); `label` is its tooltip. */
export function TrashButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-control hover:text-danger" title={label} aria-label={label} onClick={onClick}>
      <Icon name="trash" size={16} />
    </button>
  );
}
