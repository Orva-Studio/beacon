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
mod focus;
mod preview;
mod render;

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn set_error(msg: impl Into<String>) {
    let msg = CString::new(msg.into().replace('\0', " ")).unwrap_or_default();
    LAST_ERROR.with(|e| *e.borrow_mut() = msg);
}

/// What a caught panic said, when it said anything.
fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "unknown".into())
}

/// Runs `f`, turning a panic into an error: `Err(context: message)`.
fn caught<T>(context: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|p| Err(format!("{context}: {}", panic_message(&*p))))
}

fn guard<T>(fallback: T, f: impl FnOnce() -> Result<T, String>) -> T {
    caught("panic in beacon-ffi", f).unwrap_or_else(|e| {
        set_error(e);
        fallback
    })
}

/// Copies `data` into the caller's buffer of `cap` elements.
///
/// # Safety
/// `out` must be null or have room for `cap` elements.
unsafe fn copy_out<T: Copy>(data: &[T], out: *mut T, cap: usize) -> Result<i32, String> {
    if out.is_null() {
        return Err("output is null".into());
    }
    if cap < data.len() {
        return Err("output is too small".into());
    }
    unsafe { ptr::copy_nonoverlapping(data.as_ptr(), out, data.len()) };
    Ok(0)
}

/// A string for the caller, who frees it with `beacon_string_free`.
fn c_string(s: String) -> Result<*mut c_char, String> {
    Ok(CString::new(s).map_err(|e| e.to_string())?.into_raw())
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
        c_string(json)
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
        c_string(json)
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
        c_string(json)
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
        unsafe {
            copy_out(&c.t, t, cap)?;
            copy_out(&c.x, x, cap)?;
            copy_out(&c.y, y, cap)
        }
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
        unsafe {
            copy_out(&b.t, t, cap)?;
            copy_out(&b.kind, kind, cap)
        }
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
        unsafe { copy_out(&img.png, out, cap) }
    })
}
