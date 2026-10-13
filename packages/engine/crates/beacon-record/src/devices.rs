use std::sync::mpsc;

use block2::RcBlock;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio, AVMediaTypeVideo};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCDisplay, SCShareableContent};
use serde_json::{Value, json};

unsafe extern "C" {
    /// CoreGraphics: whether this process may capture the screen, without asking.
    fn CGPreflightScreenCaptureAccess() -> bool;
}

fn status(s: AVAuthorizationStatus) -> &'static str {
    match s {
        AVAuthorizationStatus::Authorized => "granted",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Restricted => "restricted",
        _ => "not asked",
    }
}

/// The displays ScreenCaptureKit can capture (fails without the Screen Recording permission).
pub fn displays() -> Result<Vec<objc2::rc::Retained<SCDisplay>>, String> {
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let r = match unsafe { content.as_ref() } {
            Some(c) => Ok(unsafe { c.displays() }.to_vec()),
            None => Err(unsafe { error.as_ref() }.map_or("no shareable content".into(), |e| e.localizedDescription().to_string())),
        };
        let _ = tx.send(r);
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&done) };
    rx.recv().map_err(|e| e.to_string())?
}

fn capture_devices(video: bool) -> Vec<Value> {
    let Some(kind) = (unsafe { if video { AVMediaTypeVideo } else { AVMediaTypeAudio } }) else { return vec![] };
    #[allow(deprecated)]
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(kind) };
    devices.iter().map(|d| json!({ "id": unsafe { d.uniqueID() }.to_string(), "name": unsafe { d.localizedName() }.to_string() })).collect()
}

pub fn run() -> Result<(), String> {
    let (video, audio) = unsafe { (AVMediaTypeVideo.unwrap(), AVMediaTypeAudio.unwrap()) };
    let screen = unsafe { CGPreflightScreenCaptureAccess() };
    let displays = if screen {
        displays()
            .map(|ds| ds.iter().map(|d| unsafe { json!({ "id": d.displayID(), "width": d.width(), "height": d.height() }) }).collect::<Vec<_>>())
            .unwrap_or_else(|e| vec![json!({ "error": e })])
    } else {
        vec![]
    };
    let out = json!({
        "event": "devices",
        "permissions": {
            "screen": if screen { "granted" } else { "not granted" },
            "camera": status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(video) }),
            "microphone": status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) }),
        },
        "displays": displays,
        "cameras": capture_devices(true),
        "microphones": capture_devices(false),
    });
    println!("{out}");
    Ok(())
}
