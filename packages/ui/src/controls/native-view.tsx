import { useEffect, useState, type CSSProperties, type RefObject } from "react";

export type NativeTag = HTMLElement & { wgpuViewId: number | null; on: (e: "ready", f: () => void) => void };

/**
 * A native GPU view the main process renders into (`<electrobun-wgpu>`): reports its id, box (CSS
 * pixels) and display scale once ready and whenever they change. `masks`: elements cut out of it.
 */
export function NativeView({
  tagRef,
  onReport,
  style,
  masks,
  passthrough,
}: {
  tagRef: RefObject<NativeTag | null>;
  onReport: (id: number, rect: { x: number; y: number; width: number; height: number }, scale: number) => void;
  style: CSSProperties;
  masks?: string;
  passthrough?: boolean;
}) {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => {
    const el = tagRef.current;
    if (!el) return;
    const ready = () => setId(el.wgpuViewId);
    if (el.wgpuViewId !== null) ready();
    else el.on("ready", ready);
  }, [tagRef]);
  useEffect(() => {
    const el = tagRef.current;
    if (!el || id === null) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      onReport(id, { x: r.x, y: r.y, width: r.width, height: r.height }, window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    // Moving to a display with another scale changes no CSS size; listen for the scale itself.
    let dpr: MediaQueryList | undefined;
    const watchScale = () => {
      dpr?.removeEventListener("change", onScale);
      dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dpr.addEventListener("change", onScale);
    };
    const onScale = () => {
      report();
      watchScale();
    };
    watchScale();
    return () => {
      ro.disconnect();
      dpr?.removeEventListener("change", onScale);
    };
    // onReport is read fresh through the closure each time the effect reruns; it changes with what it reports to.
  }, [id, onReport, tagRef]);
  return <electrobun-wgpu ref={tagRef} {...(passthrough ? { passthrough: true } : {})} {...(masks ? { masks } : {})} style={style} />;
}
