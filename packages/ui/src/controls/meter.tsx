import { useEffect, useRef } from "react";

/** dBFS shown from here to 0. */
const FLOOR = -60;
/** A peak stays this long before the marker falls back to newer ones (OBS holds 20 s; a short glance needs less). */
const HOLD_MS = 1500;

const fraction = (db: number) => Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR));

/** The loudest peak of the last HOLD_MS. */
function useHeldPeak(peak: number | undefined) {
  const held = useRef<{ db: number; at: number }>(undefined);
  const now = Date.now();
  if (peak !== undefined && (!held.current || peak >= held.current.db || now - held.current.at > HOLD_MS)) held.current = { db: peak, at: now };
  return held.current?.db;
}

/** An audio level: the average as a bar (amber past -12 dBFS, red past -3) and the held peak as a tick. */
export function LevelMeter({ db, peak, label }: { db?: number; peak?: number; label: string }) {
  const held = useHeldPeak(peak);
  const color = db === undefined || db < -12 ? "bg-accent" : db < -3 ? "bg-warning" : "bg-danger";
  return (
    <div role="meter" aria-label={label} aria-valuemin={FLOOR} aria-valuemax={0} aria-valuenow={db ?? FLOOR} className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-groove" data-level={db}>
      <div className={`absolute inset-y-0 left-0 rounded-full ${color}`} style={{ width: `${fraction(db ?? FLOOR) * 100}%` }} />
      {held !== undefined && held > FLOOR && <div className={`absolute inset-y-0 w-0.5 ${held >= -3 ? "bg-danger" : "bg-text-strong"}`} style={{ left: `calc(${fraction(held) * 100}% - 2px)` }} />}
    </div>
  );
}

/** Levels kept for a rolling waveform: one bar per level read (20 a second), the newest on the right. */
const HISTORY = 120;

/**
 * An audio level over the last few seconds as a rolling waveform (bars mirrored about the middle), so a glance
 * shows sound is coming in and whether it clipped. Each `level` read is pushed, so silence scrolls too.
 */
export function LevelHistory({ level, label }: { level?: { db: number }; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const levels = useRef<number[]>([]);
  useEffect(() => {
    if (!level) return;
    levels.current.push(level.db);
    if (levels.current.length > HISTORY) levels.current.shift();
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const scale = window.devicePixelRatio || 1;
    const { width, height } = c.getBoundingClientRect();
    if (c.width !== Math.round(width * scale)) [c.width, c.height] = [Math.round(width * scale), Math.round(height * scale)];
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(c);
    const step = width / HISTORY;
    levels.current.forEach((v, i) => {
      const h = Math.max(1, fraction(v) * height);
      ctx.fillStyle = styles.getPropertyValue(v >= -3 ? "--color-danger" : v >= -12 ? "--color-warning" : "--color-accent");
      ctx.fillRect(width - (levels.current.length - i) * step, (height - h) / 2, Math.max(1, step - 1), h);
    });
  }, [level]);
  return <canvas ref={canvas} role="img" aria-label={label} className="h-6 min-w-16 flex-1" data-history={levels.current.length} />;
}
