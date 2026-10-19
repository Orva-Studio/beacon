const two = (n: number) => String(n).padStart(2, "0");

/**
 * A time as m:ss, or h:mm:ss from an hour: rounded to the second, or with `floor` the whole seconds (a clock
 * counting up); `tenths` keeps a decimal.
 */
export function clock(seconds: number, opts: { floor?: boolean; tenths?: boolean } = {}): string {
  const t = Math.max(0, opts.tenths ? Math.round(seconds * 10) / 10 : opts.floor ? Math.floor(seconds) : Math.round(seconds));
  const s = t % 60;
  const ss = opts.tenths ? s.toFixed(1).padStart(4, "0") : two(s);
  return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${ss}` : `${Math.floor(t / 60)}:${ss}`;
}

/** The time display: h:mm:ss;ff. */
export function timecode(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  const f = frames % Math.round(fps);
  const total = Math.floor(frames / Math.round(fps));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${h}:${two(m)}:${two(s)};${two(f)}`;
}
