//! The Record dialog's preview: the chosen display and camera as small JPEG
//! frames, and the microphone's and system audio's levels, from capture that
//! writes nothing.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVCaptureAudioDataOutput, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
    AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeAudio, AVMediaTypeVideo,
};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};
use objc2_screen_capture_kit::{SCStream, SCStreamConfiguration, SCStreamOutput, SCStreamOutputType};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture::{Device, device, wait_for};
use crate::monitor::{Meter, channel_level, jpeg};

/// Camera frames are this wide, the screen's this wide, at most this many a second: enough to frame a shot.
const CAMERA_WIDTH: i64 = 320;
const SCREEN_WIDTH: usize = 480;
const CAMERA_FPS: f64 = 30.0;
const SCREEN_FPS: i32 = 5;

/// What to preview; a missing one isn't.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewSources {
    pub screen: Option<crate::capture::Screen>,
    #[serde(default)]
    pub system_audio: bool,
    pub camera: Option<Device>,
    pub microphone: Option<Device>,
}

impl PreviewSources {
    pub fn is_empty(&self) -> bool {
        self.screen.is_none() && !self.system_audio && self.camera.is_none() && self.microphone.is_none()
    }
}

type Emit = Box<dyn Fn(Value) + Send + Sync>;

struct PreviewIvars {
    last: Mutex<Option<Instant>>,
    system: Mutex<Meter>,
    emit: Emit,
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
            // The microphone's buffers come here too: they carry no image, and its level is read from its connection.
            if unsafe { buf.image_buffer() }.is_none() {
                return;
            }
            {
                let mut last = iv.last.lock().unwrap();
                if last.is_some_and(|l| l.elapsed() < Duration::from_secs_f64(1.0 / CAMERA_FPS)) {
                    return;
                }
                *last = Some(Instant::now());
            }
            if let Some(jpeg) = jpeg(buf, CAMERA_WIDTH as usize) {
                (iv.emit)(json!({ "event": "previewFrame", "source": "camera", "jpeg": jpeg }));
            }
        }
    }

    unsafe impl AVCaptureAudioDataOutputSampleBufferDelegate for PreviewOutput {}

    unsafe impl SCStreamOutput for PreviewOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_output(&self, _stream: &SCStream, buf: &CMSampleBuffer, kind: SCStreamOutputType) {
            let iv = self.ivars();
            if kind == SCStreamOutputType::Audio {
                iv.system.lock().unwrap().add_float(buf);
            } else if kind == SCStreamOutputType::Screen
                && let Some(jpeg) = jpeg(buf, SCREEN_WIDTH)
            {
                (iv.emit)(json!({ "event": "previewFrame", "source": "screen", "jpeg": jpeg }));
            }
        }
    }
);

/// Sources being previewed; dropping it stops them.
pub struct Preview {
    session: Retained<AVCaptureSession>,
    stream: Option<Retained<SCStream>>,
    out: Retained<PreviewOutput>,
    _queues: Vec<dispatch2::DispatchRetained<DispatchQueue>>,
    microphone: Option<Retained<AVCaptureAudioDataOutput>>,
}

