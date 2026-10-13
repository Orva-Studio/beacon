//! Phase 6 spike: screen and system audio through ScreenCaptureKit, camera
//! and microphone through AVFoundation, each sample buffer appended to its
//! own AVAssetWriter as it arrives. Two tones are played during the take so
//! the files can be checked against each other afterwards.
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAuthorizationStatus, AVCaptureAudioDataOutput, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection,
    AVCaptureDevice, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession, AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVFileTypeAppleM4A, AVFileTypeMPEG4, AVMediaTypeAudio, AVMediaTypeVideo, AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeHEVC,
    AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoWidthKey,
};
use objc2_core_media::{CMClock, CMSampleBuffer, CMTime};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_screen_capture_kit::{SCContentFilter, SCStream, SCStreamConfiguration, SCStreamOutput, SCStreamOutputType};
use serde_json::{Value, json};

fn host_now() -> f64 {
    unsafe { CMClock::host_time_clock().time().seconds() }
}

/// One output file: an asset writer started at its first sample after the take began.
struct Track {
    name: &'static str,
    writer: Retained<AVAssetWriter>,
    input: Retained<AVAssetWriterInput>,
    /// Host-clock seconds when recording began; earlier samples are dropped.
    t0: f64,
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
}

impl Track {
    fn new(name: &'static str, path: &Path, file_type: &NSString, media: &NSString, settings: &NSDictionary<NSString, AnyObject>, t0: f64) -> Result<Self, String> {
        let _ = std::fs::remove_file(path);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }.map_err(|e| format!("{name}: {}", e.localizedDescription()))?;
        let input = unsafe { AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(media, Some(settings)) };
        unsafe { input.setExpectsMediaDataInRealTime(true) };
        // Fragmented MPEG-4 stays readable up to the last fragment if the recorder dies
        // (QuickTime movies are written unfragmented even when asked).
        if path.extension().is_some_and(|e| e == "mp4") {
            unsafe { writer.setMovieFragmentInterval(CMTime::new(2, 1)) };
            unsafe { writer.setInitialMovieFragmentInterval(CMTime::new(2, 1)) };
        }
        if !unsafe { writer.canAddInput(&input) } {
            return Err(format!("{name}: the writer refused its input settings"));
        }
        unsafe { writer.addInput(&input) };
        Ok(Self { name, writer, input, t0, first: None, last: 0.0, buffers: 0, samples: 0, dropped: 0, latency: Vec::new(), error: None })
    }

    fn append(&mut self, buf: &CMSampleBuffer) {
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
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| format!("{}: finishing timed out", self.name))?;
        match unsafe { self.writer.error() } {
            Some(e) => Err(format!("{}: {}", self.name, e.localizedDescription())),
            None => Ok(()),
        }
    }

    fn report(&self, rate: Option<f64>) -> Value {
        let mut lat = self.latency.clone();
        lat.sort_by(f64::total_cmp);
        let pct = |p: f64| lat.get(((lat.len().max(1) - 1) as f64 * p) as usize).map(|v| (v * 1e4).round() / 10.0);
        let span = self.first.map(|f| self.last - f);
        let mut r = json!({
            "start": self.first.map(|f| f - self.t0),
            "span": span,
            "buffers": self.buffers,
            "dropped": self.dropped,
            "latencyMs": { "p50": pct(0.5), "p95": pct(0.95), "max": pct(1.0) },
            "error": self.error,
        });
        if let (Some(rate), Some(span)) = (rate, span) {
            // Audio written at its nominal rate against the host clock's span: how far it drifts.
            let by_samples = self.samples as f64 / rate;
            r["samples"] = json!(self.samples);
            r["driftPpm"] = json!(((by_samples - span) / span * 1e6).round());
        }
        r
    }
}

