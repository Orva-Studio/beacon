import { useRef, useState } from "react";
import { NumberBox } from "./fields";

export type Axis = "x" | "y" | "z";
type Vec = [number, number, number];

const SIZE = 112;
const R = 46;
/** Seen from a little above and to the side, so the X and Y rings open into ellipses. */
const YAW = (-28 * Math.PI) / 180;
const PITCH = (22 * Math.PI) / 180;
const STEPS = 96;

/** Right-handed, y up, z towards the viewer, as the renderer (`model/perspective.ts`). */
function view([x, y, z]: Vec): Vec {
  const x1 = x * Math.cos(YAW) + z * Math.sin(YAW);
  const z1 = -x * Math.sin(YAW) + z * Math.cos(YAW);
  return [x1, y * Math.cos(PITCH) - z1 * Math.sin(PITCH), y * Math.sin(PITCH) + z1 * Math.cos(PITCH)];
}

const screen = (p: Vec): [number, number, number] => {
  const [x, y, z] = view(p);
  return [SIZE / 2 + x * R, SIZE / 2 - y * R, z];
};

/** A point on an axis's ring at angle t, turning the right-handed way about that axis. */
const ring: Record<Axis, (t: number) => Vec> = {
  x: (t) => [0, Math.cos(t), Math.sin(t)],
  y: (t) => [Math.sin(t), 0, Math.cos(t)],
  z: (t) => [Math.cos(t), Math.sin(t), 0],
};

/** The renderer's R = Rz · Ry · Rx (radians). */
function rotate([x, y, z]: Vec, rx: number, ry: number, rz: number): Vec {
  const [y1, z1] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  const [x2, z2] = [x * Math.cos(ry) + z1 * Math.sin(ry), -x * Math.sin(ry) + z1 * Math.cos(ry)];
  return [x2 * Math.cos(rz) - y1 * Math.sin(rz), x2 * Math.sin(rz) + y1 * Math.cos(rz), z2];
}

/** The ring as its front and back halves, so the far side can be drawn fainter. */
function ringPaths(axis: Axis): { front: string; back: string } {
  const out = { front: "", back: "" };
  let side: "front" | "back" | undefined;
  for (let i = 0; i < STEPS; i++) {
    const [a, b] = [i, i + 1].map((k) => screen(ring[axis]((k / STEPS) * 2 * Math.PI)));
    const s = a![2] + b![2] >= 0 ? "front" : "back";
    if (s !== side) out[s] += `M${a![0].toFixed(1)},${a![1].toFixed(1)}`;
    out[s] += `L${b![0].toFixed(1)},${b![1].toFixed(1)}`;
    side = s;
  }
  return out;
}

const PATHS = { x: ringPaths("x"), y: ringPaths("y"), z: ringPaths("z") };
const COLOR: Record<Axis, string> = { x: "var(--color-axis-x)", y: "var(--color-axis-y)", z: "var(--color-axis-z)" };

/** The ring nearest a point in the gizmo, front halves first, and the ring's angle there. */
function hit(px: number, py: number): { axis: Axis; t: number } | undefined {
  let best: { axis: Axis; t: number; d: number } | undefined;
  for (const axis of ["z", "x", "y"] as Axis[]) {
    for (let i = 0; i < 360; i++) {
      const t = (i / 360) * 2 * Math.PI;
      const [sx, sy, depth] = screen(ring[axis](t));
      const d = Math.hypot(sx - px, sy - py) + (depth < 0 ? 3 : 0);
      if (!best || d < best.d) best = { axis, t, d };
    }
  }
  return best && best.d <= 9 ? best : undefined;
}

/** The angle on one ring nearest a point. */
function angleOn(axis: Axis, px: number, py: number): number {
  let best = { t: 0, d: Infinity };
  for (let i = 0; i < 720; i++) {
    const t = (i / 720) * 2 * Math.PI;
    const [sx, sy] = screen(ring[axis](t));
    const d = Math.hypot(sx - px, sy - py);
    if (d < best.d) best = { t, d };
  }
  return best.t;
}

/**
 * Rotation as three rings to drag (X red, Y green, Z blue), seen slightly from above, with a card inside
 * showing the clip's orientation; beside it, each axis's degrees to type. `key` makes a drag one undo step.
 */
export function RotationGizmo({ value, onChange }: { value: Record<Axis, number>; onChange?: (axis: Axis, deg: number, key?: string) => void }) {
  const [hover, setHover] = useState<Axis>();
  const drag = useRef<{ axis: Axis; t: number; start: number; key: string } | undefined>(undefined);
  const [active, setActive] = useState<Axis>();
  const local = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE] as const;
  };
  const rad = (d: number) => (d * Math.PI) / 180;
  const card = ([[-0.58, 0.33], [0.58, 0.33], [0.58, -0.33], [-0.58, -0.33]] as const)
    .map(([x, y]) => screen(rotate([x, y, 0], rad(value.x), rad(value.y), rad(value.z))))
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const top = screen(rotate([0, 0.33, 0], rad(value.x), rad(value.y), rad(value.z)));
  const lit = active ?? hover;
  return (
    <div className="flex items-center gap-3">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={onChange ? "shrink-0 touch-none" : "shrink-0 opacity-50"}
        style={{ cursor: lit ? "grab" : "default" }}
        data-rotation-gizmo
        onPointerDown={(e) => {
          if (!onChange) return;
          const [px, py] = local(e);
          const h = hit(px, py);
          if (!h) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { axis: h.axis, t: h.t, start: value[h.axis], key: `rotate-${Date.now()}` };
          setActive(h.axis);
        }}
        onPointerMove={(e) => {
          const [px, py] = local(e);
          const d = drag.current;
          if (!d) return setHover(hit(px, py)?.axis);
          const t = angleOn(d.axis, px, py);
          // Unwrapped, so a drag can go round more than once.
          let dt = t - d.t;
          if (dt > Math.PI) dt -= 2 * Math.PI;
          if (dt < -Math.PI) dt += 2 * Math.PI;
          d.t = t;
          d.start += (dt * 180) / Math.PI;
          onChange?.(d.axis, Math.round(d.start * 10) / 10, d.key);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = undefined;
          setActive(undefined);
        }}
        onPointerLeave={() => !drag.current && setHover(undefined)}
      >
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R + 6} fill="var(--color-chip)" />
        {(["x", "y", "z"] as Axis[]).map((a) => (
          <path key={`${a}-back`} d={PATHS[a].back} fill="none" stroke={COLOR[a]} strokeWidth={lit === a ? 2 : 1.25} strokeOpacity={0.35} strokeDasharray="2 3" />
        ))}
        <polygon points={card} fill="var(--color-text-bright)" fillOpacity={0.08} stroke="var(--color-text-muted)" strokeWidth={1} />
        <circle cx={top[0]} cy={top[1]} r={1.8} fill="var(--color-text-muted)" />
        {(["x", "y", "z"] as Axis[]).map((a) => (
          <path key={a} d={PATHS[a].front} fill="none" stroke={COLOR[a]} strokeWidth={lit === a ? 3 : 1.75} strokeLinecap="round" data-ring={a} />
        ))}
      </svg>
      <div className="flex flex-col gap-2">
        {(["z", "y", "x"] as Axis[]).map((a) => (
          <div key={a} className="flex items-center gap-1.5">
            <span className="w-3 text-label font-semibold" style={{ color: COLOR[a] }}>
              {a.toUpperCase()}
            </span>
            <NumberBox value={value[a]} unit="°" onCommit={onChange ? (v) => onChange(a, v) : undefined} />
          </div>
        ))}
      </div>
    </div>
  );
}
