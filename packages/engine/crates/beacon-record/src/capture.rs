//! A take: screen and system audio through ScreenCaptureKit, camera and
//! microphone through AVFoundation, each sample buffer appended to its own
//! AVAssetWriter as it arrives, into a `.brec` folder with `recording.json`.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAuthorizationStatus, AVCaptureAudioDataOutput, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection,
    AVCaptureDevice, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession, AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVFileTypeMPEG4, AVFileTypeWAVE, AVMediaTypeAudio, AVMediaTypeVideo, AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeHEVC,
    AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoWidthKey,
};
use objc2_core_media::{CMClock, CMSampleBuffer, CMTime};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_screen_capture_kit::{SCStream, SCStreamConfiguration, SCStreamOutput, SCStreamOutputType};
use serde::Deserialize;
use serde_json::{Value, json};

/// What to record. A missing source is not recorded; a device without an id is the default one.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sources {
    pub screen: Option<Screen>,
    #[serde(default)]
    pub system_audio: bool,
    pub camera: Option<Device>,
    pub microphone: Option<Device>,
    /// Seconds added to a stream's `start` on import (`camera`: minus how late the camera is, from the sync
    /// check), written into `recording.json` with the stream.
    #[serde(default)]
    pub offsets: std::collections::HashMap<String, f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Screen {
    /// A display id from `devices`; the main display when missing.
    pub display: Option<u32>,
    #[serde(default = "sixty")]
    pub fps: u32,
    /// Leaves out windows with this title (Beacon's recording panel).
    pub exclude: Option<String>,
}

fn sixty() -> u32 {
    60
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    /// A device id from `devices`.
    pub id: Option<String>,
}

fn host_now() -> f64 {
    unsafe { CMClock::host_time_clock().time().seconds() }
}

/// One output file: an asset writer started at its first sample after the take began.
struct Track {
    key: &'static str,
    file: &'static str,
    writer: Retained<AVAssetWriter>,
    input: Retained<AVAssetWriterInput>,
    /// Host-clock seconds when the take began; earlier samples are dropped (all of them until it begins).
    t0: f64,
    /// Whether any buffer has arrived, before the take began or after.
    seen: bool,
    first: Option<f64>,
    last: f64,
    /// Sample buffers appended (video frames, or audio buffers).
    buffers: u64,
    /// Audio sample frames appended.
    samples: i64,
    dropped: u64,
    /// Arrival delay: host time at the callback minus the buffer's timestamp.
    latency: Vec<f64>,
    error: Option<String>,
    /// What `recording.json` says about the stream besides its timing.
    info: Value,
}

