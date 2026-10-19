import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PLAIN_TEXT } from "./buttons";

/** Whether keys typed at `t` edit text (a text box or text area). */
export const isTextField = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

/** Whether keys at `t` go to a form field: a text box, text area or select. */
export const isFormField = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => isTextField(t) || t instanceof HTMLSelectElement;

/**
 * A name typed in place, the old one selected to type over: Return or clicking away gives `onDone` the text
 * (trimmed), Escape gives it null. Focus waits a frame, for a Rename… chosen from a native menu that has to close.
 */
export function RenameField({ value, onDone, className, style }: { value: string; onDone: (name: string | null) => void; className?: string; style?: CSSProperties }) {
  const finished = useRef(false);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };
  return (
    <input
      {...PLAIN_TEXT}
      ref={(el) => {
        if (el && document.activeElement !== el) requestAnimationFrame(() => (el.focus(), el.select()));
      }}
      defaultValue={value}
      className={`rounded-sm border border-accent bg-well px-1 text-text-strong outline-none ${className ?? ""}`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value.trim());
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
    />
  );
}

/** A block of controls in a panel, divided from the next. */
export function Section({ children }: { children: ReactNode }) {
  return <div className="border-b border-divider px-4 py-3">{children}</div>;
}

/** A row: the label hugging its control, controls ending at the value boxes' column. */
export function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <span className="min-w-14 shrink-0 text-right text-label font-medium text-text-muted" title={title}>
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

/** A dialog's row (Settings, Export, New Project): the label in its own column, a hint or error under the control. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-1">
      <span className="text-right text-text-dim">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {hint !== undefined && <div className="col-start-2 text-label text-text-faint">{hint}</div>}
    </div>
  );
}

/** Values as shown: percentages to a tenth, degrees and positions to one place, other numbers to `digits`. */
const fmt = (v: number | undefined, unit: string, digits = 2) =>
  v === undefined || !Number.isFinite(v) ? "—" : unit === "%" ? `${+v.toFixed(1)}%` : `${v.toFixed(unit === "°" ? 1 : digits)}${unit}`;

export const clamp = (v: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, v));

/**
 * A number shown in a box; click to type a new one (Enter or leaving the box applies it, Escape cancels).
 * Values stay within `min`/`max` (a percentage within 0-100% unless told otherwise): typing past the maximum
 * shows the maximum, ↑/↓ stop at the ends, and what is applied is clamped.
 */
export function NumberBox({
  value,
  unit = "",
  digits,
  step = 1,
  min,
  max,
  width = 60,
  onCommit,
}: {
  value: number | undefined;
  unit?: string;
  digits?: number;
  step?: number;
  min?: number;
  max?: number;
  /** Points. */
  width?: number;
  onCommit?: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const lo = min ?? (unit === "%" ? 0 : -Infinity);
  const hi = max ?? (unit === "%" ? 100 : Infinity);
  const cls = "h-6 shrink-0 rounded-md border border-transparent bg-chip px-1.5 text-right text-label leading-[22px] tabular-nums text-text-strong";
  if (!editing || !onCommit) {
    return (
      <span className={`${cls} ${onCommit ? "cursor-text" : "opacity-50"}`} style={{ width }} onClick={() => onCommit && setEditing(true)}>
        {fmt(value, unit, digits)}
      </span>
    );
  }
  const done = (el: HTMLInputElement, apply: boolean) => {
    const v = Number.parseFloat(el.value);
    setEditing(false);
    if (apply && Number.isFinite(v) && clamp(v, lo, hi) !== value) onCommit(clamp(v, lo, hi));
  };
  return (
    <input
      {...PLAIN_TEXT}
      autoFocus
      className={`${cls} outline-none focus:border-accent`}
      style={{ width }}
      defaultValue={value === undefined ? "" : +value.toFixed(3)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        // Only the maximum while typing: a minimum of 8 would stop "12" at its first digit.
        const v = Number.parseFloat(e.currentTarget.value);
        if (v > hi) e.currentTarget.value = String(hi);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(e.currentTarget, true);
        if (e.key === "Escape") done(e.currentTarget, false);
        // ↑/↓ step the value and apply it, ten steps with ⇧, staying in the box.
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const now = Number.parseFloat(e.currentTarget.value);
          const next = clamp(+((Number.isFinite(now) ? now : (value ?? 0)) + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(4), lo, hi);
          e.currentTarget.value = String(next);
          onCommit(next);
        }
      }}
      onBlur={(e) => done(e.currentTarget, true)}
    />
  );
}

