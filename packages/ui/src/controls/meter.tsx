/** dBFS shown from here to 0. */
const FLOOR = -60;

const fraction = (db: number) => Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR));

/** An audio level: the average as a bar (amber past -12 dBFS, red past -3) and the recent peak as a tick. */
export function LevelMeter({ db, peak, label }: { db?: number; peak?: number; label: string }) {
  const color = db === undefined || db < -12 ? "bg-accent" : db < -3 ? "bg-warning" : "bg-danger";
  return (
    <div role="meter" aria-label={label} aria-valuemin={FLOOR} aria-valuemax={0} aria-valuenow={db ?? FLOOR} className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-groove" data-level={db}>
      <div className={`absolute inset-y-0 left-0 rounded-full ${color}`} style={{ width: `${fraction(db ?? FLOOR) * 100}%` }} />
      {peak !== undefined && peak > FLOOR && <div className="absolute inset-y-0 w-0.5 bg-text-strong" style={{ left: `calc(${fraction(peak) * 100}% - 2px)` }} />}
    </div>
  );
}