impl Track {
    fn new(key: &'static str, file: &'static str, dir: &Path, file_type: &NSString, media: &NSString, settings: &NSDictionary<NSString, AnyObject>, info: Value) -> Result<Self, String> {
        let path = dir.join(file);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().ok_or("the take's folder isn't valid UTF-8")?));
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }.map_err(|e| format!("{key}: {}", e.localizedDescription()))?;
        let input = unsafe { AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(media, Some(settings)) };
        unsafe { input.setExpectsMediaDataInRealTime(true) };
        // Fragmented MPEG-4 stays readable up to the last fragment if the recorder dies
        // (QuickTime movies are written unfragmented even when asked).
        if file.ends_with(".mp4") {
            unsafe { writer.setMovieFragmentInterval(CMTime::new(2, 1)) };
            unsafe { writer.setInitialMovieFragmentInterval(CMTime::new(2, 1)) };
        }
        if !unsafe { writer.canAddInput(&input) } {
            return Err(format!("{key}: the writer refused its input settings"));
        }
        unsafe { writer.addInput(&input) };
        Ok(Self { key, file, writer, input, t0: f64::INFINITY, seen: false, first: None, last: 0.0, buffers: 0, samples: 0, dropped: 0, latency: Vec::new(), error: None, info })
    }

    fn append(&mut self, buf: &CMSampleBuffer) {
        self.seen = true;
        let now = host_now();
        let pts = unsafe { buf.presentation_time_stamp() };
        let t = unsafe { pts.seconds() };
        if !unsafe { buf.is_valid() } || t < self.t0 || self.error.is_some() {
            return;
        }
        if self.first.is_none() {
            if !unsafe { self.writer.startWriting() } {
                self.error = unsafe { self.writer.error() }.map(|e| e.localizedDescription().to_string());
                return;
            }
            unsafe { self.writer.startSessionAtSourceTime(pts) };
            self.first = Some(t);
        }
        if !unsafe { self.input.isReadyForMoreMediaData() } {
            self.dropped += 1;
            return;
        }
        if !unsafe { self.input.appendSampleBuffer(buf) } {
            self.error = unsafe { self.writer.error() }.map(|e| e.localizedDescription().to_string());
            return;
        }
        self.buffers += 1;
        self.samples += unsafe { buf.num_samples() } as i64;
        self.last = t + unsafe { buf.duration().seconds() }.max(0.0);
        self.latency.push(now - t);
    }

    /// `end`: host-clock time the take stopped; every file ends there, so a still screen's last frame holds until then.
    fn finish(&self, end: CMTime) -> Result<(), String> {
        if self.first.is_none() {
            return Ok(());
        }
        unsafe { self.input.markAsFinished() };
        unsafe { self.writer.endSessionAtSourceTime(end) };
        let (tx, rx) = mpsc::channel();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| format!("{}: finishing timed out", self.key))?;
        match unsafe { self.writer.error() } {
            Some(e) => Err(format!("{}: {}", self.key, e.localizedDescription())),
            None => Ok(()),
        }
    }

    /// The stream's entry in `recording.json`: `start` is seconds into the take of its first sample.
    fn describe(&self) -> Value {
        let mut lat = self.latency.clone();
        lat.sort_by(f64::total_cmp);
        let pct = |p: f64| lat.get(((lat.len().max(1) - 1) as f64 * p) as usize).map(|v| (v * 1e4).round() / 10.0);
        let mut d = json!({
            "file": self.file,
            "start": self.first.map(|f| f - self.t0),
            "buffers": self.buffers,
            "dropped": self.dropped,
            "latencyMs": { "p50": pct(0.5), "p95": pct(0.95), "max": pct(1.0) },
            "error": self.error,
        });
        if let (Some(rate), Some(first)) = (self.info.get("rate").and_then(Value::as_f64), self.first) {
            // Audio written at its nominal rate against the host clock's span: how far it drifts.
            let span = self.last - first;
            if span > 0.0 {
                d["driftPpm"] = json!(((self.samples as f64 / rate - span) / span * 1e6).round() + 0.0);
            }
        }
        if let (Value::Object(d), Value::Object(info)) = (&mut d, &self.info) {
            d.extend(info.clone());
        }
        d
    }
}

/// Sample buffers from ScreenCaptureKit: screen frames and system audio.
struct ScreenIvars {
    screen: Mutex<Option<Track>>,
    audio: Mutex<Option<Track>>,
    idle: Mutex<u64>,
    /// System audio's level, for the recording panel.
    level: Mutex<crate::monitor::Meter>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BeaconRecorderScreenOutput"]
    #[ivars = ScreenIvars]
    struct ScreenOutput;

    unsafe impl NSObjectProtocol for ScreenOutput {}

    unsafe impl SCStreamOutput for ScreenOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &SCStream, buf: &CMSampleBuffer, kind: SCStreamOutputType) {
            let iv = self.ivars();
            if kind == SCStreamOutputType::Screen {
                // Frames are sent only when the screen changes; the others carry no image.
                if unsafe { buf.image_buffer() }.is_none() {
                    *iv.idle.lock().unwrap() += 1;
                    return;
                }
                if let Some(t) = iv.screen.lock().unwrap().as_mut() {
                    t.append(buf);
                }
            } else if kind == SCStreamOutputType::Audio
                && let Some(t) = iv.audio.lock().unwrap().as_mut()
            {
                t.append(buf);
                iv.level.lock().unwrap().add_float(buf);
            }
        }
    }
);

