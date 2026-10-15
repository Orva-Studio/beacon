import { dlopen, FFIType, CString, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolsDir } from "./tool";

const symbols = {
  beacon_set_tools_dir: { args: [FFIType.ptr], returns: FFIType.i32 },
  beacon_last_error: { args: [], returns: FFIType.ptr },
  beacon_string_free: { args: [FFIType.ptr], returns: FFIType.void },
  beacon_font_families: { args: [], returns: FFIType.ptr },
  beacon_text_layout: { args: [FFIType.ptr], returns: FFIType.ptr },
  beacon_trec_open: { args: [FFIType.ptr], returns: FFIType.ptr },
  beacon_trec_close: { args: [FFIType.ptr], returns: FFIType.void },
  beacon_trec_info_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  beacon_trec_cursor_len: { args: [FFIType.ptr], returns: FFIType.i64 },
  beacon_trec_cursor_copy: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_trec_buttons_len: { args: [FFIType.ptr], returns: FFIType.i64 },
  beacon_trec_buttons_copy: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_trec_cursor_image_len: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
  beacon_trec_cursor_image_copy: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_renderer_new: { args: [FFIType.ptr], returns: FFIType.ptr },
  beacon_renderer_free: { args: [FFIType.ptr], returns: FFIType.void },
  beacon_renderer_frame: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
  beacon_renderer_sheet: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i64 },
  beacon_renderer_result_copy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_png_paste: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32], returns: FFIType.i64 },
  beacon_png_result_copy: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_preview_new: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
  beacon_preview_offscreen: { args: [FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
  beacon_preview_submit: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  beacon_preview_preroll: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  beacon_preview_proxies: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  beacon_preview_resize: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  beacon_preview_place: { args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
  beacon_preview_surround: { args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
  beacon_preview_marks: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  beacon_preview_flush: { args: [FFIType.ptr], returns: FFIType.i64 },
  beacon_preview_result_copy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  beacon_preview_stats_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  beacon_preview_free: { args: [FFIType.ptr], returns: FFIType.void },
  beacon_audio_new: { args: [], returns: FFIType.ptr },
  beacon_audio_rate: { args: [FFIType.ptr], returns: FFIType.i32 },
  beacon_audio_play: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64], returns: FFIType.i32 },
  beacon_audio_time: { args: [FFIType.ptr], returns: FFIType.f64 },
  beacon_audio_halt: { args: [FFIType.ptr], returns: FFIType.f64 },
  beacon_audio_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
  beacon_audio_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type Engine = ReturnType<typeof dlopen<typeof symbols>>["symbols"];

let engine: Engine | undefined;

/** Beside a compiled binary (`bun run build:mcp`), else the engine's build output. */
export function enginePath(name: string): string {
  // From source, execPath is the bun binary; only a compiled binary has the engine beside it.
  if (import.meta.dir.startsWith("/$bunfs")) return join(dirname(process.execPath), name);
  return join(import.meta.dir, "../../engine/target/release", name);
}

/** `BEACON_FFI_PATH` overrides the dylib location (e.g. inside the app bundle). */
function libraryPath(): string {
  const path = process.env.BEACON_FFI_PATH ?? enginePath("libbeacon_ffi.dylib");
  if (!existsSync(path)) {
    throw new Error(`beacon-ffi library not found at ${path}; run \`bun run build:engine\``);
  }
  return path;
}

export function loadEngine(): Engine {
  if (!engine) {
    const e = dlopen(libraryPath(), symbols).symbols;
    checkStatus(e, e.beacon_set_tools_dir(Buffer.from(`${toolsDir()}\0`)));
    engine = e;
  }
  return engine;
}

export function lastError(e: Engine): string {
  const p = pointer(e.beacon_last_error());
  return p ? new CString(p).toString() : "unknown engine error";
}

/** bun:ffi types pointer returns as `Pointer | bigint`; on arm64 macOS they always fit a number. */
export function pointer(p: Pointer | bigint | null): Pointer | null {
  return typeof p === "bigint" ? (Number(p) as Pointer) : p;
}

export function takeString(e: Engine, raw: Pointer | bigint | null): string {
  const p = pointer(raw);
  if (!p) throw new Error(lastError(e));
  try {
    return new CString(p).toString();
  } finally {
    e.beacon_string_free(p);
  }
}

export function checkLen(e: Engine, n: number | bigint): number {
  const len = Number(n);
  if (len < 0) throw new Error(lastError(e));
  return len;
}

export function checkStatus(e: Engine, status: number): void {
  if (status !== 0) throw new Error(lastError(e));
}
