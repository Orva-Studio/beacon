/**
 * Everything that depends on how Electrobun's `<electrobun-wgpu>` tag
 * behaves (checked against Electrobun 2.0.2, `api/preload/wgpuTag.ts`,
 * `overlaySync.ts` and its native `resizeWithFrame:parsedMasks:`), so an
 * Electrobun update is checked here:
 * - its preload styles the tag 800×300, which beats an `inset`;
 * - it sends the native view its frame and masks only when the tag's own box
 *   changes (`syncDimensions(true)` forces it);
 * - natively it positions the view from the window's bottom edge, so a window
 *   resized from outside can leave it placed for the old height;
 * - with `passthrough`, clicks go through the native view to the page, and
 *   elements matching `masks` are cut out of it so they show over it.
 */

/** Elements cut out of the native view so they show over the video: only the dragged panel item; the canvas's selection is drawn by the preview. */
export const MASK = "ot-mask";

/** The tag's style: inset in its area, sized by the inset rather than Electrobun's 800×300. */
export const nativeViewStyle = (inset: number) => ({ position: "absolute", inset, width: "auto", height: "auto", display: "block" }) as const;

type Tag = HTMLElement & { syncDimensions?: (force: boolean) => void };

const sync = (tag: Element | null) => (tag as Tag | null)?.syncDimensions?.(true);

let pending = 0;
/** Re-sends the native view its frame and masks on the next frame (masked elements appeared, moved or went). */
export function syncNativeView() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    for (const tag of document.querySelectorAll("electrobun-wgpu")) sync(tag);
  });
}

/**
 * Re-places the native view a few times after the window or `area` resizes,
 * so the last placement uses the final size (a tiling window manager resizes
 * in steps). Returns the cleanup.
 */
export function followResizes(tag: Element, area: Element): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const replace = () => {
    for (const t of timers.splice(0)) clearTimeout(t);
    for (const ms of [0, 100, 300, 800]) timers.push(setTimeout(() => sync(tag), ms));
  };
  const ro = new ResizeObserver(replace);
  ro.observe(area);
  window.addEventListener("resize", replace);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", replace);
    for (const t of timers) clearTimeout(t);
  };
}
