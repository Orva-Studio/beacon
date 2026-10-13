//! The Record dialog's preview: the chosen camera as small JPEG frames and the
//! microphone's level, from an AVCaptureSession that writes nothing.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImageCompressionFactor};
use objc2_av_foundation::{
    AVCaptureAudioDataOutput, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
    AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeAudio, AVMediaTypeVideo,
};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDataBase64EncodingOptions, NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};
use serde_json::{Value, json};

use crate::capture::{Device, device};

/// Frames are this wide, at most this many a second: enough to frame a shot, small on the pipe.
const WIDTH: i64 = 320;
const FPS: f64 = 15.0;

struct PreviewIvars {
    last: Mutex<Option<Instant>>,
    emit: Box<dyn Fn(Value) + Send + Sync>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BeaconRecorderPreviewOutput"]
    #[ivars = PreviewIvars]
    struct PreviewOutput;

    unsafe impl NSObjectProtocol for PreviewOutput {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for PreviewOutput {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(&self, _output: &AVCaptureOutput, buf: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            let iv = self.ivars();
            {
                let mut last = iv.last.lock().unwrap();
                if last.is_some_and(|l| l.elapsed() < Duration::from_secs_f64(1.0 / FPS)) {
                    return;
                }
                *last = Some(Instant::now());
            }
            if let Some(jpeg) = jpeg(buf) {
                (iv.emit)(json!({ "event": "previewFrame", "jpeg": jpeg }));
            }
        }
    }

    unsafe impl AVCaptureAudioDataOutputSampleBufferDelegate for PreviewOutput {}
);

/// A BGRA frame as base64 JPEG.
fn jpeg(buf: &CMSampleBuffer) -> Option<String> {
    let pb = unsafe { buf.image_buffer() }?;
    if unsafe { CVPixelBufferLockBaseAddress(&pb, CVPixelBufferLockFlags::ReadOnly) } != 0 {
        return None;
    }
    let (w, h, stride) = (CVPixelBufferGetWidth(&pb), CVPixelBufferGetHeight(&pb), CVPixelBufferGetBytesPerRow(&pb));
    let base = CVPixelBufferGetBaseAddress(&pb) as *const u8;
    let mut rgb = vec![0u8; w * h * 3];
    if !base.is_null() {
        let src = unsafe { std::slice::from_raw_parts(base, stride * h) };
        for y in 0..h {
            for x in 0..w {
                let (s, d) = (y * stride + x * 4, (y * w + x) * 3);
                rgb[d..d + 3].copy_from_slice(&[src[s + 2], src[s + 1], src[s]]);
            }
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&pb, CVPixelBufferLockFlags::ReadOnly) };
    if base.is_null() {
        return None;
    }
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

/// A camera and microphone being previewed; dropping it stops them.
pub struct Preview {
    session: Retained<AVCaptureSession>,
    _out: Retained<PreviewOutput>,
    _queue: dispatch2::DispatchRetained<DispatchQueue>,
    audio: Option<Retained<AVCaptureAudioDataOutput>>,
}

impl Preview {
    /// `emit` gets each frame's event, on a capture queue.
    pub fn start(camera: Option<&Device>, microphone: Option<&Device>, emit: impl Fn(Value) + Send + Sync + 'static) -> Result<Preview, String> {
        let (video_type, audio_type) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
        let out = PreviewOutput::alloc().set_ivars(PreviewIvars { last: Mutex::new(None), emit: Box::new(emit) });
        let out: Retained<PreviewOutput> = unsafe { msg_send![super(out), init] };
        let queue = DispatchQueue::new("beacon.record.preview", None);
        let session = unsafe { AVCaptureSession::new() };
        let mut audio = None;
        unsafe { session.beginConfiguration() };
        let configured = (|| -> Result<(), String> {
            if let Some(want) = camera {
                let dev = device(video_type, want, "camera")?;
                let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&dev) }.map_err(|e| format!("camera: {}", e.localizedDescription()))?;
                let output = unsafe { AVCaptureVideoDataOutput::new() };
                unsafe { output.setAlwaysDiscardsLateVideoFrames(true) };
                unsafe { output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*out)), Some(&queue)) };
                if !unsafe { session.canAddInput(&input) && session.canAddOutput(&output) } {
                    return Err("camera: the capture session refused it".into());
                }
                unsafe {
                    session.addInput(&input);
                    session.addOutput(&output);
                }
                // macOS scales in the capture pipeline: frames arrive WIDTH wide at the camera's aspect.
                let dims = unsafe { objc2_core_media::CMVideoFormatDescriptionGetDimensions(&dev.activeFormat().formatDescription()) };
                let height = (WIDTH * dims.height as i64 / (dims.width as i64).max(1)).max(2) & !1;
                let keys = [NSString::from_str("PixelFormatType"), NSString::from_str("Width"), NSString::from_str("Height")];
                let vals = [NSNumber::new_u32(u32::from_be_bytes(*b"BGRA")), NSNumber::new_i64(WIDTH), NSNumber::new_i64(height)];
                let settings = NSDictionary::from_slices(&keys.iter().map(|k| &**k).collect::<Vec<_>>(), &vals.iter().map(|v| v.as_ref() as &AnyObject).collect::<Vec<_>>());
                unsafe { output.setVideoSettings(Some(&settings)) };
            }
            if let Some(want) = microphone {
                let dev = device(audio_type, want, "microphone")?;
                let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&dev) }.map_err(|e| format!("microphone: {}", e.localizedDescription()))?;
                let output = unsafe { AVCaptureAudioDataOutput::new() };
                // Levels are read from the connection; the delegate only keeps the output running.
                unsafe { output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*out)), Some(&queue)) };
                if !unsafe { session.canAddInput(&input) && session.canAddOutput(&output) } {
                    return Err("microphone: the capture session refused it".into());
                }
                unsafe {
                    session.addInput(&input);
                    session.addOutput(&output);
                }
                audio = Some(output);
            }
            Ok(())
        })();
        unsafe { session.commitConfiguration() };
        configured?;
        unsafe { session.startRunning() };
        Ok(Preview { session, _out: out, _queue: queue, audio })
    }

    /// The microphone's level in dBFS, its loudest channel's average and peak, when one is previewed.
    pub fn level(&self) -> Option<Value> {
        let audio = self.audio.as_ref()?;
        let connections = unsafe { audio.connections() };
        let mut level: Option<(f32, f32)> = None;
        for c in connections.iter() {
            for ch in unsafe { c.audioChannels() }.iter() {
                let (avg, peak) = unsafe { (ch.averagePowerLevel(), ch.peakHoldLevel()) };
                level = Some(level.map_or((avg, peak), |(a, p)| (a.max(avg), p.max(peak))));
            }
        }
        let (avg, peak) = level?;
        let db = |v: f32| if v.is_finite() { ((v.max(-120.0) * 10.0).round() / 10.0) as f64 } else { -120.0 };
        Some(json!({ "event": "previewLevel", "db": db(avg), "peak": db(peak) }))
    }
}

impl Drop for Preview {
    fn drop(&mut self) {
        unsafe { self.session.stopRunning() };
    }
}
