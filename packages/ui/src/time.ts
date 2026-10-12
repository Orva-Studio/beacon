/** The time display: h:mm:ss;ff. */
export function timecode(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  const f = frames % Math.round(fps);
  const total = Math.floor(frames / Math.round(fps));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${h}:${two(m)}:${two(s)};${two(f)}`;
}
