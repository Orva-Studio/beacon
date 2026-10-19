import { MASK } from "../native-view";

/**
 * Cuts a rounded box out of the native canvas, for the element it sits in (which must be positioned): the canvas
 * cuts out each masked element's rectangle, so a rounded corner would show the page behind it. A strip a point
 * tall per row of the corners follows their curve; the middle is one block.
 */
export function RoundedMask({ radius }: { radius: number }) {
  const r = Math.round(radius);
  const inset = (row: number) => r - Math.sqrt(r * r - (r - row - 0.5) ** 2);
  const strip = (key: string, at: { top?: number; bottom?: number }, x: number) => (
    <div key={key} className={`${MASK} absolute h-px`} style={{ ...at, left: x, right: x }} />
  );
  // Over the element's 1-point border too: absolute children start inside it.
  return (
    <div className="pointer-events-none absolute -inset-px">
      {Array.from({ length: r }, (_, i) => strip(`t${i}`, { top: i }, inset(i)))}
      <div className={`${MASK} absolute inset-x-0`} style={{ top: r, bottom: r }} />
      {Array.from({ length: r }, (_, i) => strip(`b${i}`, { bottom: i }, inset(i)))}
    </div>
  );
}
