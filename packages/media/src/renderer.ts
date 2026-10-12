import type { Pointer } from "bun:ffi";
import { checkLen, checkStatus, lastError, loadEngine, pointer } from "./engine";

/** beacon-render loaded in-process: scenes in, PNG bytes out. Keeps decoders warm between calls. */
export class NativeRenderer {
  #handle: Pointer | null;

  constructor(jobJson: string) {
    const e = loadEngine();
    this.#handle = pointer(e.beacon_renderer_new(Buffer.from(`${jobJson}\0`)));
    if (!this.#handle) throw new Error(lastError(e));
  }

  /** One scene as PNG, `width` pixels wide (0 = canvas width). */
  frame(sceneJson: string, width: number): Uint8Array {
    const e = loadEngine();
    return this.#take(checkLen(e, e.beacon_renderer_frame(this.#live(), Buffer.from(`${sceneJson}\0`), width)));
  }

  /** Scenes tiled `columns` wide, each cell `width` pixels wide, as one PNG. */
  sheet(scenesJson: string, columns: number, width: number, gap: number): Uint8Array {
    const e = loadEngine();
    return this.#take(checkLen(e, e.beacon_renderer_sheet(this.#live(), Buffer.from(`${scenesJson}\0`), columns, width, gap)));
  }

  close(): void {
    if (this.#handle) loadEngine().beacon_renderer_free(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    checkStatus(loadEngine(), loadEngine().beacon_renderer_result_copy(this.#live(), out, n));
    return out;
  }

  #live() {
    if (!this.#handle) throw new Error("renderer is closed");
    return this.#handle;
  }
}
