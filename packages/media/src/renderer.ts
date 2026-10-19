import type { Pointer } from "bun:ffi";
import { copyOut, cstr, lastError, loadEngine, pointer } from "./engine";

/** beacon-render loaded in-process: scenes in, PNG bytes out. Keeps decoders warm between calls. */
export class NativeRenderer {
  #handle: Pointer | null;

  constructor(jobJson: string) {
    const e = loadEngine();
    this.#handle = pointer(e.beacon_renderer_new(cstr(jobJson)));
    if (!this.#handle) throw new Error(lastError(e));
  }

  /** One scene as PNG, `width` pixels wide (0 = canvas width). */
  frame(sceneJson: string, width: number): Uint8Array {
    const e = loadEngine();
    return this.#take(e.beacon_renderer_frame(this.#live(), cstr(sceneJson), width));
  }

  /** Scenes tiled `columns` wide, each cell `width` pixels wide, as one PNG. */
  sheet(scenesJson: string, columns: number, width: number, gap: number): Uint8Array {
    const e = loadEngine();
    return this.#take(e.beacon_renderer_sheet(this.#live(), cstr(scenesJson), columns, width, gap));
  }

  close(): void {
    if (this.#handle) loadEngine().beacon_renderer_free(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #take(len: number | bigint): Uint8Array {
    const e = loadEngine();
    return copyOut(e, len, (out, cap) => e.beacon_renderer_result_copy(this.#live(), out, cap));
  }

  #live() {
    if (!this.#handle) throw new Error("renderer is closed");
    return this.#handle;
  }
}
