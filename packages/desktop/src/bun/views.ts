import type { Pointer } from "bun:ffi";
import { WGPUView } from "electrobun/main";
import type { LiveView, Session } from "@beacon/core";
import { enginePlacement, fitPercent, placeCanvas } from "@beacon/model";
import type { CanvasMark } from "@beacon/ui";
import type { App, Rect } from "./app";

/** Marks' sizes are points; the native view draws in physical pixels. */
function scaledMarks(marks: CanvasMark[], scale: number) {
  return marks.map((m) => (m.kind === "line" ? { ...m, width: m.width * scale } : { ...m, radius: m.radius * scale, width: m.width * scale }));
}

/** The window's native views: the project's canvas, and the Media Bin's preview of one asset. */
export function createViews(app: App) {
  const { core, message } = app;
  /** The selection, handles and guides the window last asked the canvas to draw. */
  let lastMarks: CanvasMark[] = [];
  /** The window's colour around the canvas, for previews made after it was sent. */
  let lastSurround: [number, number, number] | undefined;

  /** The session's canvas zoom and pan, placed in the native view (physical pixels) as the overlay places it in points. */
  function placement(c: Session["canvas"], view: { rect: { width: number; height: number }; scale: number }): [number, number, number] {
    const canvas = core.doc(app.current()!.path).settings;
    const px = { width: Math.max(1, Math.round(view.rect.width * view.scale)), height: Math.max(1, Math.round(view.rect.height * view.scale)) };
    return enginePlacement(canvas, px, placeCanvas(canvas, px, c.zoom, c.pan ?? [0, 0], view.scale));
  }

  /** The canvas zoomed or panned. */
  function place(canvas: Session["canvas"]) {
    const current = app.current();
    const live = current && core.view(current.path);
    if (current?.view && live) live.place(...placement(canvas, current.view));
  }

  /** Attaches the project's preview to the canvas's native view, or follows its new size; returns the fit zoom in percent. */
  async function canvasView(id: number, rect: Rect, scale: number, from?: { surround?: [number, number, number] }): Promise<number> {
    // Sent by the window with each report of its view; a switch of project reattaches with the last one.
    if (from) lastSurround = from.surround;
    const current = app.current();
    if (!current) return 100;
    const w = Math.max(1, Math.round(rect.width * scale));
    const h = Math.max(1, Math.round(rect.height * scale));
    if (current.view?.id !== id) {
      const native = WGPUView.getById(id);
      const layer = native?.getNativeHandle() as Pointer | null;
      if (!native || !layer) throw new Error(`no native view ${id}`);
      const live = core.attachView(current.path, { layer, width: w, height: h });
      current.view = { id, scale, rect };
      // The window sends marks only when they change; a new preview starts from the last ones.
      live.marks(scaledMarks(lastMarks, scale));
      if (lastSurround) live.surround(...lastSurround);
      // Stop drawing before Electrobun takes the view away (the canvas element remounted or the page reloaded).
      native.onBeforeRemove(() => {
        const now = app.current();
        if (now?.view?.id !== id) return;
        core.detachView(now.path);
        now.view = undefined;
      });
    } else {
      current.view.scale = scale;
      current.view.rect = rect;
      core.view(current.path)?.resize(w, h);
    }
    // Fitted placement depends on the view's size, so it is resent whenever the view changes.
    core.view(current.path)?.place(...placement((await core.session(current.path)).canvas, current.view));
    const percent = Math.round(fitPercent(core.doc(current.path).settings, rect));
    core.setFitPercent(current.path, percent);
    return percent;
  }

  /** Positions are canvas pixels; sizes are points, drawn in physical pixels. */
  function marks(next: CanvasMark[]) {
    lastMarks = next;
    const current = app.current();
    if (current?.view) core.view(current.path)?.marks(scaledMarks(next, current.view.scale));
  }

  /** The Media Bin preview: the asset, and its view once the window's native view is up. */
  let preview: { asset: string; id?: number; live?: LiveView } | undefined;

  function closePreview() {
    const live = preview?.live;
    preview = undefined;
    if (!live) return;
    // Silence it now; freeing the renderer waits for its thread and decoders, so the window updates first.
    live.pause();
    setTimeout(() => live.close(), 100);
  }

  function previewOpen(asset: string) {
    closePreview();
    const current = app.current();
    if (!current) return null;
    void core.run(current.path, "playback.pause", {});
    preview = { asset };
    return core.assetPreviewInfo(current.path, asset);
  }

  function previewView(id: number, rect: Rect, scale: number) {
    const current = app.current();
    if (!current || !preview) return;
    const px = { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
    if (preview.id !== id) {
      const native = WGPUView.getById(id);
      const layer = native?.getNativeHandle() as Pointer | null;
      if (!native || !layer) throw new Error(`no native view ${id}`);
      preview.live?.close();
      let last = 0;
      const live = core.previewAsset(current.path, preview.asset, { layer, ...px }, {
        onTime: (t) => message("previewClock", { time: (last = t), playing: live.playing }),
        onEnd: () => message("previewClock", { time: last, playing: false }),
      });
      Object.assign(preview, { id, live });
      native.onBeforeRemove(() => {
        if (preview?.id === id) closePreview();
      });
    } else preview.live?.resize(px.width, px.height);
    const settings = core.assetPreviewInfo(current.path, preview.asset);
    const canvas = { width: settings.width, height: settings.height };
    preview.live?.place(...enginePlacement(canvas, px, placeCanvas(canvas, px, "fit", [0, 0], scale)));
    if (lastSurround) preview.live?.surround(...lastSurround);
  }

  function previewControl(op: "play" | "pause" | "seek" | "close", time = 0) {
    const live = preview?.live;
    if (op === "close") return closePreview();
    if (!live) return;
    if (op === "play") return live.play(time);
    // A seek while playing carries on from there.
    const playing = live.playing;
    live.pause();
    if (op === "seek" && playing) return live.play(time);
    message("previewClock", { time: op === "seek" ? live.show(time) : time, playing: false });
  }

  return { place, canvasView, marks, previewOpen, previewView, previewControl };
}
