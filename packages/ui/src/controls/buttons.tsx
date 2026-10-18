import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Icon } from "./icons";

/**
 * The editor's shared controls: each look is defined once here, in design
 * tokens (styles.css), so restyling the UI is editing this file and the tokens.
 */

const BUTTON = {
  /** A filled button (the top bar's Open…). */
  solid: "rounded-md bg-control px-2.5 py-1 text-text-strong hover:bg-tile-hover disabled:opacity-50 disabled:hover:bg-control",
  /** The one action a sheet is for (Export, Done). */
  primary: "rounded-md bg-accent px-3 py-1 font-semibold text-accent-text hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100",
  /** Stopping something under way (a recording). */
  danger: "rounded-md bg-danger px-3 py-1 font-semibold text-white hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100",
  /** An icon in a toolbar or the transport. */
  icon: "rounded-md px-2 py-1 text-base hover:bg-control disabled:opacity-35 disabled:hover:bg-transparent",
  /** A small text or × button inside a panel. */
  quiet: "rounded-sm px-1.5 text-text-muted hover:bg-chip hover:text-text-strong",
  /** The open group's breadcrumb back to the main timeline. */
  crumb: "rounded-sm px-2 py-0.5 text-text-muted hover:bg-control hover:text-text-strong",
};

export function Button({ look = "solid", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { look?: keyof typeof BUTTON }) {
  return <button {...props} className={BUTTON[look]} />;
}

const SELECT = {
  /** In a bar (the canvas zoom). */
  bar: "rounded-md bg-control px-1.5 py-1 outline-none",
  /** A property's value in the properties panel. */
  field: "w-full rounded-md bg-chip px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent",
};

export function Select({ look = "field", onChange, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { look?: keyof typeof SELECT }) {
  // A picked option leaves focus in the select, where the window's shortcuts (arrows, , and .) don't reach; let it go.
  return <select {...props} className={SELECT[look]} onChange={(e) => (onChange?.(e), e.currentTarget.blur())} />;
}

const FIELD = "rounded-md border border-transparent bg-chip px-2 py-1.5 text-text-strong outline-none focus:border-accent disabled:opacity-50";

/** A text or number field in a dialog or panel; `className` only sizes and aligns it. */
/** For names and values: macOS's text settings would capitalise the first letter and swap in corrections. */
export const PLAIN_TEXT = { autoCapitalize: "off", autoCorrect: "off" } as const;

export function TextInput({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...PLAIN_TEXT} {...props} className={`${FIELD} ${className}`} />;
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={`${FIELD} resize-none ${className}`} />;
}

/** A tab of icons over a panel (the properties panel's Visual, Cursor, Audio). */
export function Tab({ active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      {...props}
      className={`flex h-12 min-w-16 flex-1 items-center justify-center border-b-2 ${active ? "border-b-tab-active text-tab-active" : "border-b-transparent text-text-muted hover:text-text-strong"}`}
    />
  );
}

/** A tool in the left rail (Media, Annotations…): an icon, its name in the tooltip. */
export function RailButton({ active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      {...props}
      className={`flex size-10 items-center justify-center rounded-lg ${active ? "bg-accent-wash text-accent" : "text-text-muted hover:bg-item-hover hover:text-text-strong"}`}
    />
  );
}

/**
 * A tool panel's item: its picture (an `art-<id>` class from art/art.css) over its name. `star`: shown while
 * selected (white, adds it to Favorites) and on favourites (gold, removes it); clicking it calls `onStar`.
 */
export function ItemTile({ art, children, selected, star, onStar, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { art?: string; selected?: boolean; star?: "off" | "on"; onStar?: () => void }) {
  return (
    <button
      {...props}
      className={`relative flex cursor-grab flex-col gap-1.5 rounded-lg bg-tile p-1.5 text-left text-label text-text-strong hover:bg-tile-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-tile disabled:hover:ring-0 ${selected ? "ring-2 ring-tile-selected" : "hover:ring-1 hover:ring-accent/40"}`}
    >
      {art && <span className={`aspect-[3/2] w-full rounded-md bg-groove bg-cover bg-center art-${art}`} data-art={art} />}
      <span className="px-0.5">{children}</span>
      {star && (
        <span
          role="button"
          aria-label={star === "on" ? "Remove from Favorites" : "Add to Favorites"}
          title={star === "on" ? "Remove from Favorites" : "Add to Favorites"}
          data-star={star}
          className={`absolute top-2.5 right-2.5 flex size-6 cursor-pointer items-center justify-center rounded-full bg-clip-badge ${star === "on" ? "text-favorite" : "text-white hover:text-favorite"}`}
          // Its own click: the tile's press would select or start a drag.
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onStar?.();
          }}
        >
          <Icon name="star" size={15} filled={star === "on"} />
        </span>
      )}
    </button>
  );
}

/** A Media Bin item: a thumbnail over its name, outlined while selected. */
export function MediaTile({ selected, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { selected: boolean }) {
  return <div {...props} className={`select-none rounded-lg bg-tile p-1.5 outline-none hover:bg-tile-hover ${selected ? "ring-2 ring-accent ring-inset" : ""} ${className}`} />;
}

/** A row of choices, one active (the canvas shape): each an icon over a short label. */
export function Segmented<T extends string>({ value, options, onChange, ...props }: { value: T | undefined; options: { value: T; label: string; icon: ReactNode }[]; onChange: (v: T) => void } & Omit<HTMLAttributes<HTMLDivElement>, "onChange">) {
  return (
    <div {...props} role="radiogroup" className="inline-flex gap-1 rounded-lg bg-chip p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.label}
          className={`flex w-[76px] flex-col items-center gap-1 rounded-md py-1.5 text-caption ${value === o.value ? "bg-tile-hover text-accent" : "text-text-muted hover:text-text-strong"}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
