import { createContext, useContext, useEffect, useRef, useState } from "react";
import { parseColor, type RGBA } from "@beacon/model";
import { PLAIN_TEXT } from "./buttons";
import { MASK, syncNativeView } from "../native-view";
import { clamp, NumberBox, Row, Slider } from "./fields";
import { Icon } from "./icons";

export type { RGBA };

/** Picking a colour from the canvas, which the app gives the colour controls (the canvas takes the click). */
export interface Eyedropper {
  /** Starts picking; `done` gets the colour, or nothing when cancelled. */
  start(done: (rgb?: [number, number, number]) => void): void;
  stop(): void;
  /** Whether a pick is under way: a click on the canvas then isn't one away from the picker. */
  active(): boolean;
}

export const EyedropperContext = createContext<Eyedropper | undefined>(undefined);

export const toHex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
/** `#rrggbb` or `#rrggbbaa` (Camtasia's colours keep their alpha), the `#` optional. */
export const fromHex = (h: string): RGBA | undefined => {
  try {
    return parseColor(h.trim().replace(/^#?/, "#"));
  } catch {
    return undefined;
  }
};

/** Hue 0-360, saturation and value 0-1. */
function toHsv([r, g, b]: readonly number[]): [number, number, number] {
  const max = Math.max(r!, g!, b!);
  const d = max - Math.min(r!, g!, b!);
  const h = d === 0 ? 0 : max === r ? ((g! - b!) / d + 6) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return [h * 60, max === 0 ? 0 : d / max, max];
}
function fromHsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** The preset row: white, greys, black, then bright colours. */
const PRESETS = ["#ffffff", "#c8c8c8", "#808080", "#3c3c3c", "#000000", "#e8473b", "#f39c32", "#f7d038", "#5cc35a", "#2fa8e0", "#3d64d8", "#9a55d6", "#e85aa8"];

const MY_COLORS = "beacon.myColors";
function loadMine(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MY_COLORS) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveMine(colors: string[]) {
  try {
    localStorage.setItem(MY_COLORS, JSON.stringify(colors));
  } catch {
    // Private storage off: My Colors last until the window closes.
  }
}

/** Drags a pointer over an element, reporting 0-1 positions; one `key` per drag (one undo step). */
function useDrag(onMove: (fx: number, fy: number, key: string) => void) {
  const key = useRef("");
  const at = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onMove(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), key.current);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      key.current = `color-${Date.now()}`;
      e.currentTarget.setPointerCapture(e.pointerId);
      at(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => e.currentTarget.hasPointerCapture(e.pointerId) && at(e),
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => e.currentTarget.releasePointerCapture(e.pointerId),
  };
}

/**
 * The colour picker: presets, a saturation/brightness square, a hue strip, an eyedropper that
 * samples the canvas, R/G/B and hex boxes, and My Colors (kept by this window). Alpha is passed through.
 */
export function ColorPicker({ color, onChange, onClose }: { color: RGBA; onChange: (c: RGBA, key?: string) => void; onClose: () => void }) {
  // Hue is kept apart from the colour: greys and black have none, and the square shouldn't lose it.
  const [hsv, setHsv] = useState(() => toHsv(color));
  const [mine, setMine] = useState(loadMine);
  const [picking, setPicking] = useState(false);
  const eyedropper = useContext(EyedropperContext);
  const [h, s, v] = toHex(color) === toHex(fromHsv(...hsv)) ? hsv : toHsv(color);
  const apply = (next: [number, number, number], key?: string) => {
    setHsv(next);
    onChange([...fromHsv(...next), color[3]] as RGBA, key);
  };
  const applyRgb = (rgb: readonly number[], key?: string) => {
    setHsv(toHsv(rgb));
    onChange([rgb[0]!, rgb[1]!, rgb[2]!, color[3]], key);
  };
  const square = useDrag((fx, fy, key) => apply([h, fx, 1 - fy], key));
  const hue = useDrag((fx, _fy, key) => apply([fx * 360, s, v], key));
  const pure = toHex(fromHsv(h, 1, 1));
  const swatch = (hex: string, title?: string) => (
    <button key={hex} title={title ?? hex} className="h-4 w-4 rounded-sm border border-white/10" style={{ background: hex }} onClick={() => applyRgb(fromHex(hex)!)} />
  );
  return (
    <div className="flex w-[260px] flex-col gap-2.5 rounded-md border border-divider bg-panel p-3 text-label shadow-xl" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="flex flex-wrap gap-[2px]">{PRESETS.map((p) => swatch(p))}</div>
      <div {...square} className="relative h-[140px] cursor-crosshair rounded-sm" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }}>
        <div className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
      </div>
      <div className="flex items-center gap-2">
        {eyedropper && (
          <button
            title="Pick a colour from the canvas"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${picking ? "bg-accent text-accent-text" : "bg-control text-text-strong hover:bg-tile-hover"}`}
            onClick={() => {
              if (picking) return (setPicking(false), eyedropper.stop());
              setPicking(true);
              eyedropper.start((rgb) => (setPicking(false), rgb && applyRgb(rgb)));
            }}
          >
            <Icon name="eyedropper" size={14} />
          </button>
        )}
        <div {...hue} className="relative h-3 flex-1 cursor-pointer rounded-full" style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}>
          <div className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${(h / 360) * 100}%`, background: pure }} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-6 w-6 shrink-0 rounded-sm border border-white/10" style={{ background: toHex(color) }} />
        <input
          {...PLAIN_TEXT}
          key={toHex(color)}
          className="h-6 w-[72px] rounded-[3px] border border-field-edge bg-well px-1.5 font-mono text-label text-text-strong outline-none focus:border-accent"
          defaultValue={toHex(color)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const c = fromHex(e.currentTarget.value);
            if (c) applyRgb(c);
          }}
        />
      </div>
      <div className="flex justify-between">
        {(["R", "G", "B"] as const).map((name, i) => (
          <label key={name} className="flex items-center gap-1 font-semibold text-text-strong">
            {name}
            <NumberBox value={Math.round(color[i]! * 255)} digits={0} min={0} max={255} onCommit={(x) => applyRgb(color.map((c, j) => (j === i ? x / 255 : c)))} />
          </label>
        ))}
      </div>
      <div>
        <div className="mb-1 font-semibold text-text-muted">My Colors</div>
        <div className="flex flex-wrap gap-[2px]">
          {mine.map((m) => swatch(m))}
          <button
            title="Add this colour to My Colors"
            className="h-4 w-4 rounded-sm border border-dashed border-text-faint leading-none text-text-muted hover:text-text-strong"
            onClick={() => {
              const next = [toHex(color), ...mine.filter((m) => m !== toHex(color))].slice(0, 24);
              setMine(next);
              saveMine(next);
            }}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

