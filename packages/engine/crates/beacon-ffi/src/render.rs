//! In-process rendering for interactive queries (`frame.at`, contact
//! sheets): one renderer per project stays alive so decoders stay warm.
//! Results are PNG bytes held by the handle until copied out.

use std::ffi::c_char;
use std::ptr;

use beacon_render::Renderer;
use beacon_render::scene::{Job, Scene};
use beacon_render::sources::{decode_png, png_bytes};

use crate::{guard, str_arg};

pub struct FfiRenderer {
    renderer: Renderer,
    width: u32,
    height: u32,
    result: Vec<u8>,
}

fn handle<'a>(h: *mut FfiRenderer) -> Result<&'a mut FfiRenderer, String> {
    unsafe { h.as_mut() }.ok_or_else(|| "handle is null".into())
}

/// Bilinear upscale of straight-alpha RGBA.
fn upscale(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    let (fx, fy) = (sw as f64 / dw as f64, sh as f64 / dh as f64);
    for y in 0..dh {
        let sy = ((y as f64 + 0.5) * fy - 0.5).clamp(0.0, (sh - 1) as f64);
        let (y0, ty) = (sy.floor() as u32, sy.fract());
        let y1 = (y0 + 1).min(sh - 1);
        for x in 0..dw {
            let sx = ((x as f64 + 0.5) * fx - 0.5).clamp(0.0, (sw - 1) as f64);
            let (x0, tx) = (sx.floor() as u32, sx.fract());
            let x1 = (x0 + 1).min(sw - 1);
            let at = |xx: u32, yy: u32, c: usize| src[((yy * sw + xx) * 4) as usize + c] as f64;
            let o = ((y * dw + x) * 4) as usize;
            for c in 0..4 {
                let top = at(x0, y0, c) * (1.0 - tx) + at(x1, y0, c) * tx;
                let bottom = at(x0, y1, c) * (1.0 - tx) + at(x1, y1, c) * tx;
                out[o + c] = (top * (1.0 - ty) + bottom * ty).round() as u8;
            }
        }
    }
    out
}

/// Area-average downscale of straight-alpha RGBA, or bilinear upscale when larger.
fn downscale(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if (dw, dh) == (sw, sh) {
        return src.to_vec();
    }
    if dw > sw || dh > sh {
        return upscale(src, sw, sh, dw, dh);
    }
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    let (fx, fy) = (sw as f64 / dw as f64, sh as f64 / dh as f64);
    for y in 0..dh {
        let (y0, y1) = ((y as f64 * fy) as u32, (((y + 1) as f64 * fy).ceil() as u32).min(sh));
        for x in 0..dw {
            let (x0, x1) = ((x as f64 * fx) as u32, (((x + 1) as f64 * fx).ceil() as u32).min(sw));
            let mut acc = [0u32; 4];
            for sy in y0..y1 {
                let row = (sy * sw * 4) as usize;
                for sx in x0..x1 {
                    let i = row + (sx * 4) as usize;
                    for c in 0..4 {
                        acc[c] += src[i + c] as u32;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)).max(1);
            let o = ((y * dw + x) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    out
}

fn size_for(fr: &FfiRenderer, width: u32) -> (u32, u32) {
    // Up to twice the canvas, for a still matching a large preview view.
    let w = if width == 0 { fr.width } else { width.min(fr.width * 2) };
    (w, ((fr.height as u64 * w as u64 + fr.width as u64 / 2) / fr.width as u64).max(1) as u32)
}

/// `job_json`: an beacon-render `Job` (its `output` is ignored).
///
/// # Safety
/// `job_json` must be a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_renderer_new(job_json: *const c_char) -> *mut FfiRenderer {
    guard(ptr::null_mut(), || {
        let job: Job = serde_json::from_str(str_arg(job_json)?).map_err(|e| format!("job: {e}"))?;
        let renderer = Renderer::new(&job).map_err(|e| e.to_string())?;
        Ok(Box::into_raw(Box::new(FfiRenderer { renderer, width: job.width, height: job.height, result: Vec::new() })))
    })
}

/// # Safety
/// `h` must come from `beacon_renderer_new` and not be freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_renderer_free(h: *mut FfiRenderer) {
    if !h.is_null() {
        drop(unsafe { Box::from_raw(h) });
    }
}

/// Renders one scene, scaled to `width` (0 = canvas width), as PNG; returns
/// its byte length, to copy with `beacon_renderer_result_copy`.
///
/// # Safety
/// `h` must be a live handle; `scene_json` a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_renderer_frame(h: *mut FfiRenderer, scene_json: *const c_char, width: u32) -> i64 {
    guard(-1, || {
        let fr = handle(h)?;
        let scene: Scene = serde_json::from_str(str_arg(scene_json)?).map_err(|e| format!("scene: {e}"))?;
        let px = fr.renderer.render(&scene).map_err(|e| e.to_string())?;
        let (w, hgt) = size_for(fr, width);
        let small = downscale(&px, fr.width, fr.height, w, hgt);
        fr.result = png_bytes(w, hgt, &small).map_err(|e| e.to_string())?;
        Ok(fr.result.len() as i64)
    })
}

/// Renders a JSON array of scenes into a grid of `columns`, each cell
/// `cell_width` wide, separated by `gap` black pixels, as PNG; returns its
/// byte length.
///
/// # Safety
/// `h` must be a live handle; `scenes_json` a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_renderer_sheet(h: *mut FfiRenderer, scenes_json: *const c_char, columns: u32, cell_width: u32, gap: u32) -> i64 {
    guard(-1, || {
        let fr = handle(h)?;
        let scenes: Vec<Scene> = serde_json::from_str(str_arg(scenes_json)?).map_err(|e| format!("scenes: {e}"))?;
        if scenes.is_empty() || columns == 0 {
            return Err("no scenes".into());
        }
        let (cw, ch) = size_for(fr, cell_width);
        let rows = (scenes.len() as u32).div_ceil(columns);
        let cols = columns.min(scenes.len() as u32);
        let span = |n: u32, cell: u32| n.checked_mul(cell).and_then(|v| v.checked_add((n - 1).checked_mul(gap)?));
        let (sw, sh) = span(cols, cw).zip(span(rows, ch)).ok_or("sheet is too large")?;
        let bytes = (sw as usize).checked_mul(sh as usize).and_then(|v| v.checked_mul(4)).ok_or("sheet is too large")?;
        let mut sheet = vec![0u8; bytes];
        for px in sheet.chunks_exact_mut(4) {
            px[3] = 255;
        }
        for (i, scene) in scenes.iter().enumerate() {
            let px = fr.renderer.render(scene).map_err(|e| format!("scene {i}: {e}"))?;
            let cell = downscale(&px, fr.width, fr.height, cw, ch);
            let (ox, oy) = ((i as u32 % columns) * (cw + gap), (i as u32 / columns) * (ch + gap));
            for y in 0..ch {
                let row = cw as usize * 4;
                let dst = ((oy + y) as usize * sw as usize + ox as usize) * 4;
                sheet[dst..dst + row].copy_from_slice(&cell[y as usize * row..(y as usize + 1) * row]);
            }
        }
        fr.result = png_bytes(sw, sh, &sheet).map_err(|e| e.to_string())?;
        Ok(fr.result.len() as i64)
    })
}

