//! What the Record dialog and the recording panel show: small JPEG frames of a
//! camera or screen, and audio levels in dBFS.
use objc2::AllocAnyThread;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImageCompressionFactor};
use objc2_av_foundation::AVCaptureAudioDataOutput;
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRow, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDataBase64EncodingOptions, NSDictionary, NSNumber};
use serde_json::{Value, json};

const BGRA: u32 = u32::from_be_bytes(*b"BGRA");
const NV12_VIDEO: u32 = u32::from_be_bytes(*b"420v");
const NV12_FULL: u32 = u32::from_be_bytes(*b"420f");
const UYVY: u32 = u32::from_be_bytes(*b"2vuy");
const YUYV: u32 = u32::from_be_bytes(*b"yuvs");

/// BT.709 YCbCr to RGB, video or full range.
fn rgb(y: u8, cb: u8, cr: u8, full: bool) -> [u8; 3] {
    let y = if full { y as f32 } else { (y as f32 - 16.0) * 255.0 / 219.0 };
    let s = if full { 1.0 } else { 255.0 / 224.0 };
    let (cb, cr) = ((cb as f32 - 128.0) * s, (cr as f32 - 128.0) * s);
    let c = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    [c(y + 1.5748 * cr), c(y - 0.1873 * cb - 0.4681 * cr), c(y + 1.8556 * cb)]
}

/// A frame scaled to at most `max_width` (nearest pixel: it is a glance, not a picture), as RGB.
fn small_rgb(pb: &CVPixelBuffer, max_width: usize) -> Option<(Vec<u8>, usize, usize)> {
    let (w, h) = (CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb));
    if w == 0 || h == 0 {
        return None;
    }
    let ow = w.min(max_width);
    let oh = (h * ow / w).max(1);
    let format = CVPixelBufferGetPixelFormatType(pb);
    if ![BGRA, NV12_VIDEO, NV12_FULL, UYVY, YUYV].contains(&format) {
        return None;
    }
    if unsafe { CVPixelBufferLockBaseAddress(pb, CVPixelBufferLockFlags::ReadOnly) } != 0 {
        return None;
    }
    let mut out = vec![0u8; ow * oh * 3];
    let mut ok = true;
    for oy in 0..oh {
        let sy = oy * h / oh;
        for ox in 0..ow {
            let sx = ox * w / ow;
            let px = unsafe {
                match format {
                    BGRA => {
                        let base = CVPixelBufferGetBaseAddress(pb) as *const u8;
                        if base.is_null() {
                            ok = false;
                            break;
                        }
                        let p = base.add(sy * CVPixelBufferGetBytesPerRow(pb) + sx * 4);
                        [*p.add(2), *p.add(1), *p]
                    }
                    NV12_VIDEO | NV12_FULL => {
                        let (yp, cp) = (CVPixelBufferGetBaseAddressOfPlane(pb, 0) as *const u8, CVPixelBufferGetBaseAddressOfPlane(pb, 1) as *const u8);
                        if yp.is_null() || cp.is_null() {
                            ok = false;
                            break;
                        }
                        let y = *yp.add(sy * CVPixelBufferGetBytesPerRowOfPlane(pb, 0) + sx);
                        let c = cp.add((sy / 2) * CVPixelBufferGetBytesPerRowOfPlane(pb, 1) + (sx / 2) * 2);
                        rgb(y, *c, *c.add(1), format == NV12_FULL)
                    }
                    _ => {
                        let base = CVPixelBufferGetBaseAddress(pb) as *const u8;
                        if base.is_null() {
                            ok = false;
                            break;
                        }
                        // Two pixels share four bytes: Cb Y0 Cr Y1 (2vuy) or Y0 Cb Y1 Cr (yuvs).
                        let p = base.add(sy * CVPixelBufferGetBytesPerRow(pb) + (sx / 2) * 4);
                        let (b0, b1, b2, b3) = (*p, *p.add(1), *p.add(2), *p.add(3));
                        if format == UYVY { rgb(if sx % 2 == 0 { b1 } else { b3 }, b0, b2, false) } else { rgb(if sx % 2 == 0 { b0 } else { b2 }, b1, b3, false) }
                    }
                }
            };
            out[(oy * ow + ox) * 3..][..3].copy_from_slice(&px);
        }
        if !ok {
            break;
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(pb, CVPixelBufferLockFlags::ReadOnly) };
    ok.then_some((out, ow, oh))
}

