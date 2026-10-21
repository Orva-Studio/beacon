//! Remove Background's matte: each frame of a video stream segmented by Vision (the person white, the rest black) and
//! written as a grey H.264 movie at the stream's own frame times, so the renderer decodes it as it does any video
//! and a matte frame always answers the source frame shown with it.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus, AVFileTypeQuickTimeMovie, AVMediaTypeVideo, AVVideoAverageBitRateKey,
    AVVideoCodecKey, AVVideoCodecTypeH264, AVVideoCompressionPropertiesKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalKey, AVVideoWidthKey,
};
use objc2_core_media::CMTime;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddress, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRow, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool, CVPixelBufferUnlockBaseAddress,
    kCVPixelFormatType_32BGRA, kCVPixelFormatType_OneComponent8,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
use objc2_vision::{VNGeneratePersonSegmentationRequest, VNGeneratePersonSegmentationRequestQualityLevel, VNRequest, VNSequenceRequestHandler};

use crate::{Error, Result};

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferRelease(buf: *mut c_void);
}

/// '420v': 8-bit 4:2:0, video range.
const NV12: u32 = 0x3432_3076;
/// What Vision is shown: larger costs time and gains nothing (its accurate matte is 2016×1512 whatever it is given).
const LOOKED_AT: (u32, u32) = (1920, 1080);
/// The matte's own size at most: its edges are soft, so this is drawn over a 4K frame without showing.
pub const MATTE_SIZE: (u32, u32) = (1280, 720);
/// Times in the matte movie: fine enough to keep the source's own, whatever its timescale.
const TIMESCALE: i32 = 90_000;

struct Buffer(*mut CVPixelBuffer);

impl Buffer {
    fn new(width: u32, height: u32, format: u32) -> Result<Self> {
        let mut raw: *mut CVPixelBuffer = std::ptr::null_mut();
        if unsafe { CVPixelBufferCreate(None, width as usize, height as usize, format, None, NonNull::from(&mut raw)) } != 0 || raw.is_null() {
            return Err(Error::Output(format!("no {width}×{height} pixel buffer")));
        }
        Ok(Self(raw))
    }

    fn get(&self) -> &CVPixelBuffer {
        unsafe { &*self.0 }
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe { CVPixelBufferRelease(self.0.cast()) };
    }
}

/// Runs `f` with `buf`'s memory locked.
fn locked<T>(buf: &CVPixelBuffer, read_only: bool, f: impl FnOnce() -> T) -> T {
    let flags = if read_only { CVPixelBufferLockFlags::ReadOnly } else { CVPixelBufferLockFlags::empty() };
    unsafe { CVPixelBufferLockBaseAddress(buf, flags) };
    let r = f();
    unsafe { CVPixelBufferUnlockBaseAddress(buf, flags) };
    r
}

/// `size` shrunk to fit in `max`, keeping its shape, in even pixels (what 4:2:0 needs).
pub fn fit(size: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let k = (max.0 as f64 / size.0 as f64).min(max.1 as f64 / size.1 as f64).min(1.0);
    let even = |v: f64| ((v / 2.0).round() as u32).max(1) * 2;
    (even(size.0 as f64 * k), even(size.1 as f64 * k))
}

/// Vision's matte (one byte a pixel, any size and stride) resampled to `out` (`w`×`h`), bilinear.
fn resample(src: &[u8], sw: usize, sh: usize, stride: usize, out: &mut [u8], w: usize, h: usize) {
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * sh as f32 / h as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
        let (y0, ty) = (fy as usize, fy.fract());
        let y1 = (y0 + 1).min(sh - 1);
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * sw as f32 / w as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
            let (x0, tx) = (fx as usize, fx.fract());
            let x1 = (x0 + 1).min(sw - 1);
            let at = |yy: usize, xx: usize| src[yy * stride + xx] as f32;
            let top = at(y0, x0) * (1.0 - tx) + at(y0, x1) * tx;
            let bottom = at(y1, x0) * (1.0 - tx) + at(y1, x1) * tx;
            out[y * w + x] = (top * (1.0 - ty) + bottom * ty).round() as u8;
        }
    }
}

struct Writer {
    path: String,
    writer: Retained<AVAssetWriter>,
    input: Retained<AVAssetWriterInput>,
    adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
    size: (u32, u32),
}