/// Sample buffers from AVFoundation: camera frames and microphone audio.
struct CaptureIvars {
    camera: Mutex<Option<Track>>,
    mic: Mutex<Option<Track>>,
    // The camera's output, to tell its frames from the microphone's; the session retains it. Atomic
    // because the camera and microphone callbacks run on separate queues.
    video_output: AtomicPtr<AVCaptureOutput>,
    /// Sends the camera's frames to the recording panel, a few a second, when it is shown.
    monitor: Option<Monitor>,
    last_frame: Mutex<Option<std::time::Instant>>,
}

pub type Monitor = Box<dyn Fn(Value) + Send + Sync>;

/// Camera frames for the recording panel: small, and few, so the take's own frames aren't held up.
const MONITOR_WIDTH: usize = 320;
const MONITOR_FPS: f64 = 15.0;

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BeaconRecorderCaptureOutput"]
    #[ivars = CaptureIvars]
    struct CaptureOutput;

    unsafe impl NSObjectProtocol for CaptureOutput {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for CaptureOutput {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(&self, output: &AVCaptureOutput, buf: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            let iv = self.ivars();
            let is_video = std::ptr::eq(iv.video_output.load(Ordering::Acquire), output);
            let track = if is_video { &iv.camera } else { &iv.mic };
            if let Some(t) = track.lock().unwrap().as_mut() {
                t.append(buf);
            }
            // Only once the take has begun: a camera's first frames, while its exposure settles, are dark.
            let begun = is_video && iv.camera.lock().unwrap().as_ref().is_some_and(|t| t.first.is_some());
            if begun && let Some(emit) = &iv.monitor {
                {
                    let mut last = iv.last_frame.lock().unwrap();
                    if last.is_some_and(|l| l.elapsed() < Duration::from_secs_f64(1.0 / MONITOR_FPS)) {
                        return;
                    }
                    *last = Some(std::time::Instant::now());
                }
                if let Some(jpeg) = crate::monitor::jpeg(buf, MONITOR_WIDTH) {
                    emit(json!({ "event": "previewFrame", "source": "camera", "jpeg": jpeg }));
                }
            }
        }
    }

    unsafe impl AVCaptureAudioDataOutputSampleBufferDelegate for CaptureOutput {}
);

fn dict(pairs: &[(&NSString, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<&NSString> = pairs.iter().map(|p| p.0).collect();
    let vals: Vec<&AnyObject> = pairs.iter().map(|p| p.1).collect();
    NSDictionary::from_slices(&keys, &vals)
}

fn num(v: i64) -> Retained<NSNumber> {
    NSNumber::new_i64(v)
}

fn setting(settings: &NSDictionary<NSString, AnyObject>, key: &str) -> Option<f64> {
    settings.objectForKey(&NSString::from_str(key)).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.doubleValue())
}

/// HEVC at about 20 Mbit/s for a 3600×2338 screen at 60 fps, less for smaller or slower video.
fn video_settings(hevc: &NSString, width: usize, height: usize, fps: u32) -> Retained<NSDictionary<NSString, AnyObject>> {
    let bitrate = ((width * height) as i64 * fps as i64 / 25).clamp(4_000_000, 40_000_000);
    unsafe {
        let props = dict(&[(AVVideoAverageBitRateKey.unwrap(), num(bitrate).as_ref()), (AVVideoExpectedSourceFrameRateKey.unwrap(), num(fps as i64).as_ref())]);
        dict(&[
            (AVVideoCodecKey.unwrap(), hevc.as_ref()),
            (AVVideoWidthKey.unwrap(), num(width as i64).as_ref()),
            (AVVideoHeightKey.unwrap(), num(height as i64).as_ref()),
            (AVVideoCompressionPropertiesKey.unwrap(), props.as_ref()),
        ])
    }
}

/// 16-bit interleaved PCM: sample-exact in FFmpeg, and readable after a crash (AAC is neither).
fn pcm(rate: i64, channels: i64) -> Retained<NSDictionary<NSString, AnyObject>> {
    dict(&[
        (&NSString::from_str("AVFormatIDKey"), num(0x6C70_636D).as_ref()), // kAudioFormatLinearPCM
        (&NSString::from_str("AVSampleRateKey"), num(rate).as_ref()),
        (&NSString::from_str("AVNumberOfChannelsKey"), num(channels).as_ref()),
        (&NSString::from_str("AVLinearPCMBitDepthKey"), num(16).as_ref()),
        (&NSString::from_str("AVLinearPCMIsFloatKey"), num(0).as_ref()),
        (&NSString::from_str("AVLinearPCMIsBigEndianKey"), num(0).as_ref()),
        (&NSString::from_str("AVLinearPCMIsNonInterleaved"), num(0).as_ref()),
    ])
}

fn error_text(e: *mut NSError) -> Option<String> {
    unsafe { e.as_ref() }.map(|e| e.localizedDescription().to_string())
}

/// Calls an Objective-C method taking a completion block with an optional NSError, and waits for it.
pub(crate) fn wait_for(f: impl FnOnce(&block2::DynBlock<dyn Fn(*mut NSError)>)) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |e: *mut NSError| {
        let _ = tx.send(error_text(e));
    });
    f(&done);
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(None) => Ok(()),
        Ok(Some(e)) => Err(e),
        Err(_) => Err("timed out".into()),
    }
}

