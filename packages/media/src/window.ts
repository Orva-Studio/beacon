import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyOut, loadEngine } from "./engine";
import { runTool } from "./tool";

let objc: ReturnType<typeof open> | undefined;

function open() {
  return dlopen("/usr/lib/libobjc.A.dylib", {
    sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
  }).symbols;
}

/** The window server's id for an `NSWindow` (`-[NSWindow windowNumber]`), as `screencapture -l` wants. */
export function windowNumber(nsWindow: Pointer): number {
  objc ??= open();
  const sel = objc.sel_registerName(Buffer.from("windowNumber\0"));
  return Number(objc.objc_msgSend(nsWindow, sel));
}

/** Gives the page in an `NSWindow` the keys when the canvas's native view took them as the window became key. */
export function focusPage(nsWindow: Pointer): void {
  loadEngine().beacon_focus_page(nsWindow);
}

/** PNG of one window, including native views inside it, without its shadow. */
export async function captureWindow(windowId: number): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-shot-"));
  try {
    const file = join(dir, "window.png");
    await runTool(["/usr/sbin/screencapture", "-x", "-o", `-l${windowId}`, file]);
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** PNG `over` pasted onto PNG `base` with its top-left at (x, y), clipped to `base`. */
export function pastePng(base: Uint8Array, over: Uint8Array, x: number, y: number): Uint8Array {
  const e = loadEngine();
  return copyOut(e, e.beacon_png_paste(base, base.length, over, over.length, Math.round(x), Math.round(y)), (out, cap) => e.beacon_png_result_copy(out, cap));
}