fn dict(pairs: &[(&NSString, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let (keys, values): (Vec<&NSString>, Vec<&AnyObject>) = pairs.iter().copied().unzip();
    NSDictionary::from_slices(&keys, &values)
}

impl Writer {
    fn new(path: &str, size: (u32, u32)) -> Result<Self> {
        let _ = std::fs::remove_file(path);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let fail = |e: String| Error::Output(format!("{path}: {e}"));
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, AVFileTypeQuickTimeMovie.unwrap()) }.map_err(|e| fail(e.localizedDescription().to_string()))?;
        let num = |v: i64| NSNumber::new_i64(v);
        let input = unsafe {
            // A keyframe a second or so: the preview seeks in it as in its source.
            let (rate, keyframe) = (num((size.0 * size.1 * 4) as i64), num(30));
            let props = dict(&[(AVVideoAverageBitRateKey.unwrap(), rate.as_ref()), (AVVideoMaxKeyFrameIntervalKey.unwrap(), keyframe.as_ref())]);
            let settings = dict(&[
                (AVVideoCodecKey.unwrap(), AVVideoCodecTypeH264.unwrap().as_ref()),
                (AVVideoWidthKey.unwrap(), num(size.0 as i64).as_ref()),
                (AVVideoHeightKey.unwrap(), num(size.1 as i64).as_ref()),
                (AVVideoCompressionPropertiesKey.unwrap(), props.as_ref()),
            ]);
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(AVMediaTypeVideo.unwrap(), Some(&settings))
        };
        unsafe { input.setExpectsMediaDataInRealTime(false) };
        if !unsafe { writer.canAddInput(&input) } {
            return Err(fail("the encoder refused these settings".into()));
        }
        unsafe { writer.addInput(&input) };
        let attrs = dict(&[
            (&NSString::from_str("PixelFormatType"), num(NV12 as i64).as_ref()),
            (&NSString::from_str("Width"), num(size.0 as i64).as_ref()),
            (&NSString::from_str("Height"), num(size.1 as i64).as_ref()),
        ]);
        let adaptor = unsafe { AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(&input, Some(&attrs)) };
        if !unsafe { writer.startWriting() } {
            return Err(fail(unsafe { writer.error() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default()));
        }
        unsafe { writer.startSessionAtSourceTime(CMTime::new(0, TIMESCALE)) };
        Ok(Self { path: path.into(), writer, input, adaptor, size })
    }

    fn failed(&self) -> Error {
        Error::Output(format!("{}: {}", self.path, unsafe { self.writer.error() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "the encoder stopped".into())))
    }

    /// Appends `matte` (one byte a pixel, full range) as the frame at `time`: grey, its luma in video range.
    fn frame(&mut self, matte: &[u8], time: CMTime) -> Result<()> {
        let pool: Retained<CVPixelBufferPool> = unsafe { self.adaptor.pixelBufferPool() }.ok_or_else(|| self.failed())?;
        let mut raw: *mut CVPixelBuffer = std::ptr::null_mut();
        if unsafe { CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut raw)) } != 0 || raw.is_null() {
            return Err(Error::Output("no pixel buffer for the matte".into()));
        }
        let buffer = Buffer(raw);
        let (w, h) = (self.size.0 as usize, self.size.1 as usize);
        locked(buffer.get(), false, || unsafe {
            let (y, ys) = (CVPixelBufferGetBaseAddressOfPlane(buffer.get(), 0).cast::<u8>(), CVPixelBufferGetBytesPerRowOfPlane(buffer.get(), 0));
            for row in 0..h {
                let line = std::slice::from_raw_parts_mut(y.add(row * ys), w);
                for (o, m) in line.iter_mut().zip(&matte[row * w..(row + 1) * w]) {
                    *o = 16 + ((*m as u32 * 219 + 127) / 255) as u8;
                }
            }
            let (uv, uvs) = (CVPixelBufferGetBaseAddressOfPlane(buffer.get(), 1).cast::<u8>(), CVPixelBufferGetBytesPerRowOfPlane(buffer.get(), 1));
            for row in 0..h / 2 {
                std::ptr::write_bytes(uv.add(row * uvs), 128, w);
            }
        });
        // VideoToolbox takes frames as fast as it encodes them; wait for room rather than drop one.
        while !unsafe { self.input.isReadyForMoreMediaData() } {
            if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
                return Err(self.failed());
            }
            std::thread::sleep(Duration::from_micros(500));
        }
        if !unsafe { self.adaptor.appendPixelBuffer_withPresentationTime(buffer.get(), time) } {
            return Err(self.failed());
        }
        Ok(())
    }

    fn finish(self, end: CMTime) -> Result<()> {
        unsafe { self.input.markAsFinished() };
        unsafe { self.writer.endSessionAtSourceTime(end) };
        let (tx, rx) = mpsc::channel();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        rx.recv_timeout(Duration::from_secs(120)).map_err(|_| Error::Output(format!("{}: finishing timed out", self.path)))?;
        if unsafe { self.writer.status() } != AVAssetWriterStatus::Completed {
            return Err(self.failed());
        }
        Ok(())
    }
}

