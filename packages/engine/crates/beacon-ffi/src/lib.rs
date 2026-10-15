//! C ABI over the engine for `bun:ffi`. Handles are opaque pointers; bulk
//! numeric data is copied into caller-allocated typed arrays, metadata
//! comes back as JSON. On failure a function returns null / -1 and
//! `beacon_last_error` describes why.

use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use beacon_media::Trec;

mod audio;
mod preview;
mod render;

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn set_error(msg: impl Into<String>) {
    let msg = CString::new(msg.into().replace('\0', " ")).unwrap_or_default();
    LAST_ERROR.with(|e| *e.borrow_mut() = msg);
}

fn guard<T>(fallback: T, f: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            set_error(e);
            fallback
        }
        Err(_) => {
            set_error("panic in beacon-ffi");
            fallback
        }
    }
}

/// Callers guarantee `s` is null or NUL-terminated.
fn str_arg<'a>(s: *const c_char) -> Result<&'a str, String> {
    if s.is_null() {
        return Err("string is null".into());
    }
    unsafe { CStr::from_ptr(s) }.to_str().map_err(|_| "string is not UTF-8".into())
}

/// Where Beacon's own ffmpeg and ffprobe are; called once, before anything runs them.
///
/// # Safety
/// `dir` must be NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_set_tools_dir(dir: *const c_char) -> i32 {
    guard(-1, || {
        beacon_render::set_tools_dir(str_arg(dir)?.into());
        Ok(0)
    })
}

/// Valid until the next failing call on this thread.
#[unsafe(no_mangle)]
pub extern "C" fn beacon_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

/// # Safety
/// `s` must be a string returned by this library, freed only once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

/// Installed font families, a JSON array of names. Free the result with `beacon_string_free`.
#[unsafe(no_mangle)]
pub extern "C" fn beacon_font_families() -> *mut c_char {
    guard(ptr::null_mut(), || {
        let json = serde_json::to_string(&beacon_render::text::families()).map_err(|e| e.to_string())?;
        Ok(CString::new(json).map_err(|e| e.to_string())?.into_raw())
    })
}

/// A callout's text laid out as the renderer draws it (`TextSpec` JSON in, line layouts JSON out), for
/// placing a caret and selection over it. Free the result with `beacon_string_free`.
///
/// # Safety
/// `spec_json` must be a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_text_layout(spec_json: *const c_char) -> *mut c_char {
    guard(ptr::null_mut(), || {
        let spec: beacon_render::text::TextSpec = serde_json::from_str(str_arg(spec_json)?).map_err(|e| e.to_string())?;
        let lines = beacon_render::text::layout(&spec).map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
        Ok(CString::new(json).map_err(|e| e.to_string())?.into_raw())
    })
}

/// # Safety
/// `path` must be a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_open(path: *const c_char) -> *mut Trec {
    guard(ptr::null_mut(), || {
        let path = str_arg(path)?;
        let trec = Trec::open(path).map_err(|e| format!("{path}: {e}"))?;
        Ok(Box::into_raw(Box::new(trec)))
    })
}

/// # Safety
/// `h` must come from `beacon_trec_open` and not be closed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_close(h: *mut Trec) {
    if !h.is_null() {
        drop(unsafe { Box::from_raw(h) });
    }
}

/// Callers guarantee `h` is null or a live handle.
fn trec<'a>(h: *const Trec) -> Result<&'a Trec, String> {
    unsafe { h.as_ref() }.ok_or_else(|| "handle is null".into())
}

/// Free the result with `beacon_string_free`.
///
/// # Safety
/// `h` must come from `beacon_trec_open` and not be closed yet; the same holds
/// for every `beacon_trec_*` function below.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_info_json(h: *const Trec) -> *mut c_char {
    guard(ptr::null_mut(), || {
        let json = serde_json::to_string(trec(h)?).map_err(|e| e.to_string())?;
        Ok(CString::new(json).map_err(|e| e.to_string())?.into_raw())
    })
}

/// # Safety
/// See `beacon_trec_info_json`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_cursor_len(h: *const Trec) -> i64 {
    guard(-1, || Ok(trec(h)?.tscm.cursor.t.len() as i64))
}

/// # Safety
/// Each output must have room for `cap` elements.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_cursor_copy(h: *const Trec, t: *mut f64, x: *mut i32, y: *mut i32, cap: usize) -> i32 {
    guard(-1, || {
        let c = &trec(h)?.tscm.cursor;
        if t.is_null() || x.is_null() || y.is_null() {
            return Err("output is null".into());
        }
        if cap < c.t.len() {
            return Err("output is too small".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(c.t.as_ptr(), t, c.t.len());
            ptr::copy_nonoverlapping(c.x.as_ptr(), x, c.x.len());
            ptr::copy_nonoverlapping(c.y.as_ptr(), y, c.y.len());
        }
        Ok(0)
    })
}

/// # Safety
/// See `beacon_trec_info_json`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_buttons_len(h: *const Trec) -> i64 {
    guard(-1, || Ok(trec(h)?.tscm.buttons.t.len() as i64))
}

/// # Safety
/// Each output must have room for `cap` elements.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_buttons_copy(h: *const Trec, t: *mut f64, kind: *mut u32, cap: usize) -> i32 {
    guard(-1, || {
        let b = &trec(h)?.tscm.buttons;
        if t.is_null() || kind.is_null() {
            return Err("output is null".into());
        }
        if cap < b.t.len() {
            return Err("output is too small".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(b.t.as_ptr(), t, b.t.len());
            ptr::copy_nonoverlapping(b.kind.as_ptr(), kind, b.kind.len());
        }
        Ok(0)
    })
}

/// PNG byte length of the `i`th entry of `cursorImages` in the info JSON.
///
/// # Safety
/// See `beacon_trec_info_json`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_cursor_image_len(h: *const Trec, i: u32) -> i64 {
    guard(-1, || {
        let img = trec(h)?.tscm.cursor_images.get(i as usize).ok_or("cursor image out of range")?;
        Ok(img.png.len() as i64)
    })
}

/// # Safety
/// `out` must have room for `cap` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_trec_cursor_image_copy(h: *const Trec, i: u32, out: *mut u8, cap: usize) -> i32 {
    guard(-1, || {
        let img = trec(h)?.tscm.cursor_images.get(i as usize).ok_or("cursor image out of range")?;
        if out.is_null() {
            return Err("output is null".into());
        }
        if cap < img.png.len() {
            return Err("output is too small".into());
        }
        unsafe { ptr::copy_nonoverlapping(img.png.as_ptr(), out, img.png.len()) };
        Ok(0)
    })
}
