use std::sync::mpsc;

use block2::RcBlock;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio, AVMediaTypeVideo};
use objc2_foundation::NSError;
use objc2::{AllocAnyThread, Message};
use objc2::rc::Retained;
use objc2_foundation::NSArray;
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCShareableContent, SCWindow};
use serde_json::{Value, json};

unsafe extern "C" {
    /// CoreGraphics: whether this process may capture the screen, without asking.
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
}

/// Which displays, cameras and microphones there are, to notice one connected or removed; cheap enough to ask every second.
pub fn present() -> Vec<String> {
    let mut ids = [0u32; 32];
    let mut count = 0u32;
    let mut out: Vec<String> = if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } == 0 {
        ids[..count as usize].iter().map(|d| format!("display {d}")).collect()
    } else {
        Vec::new()
    };
    for kind in unsafe { [AVMediaTypeVideo, AVMediaTypeAudio] }.into_iter().flatten() {
        #[allow(deprecated)]
        out.extend(unsafe { AVCaptureDevice::devicesWithMediaType(kind) }.iter().map(|d| unsafe { d.uniqueID() }.to_string()));
    }
    out.sort();
    out
}

fn status(s: AVAuthorizationStatus) -> &'static str {
    match s {
        AVAuthorizationStatus::Authorized => "granted",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Restricted => "restricted",
        _ => "not asked",
    }
}

/// What ScreenCaptureKit can capture (fails without the Screen Recording permission).
fn content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let r = match unsafe { content.as_ref() } {
            Some(c) => Ok(c.retain()),
            None => Err(unsafe { error.as_ref() }.map_or("no shareable content".into(), |e| e.localizedDescription().to_string())),
        };
        let _ = tx.send(r);
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&done) };
    rx.recv().map_err(|e| e.to_string())?
}

/// The displays ScreenCaptureKit can capture.
pub fn displays() -> Result<Vec<Retained<SCDisplay>>, String> {
    Ok(unsafe { content()?.displays() }.to_vec())
}

/// A display to capture (the main one when `display` is None), leaving out windows titled `exclude` (Beacon's
/// recording panel, which floats over what is recorded).
pub fn display_filter(display: Option<u32>, exclude: Option<&str>) -> Result<(Retained<SCContentFilter>, Retained<SCDisplay>), String> {
    let content = content()?;
    let displays = unsafe { content.displays() };
    let display = match display {
        Some(id) => displays.iter().find(|d| unsafe { d.displayID() } == id).ok_or_else(|| format!("no display {id}"))?,
        None => displays.iter().next().ok_or("no display to capture (is the screen asleep?)")?,
    };
    let windows: Vec<Retained<SCWindow>> = match exclude {
        Some(title) => unsafe { content.windows() }.iter().filter(|w| unsafe { w.title() }.is_some_and(|t| t.to_string() == title)).collect(),
        None => Vec::new(),
    };
    let filter = unsafe { SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::from_retained_slice(&windows)) };
    Ok((filter, display))
}

fn capture_devices(video: bool) -> Vec<Value> {
    let Some(kind) = (unsafe { if video { AVMediaTypeVideo } else { AVMediaTypeAudio } }) else { return vec![] };
    #[allow(deprecated)]
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(kind) };
    devices
        .iter()
        .map(|d| {
            let mut v = json!({ "id": unsafe { d.uniqueID() }.to_string(), "name": unsafe { d.localizedName() }.to_string() });
            // A camera's size and rate are its active format's, as a take records them.
            if video {
                let (dims, frame) = unsafe { (objc2_core_media::CMVideoFormatDescriptionGetDimensions(&d.activeFormat().formatDescription()), d.activeVideoMinFrameDuration()) };
                let secs = unsafe { frame.seconds() };
                v["width"] = json!(dims.width);
                v["height"] = json!(dims.height);
                v["fps"] = json!(if secs > 0.0 { (1.0 / secs).round() as i64 } else { 30 });
            }
            v
        })
        .collect()
}

/// Asks for the camera or microphone permission (macOS shows its prompt the first time); the status after.
pub fn request(kind: &str) -> Result<Value, String> {
    let media = match kind {
        "camera" => unsafe { AVMediaTypeVideo.unwrap() },
        "microphone" => unsafe { AVMediaTypeAudio.unwrap() },
        _ => return Err(format!("no permission \"{kind}\" to ask for: camera or microphone")),
    };
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |granted: objc2::runtime::Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &done) };
    rx.recv().map_err(|e| e.to_string())?;
    Ok(json!({ "event": "access", "kind": kind, "status": status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) }) }))
}

/// Permissions, displays, cameras and microphones, as `{"event":"devices",…}`.
pub fn list() -> Value {
    let (video, audio) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
    let screen = unsafe { CGPreflightScreenCaptureAccess() };
    let displays = if screen {
        displays()
            // `x`, `y`: its top-left in global points (the main display's top-left is 0, 0), to put a window on it.
            .map(|ds| {
                ds.iter()
                    // `pixelWidth`, `pixelHeight`: the size a take records it at (points by the backing scale), as capture sizes it.
                    .map(|d| unsafe {
                        let f = d.frame();
                        let scale = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), d, &NSArray::new()).pointPixelScale() as f64;
                        let (pw, ph) = crate::capture::record_size((f.size.width * scale) as usize, (f.size.height * scale) as usize);
                        json!({ "id": d.displayID(), "width": d.width(), "height": d.height(), "pixelWidth": pw, "pixelHeight": ph, "x": f.origin.x, "y": f.origin.y })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|e| vec![json!({ "error": e })])
    } else {
        vec![]
    };
    json!({
        "event": "devices",
        "permissions": {
            "screen": if screen { "granted" } else { "not granted" },
            "camera": status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(video) }),
            "microphone": status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) }),
        },
        "displays": displays,
        "cameras": capture_devices(true),
        "outputs": crate::outputs::list(),
        "microphones": capture_devices(false),
    })
}