/// # Safety
/// `h` must be a live handle; `out` must have room for `cap` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_renderer_result_copy(h: *mut FfiRenderer, out: *mut u8, cap: usize) -> i32 {
    guard(-1, || {
        let fr = handle(h)?;
        if out.is_null() {
            return Err("output is null".into());
        }
        if cap < fr.result.len() {
            return Err("output is too small".into());
        }
        unsafe { ptr::copy_nonoverlapping(fr.result.as_ptr(), out, fr.result.len()) };
        Ok(0)
    })
}

thread_local! {
    static PASTED: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Pastes PNG `over` onto PNG `base` with its top-left at (`x`, `y`)
/// (clipped), as PNG; returns its byte length, to copy with `beacon_png_result_copy`.
///
/// # Safety
/// `base` and `over` must point to `base_len` and `over_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_png_paste(base: *const u8, base_len: usize, over: *const u8, over_len: usize, x: i32, y: i32) -> i64 {
    guard(-1, || {
        if base.is_null() || over.is_null() {
            return Err("image is null".into());
        }
        let b = decode_png(unsafe { std::slice::from_raw_parts(base, base_len) }, "base").map_err(|e| e.to_string())?;
        let o = decode_png(unsafe { std::slice::from_raw_parts(over, over_len) }, "overlay").map_err(|e| e.to_string())?;
        let mut px = b.data;
        for oy in 0..o.height as i64 {
            let ty = y as i64 + oy;
            if ty < 0 || ty >= b.height as i64 {
                continue;
            }
            for ox in 0..o.width as i64 {
                let tx = x as i64 + ox;
                if tx < 0 || tx >= b.width as i64 {
                    continue;
                }
                let s = ((oy * o.width as i64 + ox) * 4) as usize;
                let d = ((ty * b.width as i64 + tx) * 4) as usize;
                px[d..d + 4].copy_from_slice(&o.data[s..s + 4]);
            }
        }
        let out = png_bytes(b.width, b.height, &px).map_err(|e| e.to_string())?;
        let n = out.len() as i64;
        PASTED.with(|p| *p.borrow_mut() = out);
        Ok(n)
    })
}

/// # Safety
/// `out` must have room for `cap` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_png_result_copy(out: *mut u8, cap: usize) -> i32 {
    guard(-1, || {
        PASTED.with(|p| {
            let p = p.borrow();
            if out.is_null() || cap < p.len() {
                return Err("output is too small".into());
            }
            unsafe { ptr::copy_nonoverlapping(p.as_ptr(), out, p.len()) };
            Ok(0)
        })
    })
}