/** A colour swatch that opens the picker below it; `onChange`'s key makes a drag one undo step. */
export function ColorSwatch({ color, onChange, title }: { color: RGBA; onChange: (c: RGBA, key?: string) => void; title?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const eyedropper = useContext(EyedropperContext);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    syncNativeView();
    if (!at) return;
    const away = (e: PointerEvent) => {
      // The eyedropper's click on the canvas isn't "away".
      if (eyedropper?.active() || pop.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setAt(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !eyedropper?.active() && setAt(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
      eyedropper?.stop();
      syncNativeView();
    };
  }, [at]);
  return (
    <>
      <button
        ref={button}
        title={title ?? "Choose a colour"}
        className="h-7 w-12 cursor-pointer rounded-sm border border-field-edge p-[3px]"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: Math.max(4, Math.min(r.right - 260, innerWidth - 268)), y: r.bottom + 4 });
        }}
      >
        <span className="block h-full w-full rounded-sm" style={{ background: toHex(color) }} />
      </button>
      {at && (
        // Masked out of the native canvas, which would otherwise draw over the part of it that overlaps.
        <div ref={pop} className={`${MASK} fixed z-50`} style={{ left: at.x, top: Math.min(at.y, innerHeight - 420) }}>
          <ColorPicker color={color} onChange={onChange} onClose={() => setAt(null)} />
        </div>
      )}
    </>
  );
}

/** A labelled colour, and its opacity as a slider when the colour has one. */
export function ColorRow({ label, color, opacity = true, onChange }: { label: string; color: RGBA | undefined; opacity?: boolean; onChange: (c: RGBA, key?: string) => void }) {
  const c = color ?? [0, 0, 0, 1];
  return (
    <>
      <Row label={label}>
        <ColorSwatch color={c} title={label} onChange={onChange} />
      </Row>
      {opacity && <Slider label="Opacity" value={c[3] * 100} max={100} unit="%" onChange={(v, key) => onChange([c[0], c[1], c[2], v / 100], key)} />}
    </>
  );
}