fn allowed(media: &NSString) -> bool {
    (unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) }) == AVAuthorizationStatus::Authorized
}

pub(crate) fn device(media: &NSString, wanted: &Device, kind: &str) -> Result<Retained<AVCaptureDevice>, String> {
    unsafe {
        match &wanted.id {
            Some(id) => AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(id)).ok_or_else(|| format!("no {kind} \"{id}\"")),
            None => AVCaptureDevice::defaultDeviceWithMediaType(media).ok_or_else(|| format!("no {kind}")),
        }
    }
}

/// A take being recorded.
pub struct Take {
    dir: PathBuf,
    stream: Option<Retained<SCStream>>,
    session: Retained<AVCaptureSession>,
    screen_out: Retained<ScreenOutput>,
    capture_out: Retained<CaptureOutput>,
    mic_output: Option<Retained<AVCaptureAudioDataOutput>>,
    /// Kept alive while the take runs: the outputs deliver on them.
    _queues: Vec<dispatch2::DispatchRetained<DispatchQueue>>,
    t0: f64,
    started_at: f64,
    cursor: Option<crate::cursor::CursorLog>,
    cursor_summary: Option<Value>,
    offsets: std::collections::HashMap<String, f64>,
    /// Host-clock seconds into the take, of anything worth marking (`record --tones`).
    pub marks: Vec<f64>,
}

