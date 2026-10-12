/**
 * The design tokens (styles.css `@theme`) for what isn't styled by CSS: the
 * canvas-drawn timeline, the canvas overlay's marks and the preview's
 * surround. Read once from the page's CSS variables.
 */
const cache = new Map<string, string>();

/** A token's CSS colour, e.g. `color("clip")` for `--color-clip`. */
export function color(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
    if (!v) throw new Error(`no design token --color-${name}`);
    cache.set(name, v);
  }
  return v;
}

let family: string | undefined;

/** A canvas font in the UI's typeface (`--font-ui`). */
export function font(size: number, weight?: number | string): string {
  family ??= getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim();
  return `${weight ? `${weight} ` : ""}${size}px ${family}`;
}

let probe: CanvasRenderingContext2D | undefined;

/** A token as 0-1 RGBA, for the native preview. The browser normalises it (the CSS build may shorten `#ffffff` to `#fff`). */
export function rgba(name: string): [number, number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d")!;
  probe.fillStyle = color(name);
  const v = String(probe.fillStyle);
  if (v.startsWith("#")) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).concat(1) as [number, number, number, number];
  const n = v.slice(v.indexOf("(") + 1, -1).split(",").map(Number);
  return [n[0]! / 255, n[1]! / 255, n[2]! / 255, n[3] ?? 1];
}
