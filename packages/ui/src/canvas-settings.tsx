import { formatColor } from "@beacon/model";
import { useEffect, useState, type ReactNode } from "react";
import { Check, ColorSwatch, fromHex, Icon, Segmented, Select, SettingsRow, TextInput } from "./controls";

/** Canvas size presets (Project Settings), by group. */
const PRESETS: [string, [number, number, string][]][] = [
  [
    "Horizontal",
    [
      [600, 315, "AD"],
      [640, 480, "SD"],
      [1280, 720, "HD"],
      [1920, 1080, "FHD"],
      [2048, 1080, "2K"],
      [2560, 1440, "QHD"],
      [3840, 2160, "4K UHD"],
    ],
  ],
  [
    "Square",
    [
      [600, 600, "1:1 Small"],
      [1080, 1080, "1:1 Large"],
    ],
  ],
  [
    "Vertical",
    [
      [600, 750, "4:5 Small"],
      [1080, 1350, "4:5 Large"],
      [1080, 1920, "9:16 FHD"],
    ],
  ],
];
const FRAME_RATES = [24, 25, 30, 50, 60];

export interface CanvasValues {
  width: number;
  height: number;
  fps: number;
  /** "#rrggbb". */
  background: string;
  normalize: boolean;
}

type Shape = "Horizontal" | "Square" | "Vertical";
const shapeOf = (w: number, h: number): Shape => (w > h ? "Horizontal" : w < h ? "Vertical" : "Square");
/** Picking a shape starts from its usual size: FHD, 1:1 Large, 9:16 FHD. */
const SHAPE_DEFAULT: Record<Shape, [number, number]> = { Horizontal: [1920, 1080], Square: [1080, 1080], Vertical: [1080, 1920] };
const frame = (w: number, h: number) => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x={11 - w / 2} y={11 - h / 2} width={w} height={h} rx="2" />
  </svg>
);
const SHAPES: { value: Shape; label: string; icon: ReactNode }[] = [
  { value: "Horizontal", label: "Landscape", icon: frame(18, 11) },
  { value: "Square", label: "Square", icon: frame(14, 14) },
  { value: "Vertical", label: "Portrait", icon: frame(11, 18) },
];


/** A number field that applies on Enter or blur, not on every keystroke. */
function NumberField({ value, onCommit, title }: { value: number; onCommit: (v: number) => void; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Math.round(Number(text));
    if (v >= 16 && v <= 8192 && v !== value) onCommit(v);
    else setText(String(value));
  };
  return <TextInput className="w-24 text-right tabular-nums" title={title} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

/**
 * Project Settings, laid out by shape: Landscape, Square or
 * Portrait, then that shape's sizes (presets, or Custom), Width and
 * Height with a padlock that keeps the shape, Background Color, Frame Rate and
 * Auto-normalize loudness. Used by Settings > Project and New Project.
 */
export function CanvasSettings({ value, onChange }: { value: CanvasValues; onChange: (patch: Partial<CanvasValues>, label: string, key?: string) => void }) {
  const shape = shapeOf(value.width, value.height);
  const presets = PRESETS.find(([group]) => group === shape)![1];
  const preset = presets.find(([w, h]) => w === value.width && h === value.height);
  const [locked, setLocked] = useState(true);
  const size = (width: number, height: number) => onChange({ width: Math.max(16, Math.round(width / 2) * 2), height: Math.max(16, Math.round(height / 2) * 2) }, "Canvas Dimensions");
  return (
    <div className="flex flex-col gap-3" data-canvas-settings>
      <SettingsRow label="Shape">
        <Segmented data-canvas-shape value={shape} options={SHAPES} onChange={(s) => s !== shape && size(...SHAPE_DEFAULT[s])} />
      </SettingsRow>
      <SettingsRow label="Size">
        <div className="w-56">
          <Select
            data-canvas-size
            value={preset ? `${preset[0]}x${preset[1]}` : "custom"}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              const [w, h] = e.target.value.split("x").map(Number);
              size(w!, h!);
            }}
          >
            {presets.map(([w, h, name]) => (
              <option key={`${w}x${h}`} value={`${w}x${h}`}>
                {name} ({w}×{h})
              </option>
            ))}
            <option value="custom">Custom{preset ? "" : ` (${value.width}×${value.height})`}</option>
          </Select>
        </div>
      </SettingsRow>
      <SettingsRow label="Width × Height">
        <NumberField value={value.width} title="Canvas width in pixels" onCommit={(w) => size(w, locked ? (w * value.height) / value.width : value.height)} />
        <button
          className={`flex size-8 items-center justify-center rounded-md ${locked ? "bg-accent-wash text-accent" : "text-text-faint hover:bg-control hover:text-text-strong"}`}
          title={locked ? "Width and height keep their shape: click to set them apart" : "Width and height are set apart: click to keep their shape"}
          aria-label={locked ? "Unlock width and height" : "Lock width and height"}
          data-lock={locked}
          onClick={() => setLocked(!locked)}
        >
          <Icon name={locked ? "lock-simple" : "lock-simple-open"} size={16} />
        </button>
        <NumberField value={value.height} title="Canvas height in pixels" onCommit={(h) => size(locked ? (h * value.width) / value.height : value.width, h)} />
      </SettingsRow>
      <SettingsRow label="Background Color">
        <ColorSwatch color={fromHex(value.background) ?? [0, 0, 0, 1]} title="The canvas colour behind the media" onChange={(c, key) => onChange({ background: formatColor(c) }, "Canvas Color", key)} />
      </SettingsRow>
      <SettingsRow label="Frame Rate">
        <div className="w-32">
          <Select value={FRAME_RATES.includes(value.fps) ? value.fps : ""} onChange={(e) => onChange({ fps: Number(e.target.value) }, "Frame Rate")}>
            {!FRAME_RATES.includes(value.fps) && <option value="">{Math.round(value.fps * 100) / 100} fps</option>}
            {FRAME_RATES.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </Select>
        </div>
      </SettingsRow>
      <SettingsRow label="">
        <Check label="Auto-normalize loudness" checked={value.normalize} onChange={(on) => onChange({ normalize: on }, "Auto-normalize Loudness")} />
      </SettingsRow>
    </div>
  );
}