impl Take {
    /// Opens every file, starts capture, then begins the take: each file holds only samples from then on.
    /// `monitor` gets the recording panel's camera frames; `level` gives its audio levels.
    pub fn start(dir: &Path, sources: &Sources, monitor: Option<Monitor>) -> Result<Take, String> {
        if dir.exists() {
            return Err(format!("{} already exists", dir.display()));
        }
        if sources.screen.is_none() && !sources.system_audio && sources.camera.is_none() && sources.microphone.is_none() {
            return Err("nothing to record".into());
        }
        let (video_type, audio_type) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
        let (mp4, wav, hevc) = unsafe { (AVFileTypeMPEG4.unwrap(), AVFileTypeWAVE.unwrap(), AVVideoCodecTypeHEVC.unwrap()) };
        if sources.camera.is_some() && !allowed(video_type) {
            return Err("camera: permission not granted (System Settings > Privacy & Security > Camera)".into());
        }
        if sources.microphone.is_some() && !allowed(audio_type) {
            return Err("microphone: permission not granted (System Settings > Privacy & Security > Microphone)".into());
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut queues = Vec::new();

        // ScreenCaptureKit: the display at its pixel size, no cursor (Beacon draws its own), system audio at 48 kHz stereo.
        let screen_out = ScreenOutput::alloc().set_ivars(ScreenIvars { screen: Mutex::new(None), audio: Mutex::new(None), idle: Mutex::new(0), level: Mutex::new(crate::monitor::Meter::default()) });
        let screen_out: Retained<ScreenOutput> = unsafe { msg_send![super(screen_out), init] };
        let mut stream = None;
        let mut cursor = None;
        if sources.screen.is_some() || sources.system_audio {
            let want = sources.screen.as_ref();
            let (filter, display) = crate::devices::display_filter(want.and_then(|s| s.display), want.and_then(|s| s.exclude.as_deref()))?;
            let config = unsafe { SCStreamConfiguration::new() };
            let fps = sources.screen.as_ref().map_or(1, |s| s.fps.clamp(1, 60));
            // Audio alone still needs a video stream: the smallest one.
            let (pw, ph) = match sources.screen {
                Some(_) => unsafe {
                    let f = display.frame();
                    let scale = filter.pointPixelScale() as f64;
                    ((f.size.width * scale) as usize, (f.size.height * scale) as usize)
                },
                None => (2, 2),
            };
            unsafe {
                config.setWidth(pw);
                config.setHeight(ph);
                config.setMinimumFrameInterval(CMTime::new(1, fps as i32));
                config.setShowsCursor(false);
                config.setQueueDepth(8);
                config.setCapturesAudio(sources.system_audio);
                config.setSampleRate(48_000);
                config.setChannelCount(2);
                config.setExcludesCurrentProcessAudio(false);
            }
            let s = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None) };
            if sources.screen.is_some() {
                let settings = video_settings(hevc, pw, ph, fps);
                let f = unsafe { display.frame() };
                cursor = Some(crate::cursor::CursorLog::new(dir, Some([f.origin.x, f.origin.y, f.size.width, f.size.height]))?);
                let info = json!({ "display": unsafe { display.displayID() }, "width": pw, "height": ph, "fps": fps });
                *screen_out.ivars().screen.lock().unwrap() = Some(Track::new("screen", "screen.mp4", dir, mp4, video_type, &settings, info)?);
                let q = DispatchQueue::new("beacon.record.screen", None);
                unsafe { s.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*screen_out), SCStreamOutputType::Screen, Some(&q)) }.map_err(|e| e.localizedDescription().to_string())?;
                queues.push(q);
            }
            if sources.system_audio {
                let info = json!({ "rate": 48_000, "channels": 2 });
                *screen_out.ivars().audio.lock().unwrap() = Some(Track::new("systemAudio", "system-audio.wav", dir, wav, audio_type, &pcm(48_000, 2), info)?);
                let q = DispatchQueue::new("beacon.record.system-audio", None);
                unsafe { s.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*screen_out), SCStreamOutputType::Audio, Some(&q)) }.map_err(|e| e.localizedDescription().to_string())?;
                queues.push(q);
            }
            stream = Some(s);
        }

        // AVFoundation: the camera and microphone in one session.
        let session = unsafe { AVCaptureSession::new() };
        let capture_out = CaptureOutput::alloc().set_ivars(CaptureIvars { camera: Mutex::new(None), mic: Mutex::new(None), video_output: AtomicPtr::new(std::ptr::null_mut()), monitor, last_frame: Mutex::new(None) });
        let capture_out: Retained<CaptureOutput> = unsafe { msg_send![super(capture_out), init] };
        unsafe { session.beginConfiguration() };
        let mut camera = None;
        let mut mic_output = None;
        let configured = (|| -> Result<(), String> {
            if let Some(want) = &sources.camera {
                let dev = device(video_type, want, "camera")?;
                let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&dev) }.map_err(|e| format!("camera: {}", e.localizedDescription()))?;
                let output = unsafe { AVCaptureVideoDataOutput::new() };
                let q = DispatchQueue::new("beacon.record.camera", None);
                unsafe { output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*capture_out)), Some(&q)) };
                queues.push(q);
                if !unsafe { session.canAddInput(&input) && session.canAddOutput(&output) } {
                    return Err("camera: the capture session refused it".into());
                }
                unsafe {
                    session.addInput(&input);
                    session.addOutput(&output);
                }
                camera = Some((output, dev));
            }
            if let Some(want) = &sources.microphone {
                let dev = device(audio_type, want, "microphone")?;
                let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&dev) }.map_err(|e| format!("microphone: {}", e.localizedDescription()))?;
                let output = unsafe { AVCaptureAudioDataOutput::new() };
                let q = DispatchQueue::new("beacon.record.microphone", None);
                unsafe { output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*capture_out)), Some(&q)) };
                queues.push(q);
                if !unsafe { session.canAddInput(&input) && session.canAddOutput(&output) } {
                    return Err("microphone: the capture session refused it".into());
                }
                unsafe {
                    session.addInput(&input);
                    session.addOutput(&output);
                }
                let recommended = unsafe { output.recommendedAudioSettingsForAssetWriterWithOutputFileType(AVFileTypeWAVE.unwrap()) };
                let rate = recommended.as_deref().and_then(|s| setting(s, "AVSampleRateKey")).unwrap_or(48_000.0) as i64;
                let channels = recommended.as_deref().and_then(|s| setting(s, "AVNumberOfChannelsKey")).unwrap_or(1.0) as i64;
                let info = json!({ "device": unsafe { dev.localizedName() }.to_string(), "rate": rate, "channels": channels });
                *capture_out.ivars().mic.lock().unwrap() = Some(Track::new("microphone", "microphone.wav", dir, wav, audio_type, &pcm(rate, channels), info)?);
                mic_output = Some(output);
            }
            Ok(())
        })();
        unsafe { session.commitConfiguration() };
        // The camera's size and rate are its active format's once the session is configured. Its own
        // settings, not AVFoundation's recommended ones, which this Mac's camera has none of.
        let configured = configured.and_then(|()| {
            let Some((output, dev)) = &camera else { return Ok(()) };
            let (dims, frame) = unsafe { (objc2_core_media::CMVideoFormatDescriptionGetDimensions(&dev.activeFormat().formatDescription()), dev.activeVideoMinFrameDuration()) };
            let fps = if unsafe { frame.seconds() } > 0.0 { (1.0 / unsafe { frame.seconds() }).round() as i64 } else { 30 };
            let settings = video_settings(hevc, dims.width as usize, dims.height as usize, fps as u32);
            let info = json!({ "device": unsafe { dev.localizedName() }.to_string(), "width": dims.width, "height": dims.height, "fps": fps });
            *capture_out.ivars().camera.lock().unwrap() = Some(Track::new("camera", "camera.mp4", dir, mp4, video_type, &settings, info)?);
            capture_out.ivars().video_output.store(Retained::as_ptr(output).cast::<AVCaptureOutput>().cast_mut(), Ordering::Release);
            Ok(())
        });
        if let Err(e) = configured {
            let _ = std::fs::remove_dir_all(dir);
            return Err(e);
        }

        if let Some(s) = &stream
            && let Err(e) = wait_for(|done| unsafe { s.startCaptureWithCompletionHandler(Some(done)) })
        {
            let _ = std::fs::remove_dir_all(dir);
            return Err(format!("screen capture: {e}"));
        }
        if sources.camera.is_some() || sources.microphone.is_some() {
            unsafe { session.startRunning() };
            // A camera sends its first frame about half a second after it starts: begin the take once the camera
            // and microphone are delivering, so their files start with it (ScreenCaptureKit is already running).
            let warm = std::time::Instant::now();
            let live = |m: &Mutex<Option<Track>>| m.lock().unwrap().as_ref().is_none_or(|t| t.seen);
            while !(live(&capture_out.ivars().camera) && live(&capture_out.ivars().mic)) && warm.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        let t0 = host_now();
        for m in [&screen_out.ivars().screen, &screen_out.ivars().audio, &capture_out.ivars().camera, &capture_out.ivars().mic] {
            if let Some(t) = m.lock().unwrap().as_mut() {
                t.t0 = t0;
            }
        }
        let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        let cursor_summary = cursor.as_ref().map(|_| json!({ "file": "cursor.jsonl" }));
        let take = Take {
            dir: dir.to_path_buf(),
            stream,
            session,
            screen_out,
            capture_out,
            mic_output,
            _queues: queues,
            t0,
            started_at,
            cursor,
            cursor_summary,
            offsets: sources.offsets.clone(),
            marks: Vec::new(),
        };
        // Written now so a take the recorder never finished still says what it holds.
        take.write(None, &[])?;
        Ok(take)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Seconds since the take began.
    pub fn elapsed(&self) -> f64 {
        host_now() - self.t0
    }

    /// Samples the cursor; call from the main thread, about 120 times a second.
    pub fn poll_cursor(&mut self) {
        let t = self.elapsed();
        if let Some(c) = &mut self.cursor {
            c.poll(t);
        }
    }

    /// `{event: "previewLevel", microphone?, systemAudio?}` as the preview's, for the recording panel.
    pub fn level(&self) -> Option<Value> {
        let mic = self.mic_output.as_deref().and_then(crate::monitor::channel_level);
        let system = self.screen_out.ivars().audio.lock().unwrap().is_some().then(|| self.screen_out.ivars().level.lock().unwrap().read()).flatten();
        if mic.is_none() && system.is_none() {
            return None;
        }
        Some(json!({ "event": "previewLevel", "microphone": mic, "systemAudio": system }))
    }

    pub fn monitored(&self) -> bool {
        self.capture_out.ivars().monitor.is_some()
    }

    pub fn mark(&mut self) {
        self.marks.push(self.elapsed());
    }

    fn tracks(&self) -> [&Mutex<Option<Track>>; 4] {
        [&self.screen_out.ivars().screen, &self.screen_out.ivars().audio, &self.capture_out.ivars().camera, &self.capture_out.ivars().mic]
    }

    fn streams(&self) -> serde_json::Map<String, Value> {
        self.tracks()
            .iter()
            .filter_map(|m| {
                m.lock().unwrap().as_ref().map(|t| {
                    let mut d = t.describe();
                    if let Some(o) = self.offsets.get(t.key) {
                        d["offset"] = json!(o);
                    }
                    (t.key.to_string(), d)
                })
            })
            .collect()
    }

    /// What is being recorded: elapsed seconds, and buffers and drops per stream.
    pub fn status(&self) -> Value {
        json!({ "elapsed": self.elapsed(), "streams": self.streams() })
    }

    fn write(&self, duration: Option<f64>, errors: &[String]) -> Result<(), String> {
        let data = json!({
            "version": 1,
            "complete": duration.is_some(),
            "startedAt": self.started_at,
            "duration": duration,
            "streams": self.streams(),
            "cursor": self.cursor_summary,
            "idleScreenFrames": *self.screen_out.ivars().idle.lock().unwrap(),
            "marks": self.marks,
            "errors": errors,
        });
        let path = self.dir.join("recording.json");
        let tmp = self.dir.join("recording.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&data).unwrap()).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Stops capture and finishes every file at the same moment; returns `recording.json`'s summary.
    pub fn stop(mut self) -> Result<Value, String> {
        let end = unsafe { CMClock::host_time_clock().time() };
        let duration = unsafe { end.seconds() } - self.t0;
        let mut errors = Vec::new();
        if let Some(s) = &self.stream
            && let Err(e) = wait_for(|done| unsafe { s.stopCaptureWithCompletionHandler(Some(done)) })
        {
            errors.push(format!("stopping screen capture: {e}"));
        }
        unsafe { self.session.stopRunning() };
        for m in self.tracks() {
            if let Some(t) = m.lock().unwrap().as_ref()
                && let Err(e) = t.finish(end)
            {
                errors.push(e);
            }
        }
        if let Some(c) = &mut self.cursor {
            self.cursor_summary = Some(c.finish());
        }
        self.write(Some(duration), &errors)?;
        Ok(json!({ "dir": self.dir, "duration": duration, "streams": self.streams(), "cursor": self.cursor_summary, "errors": errors }))
    }
}