/// Makes the matte of `input`'s `stream`th video stream into `output`; `progress` hears each frame's time in
/// seconds. Returns the matte's size.
pub fn make(input: &str, stream: u32, output: &str, mut progress: impl FnMut(f64)) -> Result<(u32, u32)> {
    let mut dec = beacon_decode::Decoder::open(input, stream, true, 0).map_err(|e| Error::Source(e.to_string()))?;
    let size = dec.size();
    let (lw, lh) = fit(size, LOOKED_AT);
    let (mw, mh) = fit(size, MATTE_SIZE);
    let request = unsafe { VNGeneratePersonSegmentationRequest::new() };
    unsafe {
        request.setQualityLevel(VNGeneratePersonSegmentationRequestQualityLevel::Accurate);
        request.setOutputPixelFormat(kCVPixelFormatType_OneComponent8);
    }
    let requests = NSArray::<VNRequest>::from_slice(&[&***request]);
    // One handler for the whole stream: Vision keeps what it learnt of the frames before, for steadier edges.
    let handler = unsafe { VNSequenceRequestHandler::new() };
    let looked = Buffer::new(lw, lh, kCVPixelFormatType_32BGRA)?;
    let mut rgba = vec![0u8; (lw * lh * 4) as usize];
    let mut matte = vec![0u8; (mw * mh) as usize];
    let mut writer = Writer::new(output, (mw, mh))?;
    let (mut last, mut step) = (f64::NEG_INFINITY, 1.0 / 30.0);
    while let beacon_decode::Next::Frame(pts) = dec.next().map_err(|e| Error::Source(e.to_string()))? {
        // A frame at or before the last one's time can't follow it in the movie: the one before stands for it.
        if pts <= last {
            continue;
        }
        if last.is_finite() {
            step = pts - last;
        }
        last = pts;
        dec.rgba(&mut rgba, lw, lh).map_err(|e| Error::Source(e.to_string()))?;
        locked(looked.get(), false, || unsafe {
            let (base, stride) = (CVPixelBufferGetBaseAddress(looked.get()).cast::<u8>(), CVPixelBufferGetBytesPerRow(looked.get()));
            for row in 0..lh as usize {
                let line = std::slice::from_raw_parts_mut(base.add(row * stride), lw as usize * 4);
                for (o, i) in line.as_chunks_mut::<4>().0.iter_mut().zip(rgba[row * lw as usize * 4..].as_chunks::<4>().0) {
                    *o = [i[2], i[1], i[0], i[3]];
                }
            }
        });
        unsafe { handler.performRequests_onCVPixelBuffer_error(&requests, looked.get()) }.map_err(|e| Error::Source(format!("Vision: {}", e.localizedDescription())))?;
        let result = unsafe { request.results() }.and_then(|r| r.firstObject()).ok_or_else(|| Error::Source("Vision found no matte".into()))?;
        let mask = unsafe { result.pixelBuffer() };
        locked(&mask, true, || unsafe {
            let (sw, sh, stride) = (CVPixelBufferGetWidth(&mask), CVPixelBufferGetHeight(&mask), CVPixelBufferGetBytesPerRow(&mask));
            let src = std::slice::from_raw_parts(CVPixelBufferGetBaseAddress(&mask).cast::<u8>(), stride * sh);
            resample(src, sw, sh, stride, &mut matte, mw as usize, mh as usize);
        });
        writer.frame(&matte, unsafe { CMTime::new((pts * TIMESCALE as f64).round() as i64, TIMESCALE) })?;
        progress(pts);
    }
    if !last.is_finite() {
        return Err(Error::Source(format!("{input}: no frames")));
    }
    writer.finish(unsafe { CMTime::new(((last + step) * TIMESCALE as f64).round() as i64, TIMESCALE) })?;
    Ok((mw, mh))
}