impl Preview {
    /// `emit` gets each frame's event, on a capture queue.
    pub fn start(sources: &PreviewSources, emit: impl Fn(Value) + Send + Sync + 'static) -> Result<Preview, String> {
        let (video_type, audio_type) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
        let out = PreviewOutput::alloc().set_ivars(PreviewIvars { last: Mutex::new(None), system: Mutex::new(Meter::default()), emit: Box::new(emit) });
        let out: Retained<PreviewOutput> = unsafe { msg_send![super(out), init] };
        let queue = DispatchQueue::new("beacon.record.preview", None);
        let session = unsafe { AVCaptureSession::new() };
        let mut microphone = None;
        unsafe { session.beginConfiguration() };
        let configured = (|| -> Result<(), String> {
            if let Some(want) = &sources.camera {
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
                // macOS scales in the capture pipeline: frames arrive CAMERA_WIDTH wide at the camera's aspect.
                let dims = unsafe { objc2_core_media::CMVideoFormatDescriptionGetDimensions(&dev.activeFormat().formatDescription()) };
                let height = (CAMERA_WIDTH * dims.height as i64 / (dims.width as i64).max(1)).max(2) & !1;
                let keys = [NSString::from_str("PixelFormatType"), NSString::from_str("Width"), NSString::from_str("Height")];
                let vals = [NSNumber::new_u32(u32::from_be_bytes(*b"BGRA")), NSNumber::new_i64(CAMERA_WIDTH), NSNumber::new_i64(height)];
                let settings = NSDictionary::from_slices(&keys.iter().map(|k| &**k).collect::<Vec<_>>(), &vals.iter().map(|v| v.as_ref() as &AnyObject).collect::<Vec<_>>());
                unsafe { output.setVideoSettings(Some(&settings)) };
            }
            if let Some(want) = &sources.microphone {
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
                microphone = Some(output);
            }
            Ok(())
        })();
        unsafe { session.commitConfiguration() };
        configured?;
        let mut queues = vec![queue];

        let mut stream = None;
        if sources.screen.is_some() || sources.system_audio {
            let want = sources.screen.as_ref();
            let (filter, display) = crate::devices::display_filter(want.and_then(|s| s.display), want.and_then(|s| s.exclude.as_deref()))?;
            let config = unsafe { SCStreamConfiguration::new() };
            // System audio alone still needs a video stream: the smallest one.
            let (w, h) = match sources.screen {
                Some(_) => {
                    let f = unsafe { display.frame() };
                    (SCREEN_WIDTH, ((SCREEN_WIDTH as f64 * f.size.height / f.size.width.max(1.0)) as usize).max(2))
                }
                None => (2, 2),
            };
            unsafe {
                config.setWidth(w);
                config.setHeight(h);
                config.setPixelFormat(u32::from_be_bytes(*b"BGRA"));
                config.setMinimumFrameInterval(CMTime::new(1, SCREEN_FPS));
                config.setShowsCursor(true);
                config.setQueueDepth(3);
                config.setCapturesAudio(sources.system_audio);
                config.setSampleRate(48_000);
                config.setChannelCount(2);
            }
            let s = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None) };
            let q = DispatchQueue::new("beacon.record.preview-screen", None);
            if sources.screen.is_some() {
                unsafe { s.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*out), SCStreamOutputType::Screen, Some(&q)) }.map_err(|e| e.localizedDescription().to_string())?;
            }
            if sources.system_audio {
                unsafe { s.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*out), SCStreamOutputType::Audio, Some(&q)) }.map_err(|e| e.localizedDescription().to_string())?;
            }
            wait_for(|done| unsafe { s.startCaptureWithCompletionHandler(Some(done)) }).map_err(|e| format!("screen capture: {e}"))?;
            queues.push(q);
            stream = Some(s);
        }
        if sources.camera.is_some() || sources.microphone.is_some() {
            unsafe { session.startRunning() };
        }
        Ok(Preview { session, stream, out, _queues: queues, microphone })
    }

    /// `{event: "previewLevel", microphone?, systemAudio?}`, each `{db, peak}` in dBFS; None when neither is previewed.
    pub fn level(&self) -> Option<Value> {
        let mic = self.microphone.as_deref().and_then(channel_level);
        let system = self.stream.as_ref().and_then(|_| self.out.ivars().system.lock().unwrap().read());
        if mic.is_none() && system.is_none() {
            return None;
        }
        Some(json!({ "event": "previewLevel", "microphone": mic, "systemAudio": system }))
    }
}

impl Drop for Preview {
    fn drop(&mut self) {
        unsafe { self.session.stopRunning() };
        if let Some(s) = &self.stream {
            let _ = wait_for(|done| unsafe { s.stopCaptureWithCompletionHandler(Some(done)) });
        }
    }
}
