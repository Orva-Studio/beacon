import { ICON_PATHS } from "./icon-paths";

export type IconName = keyof typeof ICON_PATHS;

/** One of the editor's icons (Phosphor): the regular weight, or `filled` for an active or emphasised state. */
export function Icon({ name, size = 18, filled = false, className }: { name: IconName; size?: number; filled?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className} aria-hidden>
      <path d={ICON_PATHS[name][filled ? 1 : 0]} />
    </svg>
  );
}

const paths = new Map<string, Path2D>();

/** Draws an icon on a canvas (the timeline's headers), centred on (x, y), `size` points across, in the current fill style. */
export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, x: number, y: number, size: number, filled = false) {
  const key = `${name}:${filled}`;
  let p = paths.get(key);
  if (!p) paths.set(key, (p = new Path2D(ICON_PATHS[name][filled ? 1 : 0])));
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 256, size / 256);
  ctx.fill(p);
  ctx.restore();
}
