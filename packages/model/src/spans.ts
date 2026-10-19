/** A stretch of time `[start, end)`, in whatever unit its caller uses (seconds or ticks). */
export type Span = [number, number];

/** `spans` sorted by start, those that overlap or are at most `gap` apart merged into one. */
export function mergeSpans(spans: readonly (readonly [number, number])[], gap = 0): Span[] {
  const merged: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** What is left of `span` once every one of `holes` is taken out of it, in order. */
export function subtractSpans(span: readonly [number, number], holes: readonly (readonly [number, number])[]): Span[] {
  let parts: Span[] = [[span[0], span[1]]];
  for (const [h0, h1] of holes) {
    parts = parts.flatMap(([a, b]): Span[] => (h1 <= a || h0 >= b ? [[a, b]] : ([[a, h0], [h1, b]] as Span[]).filter(([x, y]) => y > x)));
  }
  return parts;
}