/// Whether a camera's picture went black or froze while its frames kept coming (a capture card that lost its
/// camera's signal sends either): a 32-wide glance at a frame four times a second.
#[derive(Default)]
pub struct Picture {
    last: Option<Vec<u8>>,
    at: f64,
    black_since: Option<f64>,
    still_since: Option<f64>,
}

impl Picture {
    pub fn add(&mut self, buf: &CMSampleBuffer, now: f64) {
        if now - self.at < 0.25 {
            return;
        }
        self.at = now;
        let Some((px, _, _)) = unsafe { buf.image_buffer() }.and_then(|pb| small_rgb(&pb, 32)) else { return };
        let black = px.iter().all(|&v| v < 24);
        // A live camera's noise changes some of the glance every time; a repeated frame doesn't.
        let still = !black && self.last.as_ref() == Some(&px);
        self.black_since = if black { Some(self.black_since.unwrap_or(now)) } else { None };
        self.still_since = if still { Some(self.still_since.unwrap_or(now)) } else { None };
        self.last = Some(px);
    }

    /// "black" after a second of it, "frozen" after 1.5 s of the same picture, else nothing.
    pub fn state(&self, now: f64) -> Option<&'static str> {
        if self.black_since.is_some_and(|t| now - t >= 1.0) {
            Some("black")
        } else if self.still_since.is_some_and(|t| now - t >= 1.5) {
            Some("frozen")
        } else {
            None
        }
    }
}

/// A sample buffer's frame as base64 JPEG, at most `max_width` wide.
pub fn jpeg(buf: &CMSampleBuffer, max_width: usize) -> Option<String> {
    let pb = unsafe { buf.image_buffer() }?;
    let (mut rgb, w, h) = small_rgb(&pb, max_width)?;
    let mut planes = [rgb.as_mut_ptr()];
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            planes.as_mut_ptr(),
            w as isize,
            h as isize,
            8,
            3,
            false,
            false,
            NSDeviceRGBColorSpace,
            (w * 3) as isize,
            24,
        )
    }?;
    let quality = NSNumber::new_f64(0.7);
    let props = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[quality.as_ref() as &AnyObject]);
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props) }?;
    Some(data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string())
}

fn db(v: f64) -> f64 {
    if v > 0.0 { ((20.0 * v.log10()).max(-120.0) * 10.0).round() / 10.0 } else { -120.0 }
}

/// The level of float PCM buffers since it was last read: RMS and peak.
#[derive(Default)]
pub struct Meter {
    peak: f32,
    sum: f64,
    n: u64,
}

impl Meter {
    /// ScreenCaptureKit's audio: 32-bit float samples, however the channels are laid out.
    pub fn add_float(&mut self, buf: &CMSampleBuffer) {
        let Some(block) = (unsafe { buf.data_buffer() }) else { return };
        let (mut len, mut total, mut ptr) = (0usize, 0usize, std::ptr::null_mut());
        if unsafe { block.data_pointer(0, &mut len, &mut total, &mut ptr) } != 0 || ptr.is_null() {
            return;
        }
        let samples = unsafe { std::slice::from_raw_parts(ptr as *const f32, len / 4) };
        for &s in samples {
            let a = s.abs();
            if a.is_finite() {
                self.peak = self.peak.max(a);
                self.sum += (a * a) as f64;
                self.n += 1;
            }
        }
    }

    /// `{db, peak}` since the last read; None when nothing arrived.
    pub fn read(&mut self) -> Option<Value> {
        if self.n == 0 {
            return None;
        }
        let level = json!({ "db": db((self.sum / self.n as f64).sqrt()), "peak": db(self.peak as f64) });
        *self = Meter::default();
        Some(level)
    }
}

/// A capture output's level from its connection, its loudest channel's average and peak: `{db, peak}`.
pub fn channel_level(output: &AVCaptureAudioDataOutput) -> Option<Value> {
    let mut level: Option<(f32, f32)> = None;
    for c in unsafe { output.connections() }.iter() {
        for ch in unsafe { c.audioChannels() }.iter() {
            let (avg, peak) = unsafe { (ch.averagePowerLevel(), ch.peakHoldLevel()) };
            level = Some(level.map_or((avg, peak), |(a, p)| (a.max(avg), p.max(peak))));
        }
    }
    let (avg, peak) = level?;
    let d = |v: f32| if v.is_finite() { ((v.max(-120.0) * 10.0).round() / 10.0) as f64 } else { -120.0 };
    Some(json!({ "db": d(avg), "peak": d(peak) }))
}
