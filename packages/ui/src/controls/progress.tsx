/** A thin bar filled to `value` (0-1). */
export function Progress({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-sm bg-well ${className}`}>
      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}