/// Sample buffers from ScreenCaptureKit: screen frames and system audio.
struct ScreenIvars {
    screen: Mutex<Option<Track>>,
    audio: Mutex<Option<Track>>,
    /// The same system audio uncompressed, to check where FFmpeg places AAC's first sample.
    audio_pcm: Mutex<Option<Track>>,
    idle: Mutex<u64>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BeaconSpikeScreenOutput"]
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
            } else if kind == SCStreamOutputType::Audio {
                for track in [&iv.audio, &iv.audio_pcm] {
                    if let Some(t) = track.lock().unwrap().as_mut() {
                        t.append(buf);
                    }
                }
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
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BeaconSpikeCaptureOutput"]
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

fn error_text(e: *mut NSError) -> Option<String> {
    unsafe { e.as_ref() }.map(|e| e.localizedDescription().to_string())
}

/// Calls an Objective-C method taking a completion block with an optional NSError, and waits for it.
fn wait_for(f: impl FnOnce(&block2::DynBlock<dyn Fn(*mut NSError)>)) -> Result<(), String> {
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

pub fn run(args: &[String]) -> Result<(), String> {
    let dir = Path::new(args.first().ok_or("usage: beacon-recorder spike <dir> [seconds]")?);
    let seconds: f64 = args.get(1).map_or(Ok(10.0), |s| s.parse()).map_err(|_| "seconds must be a number")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (video_type, audio_type) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
    let (mp4, m4a) = unsafe { (AVFileTypeMPEG4.unwrap(), AVFileTypeAppleM4A.unwrap()) };
    let camera_allowed = unsafe { AVCaptureDevice::authorizationStatusForMediaType(video_type) } == AVAuthorizationStatus::Authorized;
    let mic_allowed = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio_type) } == AVAuthorizationStatus::Authorized;

    // ScreenCaptureKit: the main display at its pixel size, no cursor, system audio at 48 kHz stereo.
    let display = crate::devices::displays()?.into_iter().next().ok_or("no display to capture (is the screen asleep?)")?;
    let (pw, ph) = unsafe {
        let f: objc2_core_foundation::CGRect = display.frame();
        let scale = { let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &objc2_foundation::NSArray::new()); filter.pointPixelScale() } as f64;
        ((f.size.width * scale) as usize, (f.size.height * scale) as usize)
    };
    let filter = unsafe { SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &objc2_foundation::NSArray::new()) };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(pw);
        config.setHeight(ph);
        config.setMinimumFrameInterval(CMTime::new(1, 60));
        config.setShowsCursor(false);
        config.setQueueDepth(8);
        config.setCapturesAudio(true);
        config.setSampleRate(48_000);
        config.setChannelCount(2);
        config.setExcludesCurrentProcessAudio(false);
    }
    let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None) };

    let screen_out = ScreenOutput::alloc().set_ivars(ScreenIvars { screen: Mutex::new(None), audio: Mutex::new(None), audio_pcm: Mutex::new(None), idle: Mutex::new(0) });
    let screen_out: Retained<ScreenOutput> = unsafe { msg_send![super(screen_out), init] };
    let screen_queue = DispatchQueue::new("beacon.record.screen", None);
    let audio_queue = DispatchQueue::new("beacon.record.system-audio", None);
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*screen_out), SCStreamOutputType::Screen, Some(&screen_queue))
            .map_err(|e| e.localizedDescription().to_string())?;
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*screen_out), SCStreamOutputType::Audio, Some(&audio_queue))
            .map_err(|e| e.localizedDescription().to_string())?;
    }

    // AVFoundation: the default camera and microphone in one session.
    let session = unsafe { AVCaptureSession::new() };
    let capture_out = CaptureOutput::alloc().set_ivars(CaptureIvars { camera: Mutex::new(None), mic: Mutex::new(None), video_output: AtomicPtr::new(std::ptr::null_mut()) });
    let capture_out: Retained<CaptureOutput> = unsafe { msg_send![super(capture_out), init] };
    let camera_queue = DispatchQueue::new("beacon.record.camera", None);
    let mic_queue = DispatchQueue::new("beacon.record.microphone", None);
    let mut skipped = Vec::new();
    let mut camera_settings = None;
    let mut mic_settings = None;
    unsafe {
        session.beginConfiguration();
        if !camera_allowed {
            skipped.push("camera: permission not granted (System Settings > Privacy & Security > Camera)");
        } else if let Some(device) = AVCaptureDevice::defaultDeviceWithMediaType(video_type) {
            let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device).map_err(|e| e.localizedDescription().to_string())?;
            let output = AVCaptureVideoDataOutput::new();
            output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*capture_out)), Some(&camera_queue));
            if session.canAddInput(&input) && session.canAddOutput(&output) {
                session.addInput(&input);
                session.addOutput(&output);
                camera_settings = output.recommendedVideoSettingsForVideoCodecType_assetWriterOutputFileType(AVVideoCodecTypeHEVC.unwrap(), mp4);
                capture_out.ivars().video_output.store(Retained::as_ptr(&output).cast::<AVCaptureOutput>().cast_mut(), Ordering::Release);
            }
        }
        if !mic_allowed {
            skipped.push("microphone: permission not granted");
        } else if let Some(device) = AVCaptureDevice::defaultDeviceWithMediaType(audio_type) {
            let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device).map_err(|e| e.localizedDescription().to_string())?;
            let output = AVCaptureAudioDataOutput::new();
            output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*capture_out)), Some(&mic_queue));
            if session.canAddInput(&input) && session.canAddOutput(&output) {
                session.addInput(&input);
                session.addOutput(&output);
                mic_settings = output.recommendedAudioSettingsForAssetWriterWithOutputFileType(m4a);
            }
        }
        session.commitConfiguration();
    }

    // Start both, then begin the take: every file holds only samples from t0 on.
    let started = Instant::now();
    wait_for(|done| unsafe { stream.startCaptureWithCompletionHandler(Some(done)) }).map_err(|e| format!("screen capture: {e}"))?;
    let sck_start_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    unsafe { session.startRunning() };
    let av_start_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Are the two frameworks' buffers on the same clock as the host?
    let clocks = unsafe {
        let host = host_now();
        let sck = stream.synchronizationClock().map(|c| c.time().seconds() - host);
        #[allow(deprecated)]
        let av: Option<f64> = {
            let c: Option<Retained<CMClock>> = msg_send![&session, synchronizationClock];
            c.map(|c| c.time().seconds() - host)
        };
        json!({ "screenCaptureKitMinusHost": sck, "captureSessionMinusHost": av })
    };

    let t0 = host_now();
    let hevc = unsafe { AVVideoCodecTypeHEVC.unwrap() };
    let screen_settings = unsafe {
        let props = dict(&[(AVVideoAverageBitRateKey.unwrap(), num(20_000_000).as_ref()), (AVVideoExpectedSourceFrameRateKey.unwrap(), num(60).as_ref())]);
        dict(&[
            (AVVideoCodecKey.unwrap(), hevc.as_ref()),
            (AVVideoWidthKey.unwrap(), num(pw as i64).as_ref()),
            (AVVideoHeightKey.unwrap(), num(ph as i64).as_ref()),
            (AVVideoCompressionPropertiesKey.unwrap(), props.as_ref()),
        ])
    };
    let aac = |rate: i64, channels: i64| {
        dict(&[
            (&NSString::from_str("AVFormatIDKey"), num(0x6161_6320).as_ref()), // kAudioFormatMPEG4AAC
            (&NSString::from_str("AVSampleRateKey"), num(rate).as_ref()),
            (&NSString::from_str("AVNumberOfChannelsKey"), num(channels).as_ref()),
            (&NSString::from_str("AVEncoderBitRateKey"), num(192_000).as_ref()),
        ])
    };
    *screen_out.ivars().screen.lock().unwrap() = Some(Track::new("screen", &dir.join("screen.mp4"), mp4, video_type, &screen_settings, t0)?);
    *screen_out.ivars().audio.lock().unwrap() = Some(Track::new("system-audio", &dir.join("system-audio.m4a"), m4a, audio_type, &aac(48_000, 2), t0)?);
    let pcm = |rate: i64, channels: i64| {
        dict(&[
            (&NSString::from_str("AVFormatIDKey"), num(0x6C70_636D).as_ref()), // kAudioFormatLinearPCM
            (&NSString::from_str("AVSampleRateKey"), num(rate).as_ref()),
            (&NSString::from_str("AVNumberOfChannelsKey"), num(channels).as_ref()),
            (&NSString::from_str("AVLinearPCMBitDepthKey"), num(16).as_ref()),
            (&NSString::from_str("AVLinearPCMIsFloatKey"), num(0).as_ref()),
            (&NSString::from_str("AVLinearPCMIsBigEndianKey"), num(0).as_ref()),
            (&NSString::from_str("AVLinearPCMIsNonInterleaved"), num(0).as_ref()),
        ])
    };
    let wav = unsafe { objc2_av_foundation::AVFileTypeWAVE.unwrap() };
    *screen_out.ivars().audio_pcm.lock().unwrap() = Some(Track::new("system-audio-pcm", &dir.join("system-audio.wav"), wav, audio_type, &pcm(48_000, 2), t0)?);
    if let Some(s) = &camera_settings {
        *capture_out.ivars().camera.lock().unwrap() = Some(Track::new("camera", &dir.join("camera.mp4"), mp4, video_type, s, t0)?);
    }
    if mic_settings.is_some() {
        let rate = mic_rate(&mic_settings) as i64;
        *capture_out.ivars().mic.lock().unwrap() = Some(Track::new("microphone", &dir.join("microphone.wav"), wav, audio_type, &pcm(rate, 1), t0)?);
    }
    println!("{}", json!({ "event": "recording", "dir": dir, "screen": [pw, ph], "skipped": skipped }));

    // Tones at known host times: heard by system audio directly, and by the microphone through the speakers.
    let mut tones = Vec::new();
    let step = if seconds <= 30.0 { 3.0 } else { 20.0 };
    let mut next = (1..).map(|i| i as f64 * step).take_while(|&at| at < seconds - 1.0).peekable();
    let begun = Instant::now();
    while begun.elapsed().as_secs_f64() < seconds {
        if next.peek().is_some_and(|&at| begun.elapsed().as_secs_f64() >= at) {
            next.next();
            tones.push(host_now() - t0);
            let _ = std::process::Command::new("afplay").arg("/System/Library/Sounds/Ping.aiff").spawn();
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let end = unsafe { CMClock::host_time_clock().time() };
    wait_for(|done| unsafe { stream.stopCaptureWithCompletionHandler(Some(done)) }).map_err(|e| format!("stopping screen capture: {e}"))?;
    unsafe { session.stopRunning() };
    let take = |m: &Mutex<Option<Track>>| m.lock().unwrap().take();
    let tracks = [
        (take(&screen_out.ivars().screen), None),
        (take(&screen_out.ivars().audio), Some(48_000.0)),
        (take(&screen_out.ivars().audio_pcm), Some(48_000.0)),
        (take(&capture_out.ivars().camera), None),
        (take(&capture_out.ivars().mic), Some(mic_rate(&mic_settings))),
    ];
    let mut streams = serde_json::Map::new();
    let mut errors = Vec::new();
    for (t, rate) in tracks.iter().filter_map(|(t, r)| t.as_ref().map(|t| (t, *r))) {
        if let Err(e) = t.finish(end) {
            errors.push(e);
        }
        streams.insert(t.name.into(), t.report(rate));
    }
    let data = json!({
        "event": "done",
        "seconds": seconds,
        "startMs": { "screenCaptureKit": sck_start_ms, "captureSession": av_start_ms },
        "clocks": clocks,
        "idleScreenCallbacks": *screen_out.ivars().idle.lock().unwrap(),
        "tones": tones,
        "streams": streams,
        "errors": errors,
        "skipped": skipped,
    });
    std::fs::write(dir.join("data.json"), serde_json::to_vec_pretty(&data).unwrap()).map_err(|e| e.to_string())?;
    println!("{data}");
    Ok(())
}

fn mic_rate(settings: &Option<Retained<NSDictionary<NSString, AnyObject>>>) -> f64 {
    settings
        .as_ref()
        .and_then(|s| s.objectForKey(&NSString::from_str("AVSampleRateKey")))
        .and_then(|v| v.downcast::<NSNumber>().ok())
        .map_or(48_000.0, |n| n.doubleValue())
}