/** A track and thumb dragged to change a value; `onChange`'s key is the same for one drag (one undo step). */
export function SliderTrack({
  value,
  min = 0,
  max,
  step = 1,
  name,
  onChange,
}: {
  value: number;
  min?: number;
  max: number;
  step?: number;
  /** Names the drag's key. */
  name: string;
  onChange?: (v: number, key: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const key = useRef("");
  const pending = useRef(0);
  const f = max > min ? clamp((value - min) / (max - min), 0, 1) : 0;
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const v = min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min);
    return Math.round(v / step) * step;
  };
  const send = (v: number) => {
    cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => onChange?.(v, key.current));
  };
  return (
    <div
      ref={track}
      className={`relative h-1 min-w-16 flex-1 rounded-full bg-groove ${onChange ? "cursor-pointer" : ""}`}
      onPointerDown={(e) => {
        if (!onChange) return;
        key.current = `slider-${name}-${Date.now()}`;
        e.currentTarget.setPointerCapture(e.pointerId);
        send(at(e.clientX));
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && send(at(e.clientX))}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-slider-fill" style={{ width: `${f * 100}%` }} />
      <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slider-thumb shadow" style={{ left: `${f * 100}%` }} />
    </div>
  );
}

/** A labelled slider and its value in a box to type. */
export function Slider({
  label,
  value,
  min = 0,
  max,
  unit,
  step = 1,
  digits,
  onChange,
  reset,
  title,
}: {
  label: string;
  title?: string;
  value: number;
  min?: number;
  max: number;
  unit: string;
  step?: number;
  digits?: number;
  onChange?: (v: number, key?: string) => void;
  reset?: () => void;
}) {
  return (
    <Row label={label} title={title}>
      <div className="mr-3 flex flex-1">
        <SliderTrack value={value} min={min} max={max} step={step} name={label} onChange={onChange} />
      </div>
      <NumberBox value={value} unit={unit} digits={digits} min={min} max={max} step={unit === "%" || step >= 1 ? 1 : 0.1} onCommit={onChange ? (v) => onChange(v) : undefined} />
      {reset && (
        <button title="Reset" className="ml-1 text-text-muted hover:text-text-strong" onClick={reset}>
          ↺
        </button>
      )}
    </Row>
  );
}

/** A value box with up/down steppers. */
export function Stepper({ axis, value, min, max, onChange }: { axis: string; value: number | undefined; min?: number; max?: number; onChange?: (v: number) => void }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="text-label font-medium text-text-muted">{axis}</span>
      <NumberBox value={value} digits={1} min={min} max={max} onCommit={onChange} />
      {onChange && value !== undefined && (
        <div className="flex flex-col text-[8px] leading-[9px] text-text-muted">
          <button className="hover:text-text-strong" onClick={() => onChange(clamp(Math.round(value) + 1, min, max))}>
            ▲
          </button>
          <button className="hover:text-text-strong" onClick={() => onChange(clamp(Math.round(value) - 1, min, max))}>
            ▼
          </button>
        </div>
      )}
    </div>
  );
}

/** A tick box: with a label beside it, or alone with `title` as its tooltip (an effect's on/off). */
export function Check({ label, title, checked, onChange, disabled, ...data }: { label?: string; title?: string; checked: boolean; onChange?: (on: boolean) => void; disabled?: boolean; [data: `data-${string}`]: unknown }) {
  return (
    <button
      {...data}
      role="checkbox"
      aria-checked={checked}
      aria-label={label ?? title}
      title={title}
      disabled={disabled || !onChange}
      className="flex shrink-0 items-center gap-2 text-left text-text disabled:opacity-50"
      onClick={() => onChange?.(!checked)}
      // A checkbox: Space toggles it, Enter is left to the dialog (its default action), as a native one does.
      onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
    >
      <span className={`flex h-4 w-4 items-center justify-center rounded-xs border text-caption font-bold ${checked ? "border-accent bg-accent text-accent-text" : "border-text-faint"}`}>{checked ? "✓" : ""}</span>
      {label}
    </button>
  );
}

