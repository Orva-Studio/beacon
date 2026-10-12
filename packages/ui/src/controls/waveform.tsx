/** Peaks (0-255, one per 10 ms) as grey bars growing up from the bottom, stretched to fill the box. */
export function Waveform({ peaks, className = "" }: { peaks: number[]; className?: string }) {
  const columns = Math.min(160, peaks.length);
  const per = peaks.length / Math.max(1, columns);
  let d = "";
  for (let i = 0; i < columns; i++) {
    let peak = 0;
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) peak = Math.max(peak, peaks[j] ?? 0);
    const h = (peak / 255) * 100;
    d += `M${i} 100V${(100 - h).toFixed(1)}h0.8V100z`;
  }
  return (
    <svg viewBox={`0 0 ${columns} 100`} preserveAspectRatio="none" className={className} data-waveform>
      <path d={d} className="fill-wave" />
    </svg>
  );
}
