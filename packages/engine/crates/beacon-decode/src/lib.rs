//! One video stream decoded in process (libavformat/libavcodec through a small
//! C shim), kept open between seeks: no process to start per jump.

use std::ffi::{CString, c_char, c_int, c_void};

unsafe extern "C" {
    fn otd_open(path: *const c_char, nth: c_int, hw: c_int, threads: c_int, err: *mut c_char, errlen: c_int) -> *mut c_void;
    fn otd_seek(d: *mut c_void, seconds: f64) -> c_int;
    fn otd_next(d: *mut c_void, pts: *mut f64) -> c_int;
    fn otd_size(d: *mut c_void, width: *mut c_int, height: *mut c_int);
    fn otd_rgba(d: *mut c_void, out: *mut u8, width: c_int, height: c_int, stride: c_int) -> c_int;
    fn otd_close(d: *mut c_void);
    fn otd_rgba_of(d: *mut c_void, f: *mut c_void, out: *mut u8, width: c_int, height: c_int, stride: c_int) -> c_int;
    fn otd_keep(d: *mut c_void, bytes: *mut usize) -> *mut c_void;
    fn otd_drop(f: *mut c_void);
}

/// A decoded frame kept for later (a reference: no pixels are copied).
pub struct Kept {
    raw: *mut c_void,
    pub bytes: usize,
}

unsafe impl Send for Kept {}

impl Drop for Kept {
    fn drop(&mut self) {
        unsafe { otd_drop(self.raw) };
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);

pub struct Decoder {
    raw: *mut c_void,
    path: String,
}

// The shim's state is owned by this handle and used from one thread at a time.
unsafe impl Send for Decoder {}

/// How `otd_open` decodes; the shim's `otd_mode` has the same values.
#[repr(i32)]
#[derive(Clone, Copy)]
enum Mode {
    Software = 0,
    /// VideoToolbox as FFmpeg drives it.
    Hardware = 1,
    /// VideoToolbox driven by the shim (H.264/HEVC; other codecs as `Hardware`).
    Native = 2,
}

pub enum Next {
    Frame(f64),
    End,
}

impl Decoder {
    /// `nth`: the nth video stream. `hardware`: VideoToolbox where the codec has it, as FFmpeg drives it (frames identical to the ffmpeg command line's).
    pub fn open(path: &str, nth: u32, hardware: bool, threads: u32) -> Result<Self, Error> {
        Self::open_with(path, nth, if hardware { Mode::Hardware } else { Mode::Software }, threads)
    }

    /// For the preview: H.264/HEVC decoded natively by VideoToolbox, a seek's frames in parallel on the
    /// media engine, then converted with swscale as `open`'s are (identical: tests/matches_ffmpeg.rs);
    /// other codecs as `open` with hardware decoding.
    pub fn open_native(path: &str, nth: u32) -> Result<Self, Error> {
        Self::open_with(path, nth, Mode::Native, 4)
    }

    fn open_with(path: &str, nth: u32, mode: Mode, threads: u32) -> Result<Self, Error> {
        let c = CString::new(path).map_err(|_| Error(format!("{path}: bad path")))?;
        let mut err = [0 as c_char; 256];
        let raw = unsafe { otd_open(c.as_ptr(), nth as c_int, mode as c_int, threads as c_int, err.as_mut_ptr(), err.len() as c_int) };
        if raw.is_null() {
            let msg = unsafe { std::ffi::CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned();
            return Err(Error(format!("{path}: {msg}")));
        }
        Ok(Self { raw, path: path.to_string() })
    }

    /// Continues from the keyframe at or before `seconds`.
    pub fn seek(&mut self, seconds: f64) -> Result<(), Error> {
        match unsafe { otd_seek(self.raw, seconds) } {
            0 => Ok(()),
            r => Err(Error(format!("{}: seek to {seconds}: {r}", self.path))),
        }
    }

    pub fn next(&mut self) -> Result<Next, Error> {
        let mut pts = 0.0;
        match unsafe { otd_next(self.raw, &mut pts) } {
            0 => Ok(Next::Frame(pts)),
            1 => Ok(Next::End),
            r => Err(Error(format!("{}: decode: {r}", self.path))),
        }
    }

    pub fn size(&self) -> (u32, u32) {
        let (mut w, mut h) = (0, 0);
        unsafe { otd_size(self.raw, &mut w, &mut h) };
        (w as u32, h as u32)
    }

    /// The last frame as RGBA at `width`×`height`, tightly packed.
    pub fn rgba(&mut self, out: &mut [u8], width: u32, height: u32) -> Result<(), Error> {
        assert!(out.len() >= (width * height * 4) as usize);
        match unsafe { otd_rgba(self.raw, out.as_mut_ptr(), width as c_int, height as c_int, (width * 4) as c_int) } {
            0 => Ok(()),
            r => Err(Error(format!("{}: convert: {r}", self.path))),
        }
    }
}

impl Decoder {
    /// Keeps the last decoded frame.
    pub fn keep(&mut self) -> Option<Kept> {
        let mut bytes = 0;
        let raw = unsafe { otd_keep(self.raw, &mut bytes) };
        (!raw.is_null()).then_some(Kept { raw, bytes })
    }

    /// A kept frame as RGBA at `width`×`height`, tightly packed.
    pub fn rgba_of(&mut self, kept: &Kept, out: &mut [u8], width: u32, height: u32) -> Result<(), Error> {
        assert!(out.len() >= (width * height * 4) as usize);
        match unsafe { otd_rgba_of(self.raw, kept.raw, out.as_mut_ptr(), width as c_int, height as c_int, (width * 4) as c_int) } {
            0 => Ok(()),
            r => Err(Error(format!("{}: convert: {r}", self.path))),
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { otd_close(self.raw) };
    }
}
