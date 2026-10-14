//! Where the Mac's sound goes: its output devices through CoreAudio, which of them are headphones (a sync
//! check's beeps must reach the microphone through speakers), and switching the default output.
use std::ffi::c_void;

use objc2_core_foundation::CFString;
use serde_json::{Value, json};

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyDataSize(id: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
    fn AudioObjectGetPropertyData(id: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
    fn AudioObjectSetPropertyData(id: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: u32, data: *const c_void) -> i32;
}

const fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

const SYSTEM: u32 = 1;
const GLOBAL: u32 = code(b"glob");
const OUTPUT: u32 = code(b"outp");
const INPUT: u32 = code(b"inpt");

fn address(selector: &[u8; 4], scope: u32) -> Address {
    Address { selector: code(selector), scope, element: 0 }
}

fn get<T: Copy + Default>(id: u32, selector: &[u8; 4], scope: u32) -> Option<T> {
    let mut value = T::default();
    let mut size = size_of::<T>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(id, &address(selector, scope), 0, std::ptr::null(), &mut size, (&raw mut value).cast()) };
    (status == 0).then_some(value)
}

fn get_list(id: u32, selector: &[u8; 4], scope: u32) -> Vec<u32> {
    let a = address(selector, scope);
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0 {
        return vec![];
    }
    let mut out = vec![0u32; size as usize / 4];
    if unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, out.as_mut_ptr().cast()) } != 0 {
        return vec![];
    }
    out.truncate(size as usize / 4);
    out
}

fn get_string(id: u32, selector: &[u8; 4]) -> Option<String> {
    let mut s: *const CFString = std::ptr::null();
    let mut size = size_of::<*const CFString>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(id, &address(selector, GLOBAL), 0, std::ptr::null(), &mut size, (&raw mut s).cast()) };
    if status != 0 || s.is_null() {
        return None;
    }
    // The property hands over a +1 reference.
    let s = unsafe { objc2_core_foundation::CFRetained::from_raw(std::ptr::NonNull::new_unchecked(s.cast_mut())) };
    Some(s.to_string())
}

/// What carries a device's sound, as people say it, and whether the room hears it (not headphones, not virtual).
fn kind(id: u32, microphones: &[String]) -> (&'static str, bool) {
    let transport = get::<u32>(id, b"tran", GLOBAL).unwrap_or(0);
    match transport.to_be_bytes().as_slice() {
        b"blue" | b"bleo" => ("bluetooth", false),
        // The Mac's own output is its speakers or, with something in the jack, headphones.
        b"bltn" => match get::<u32>(id, b"ssrc", OUTPUT).map(u32::to_be_bytes) {
            Some(s) if &s == b"hdpn" => ("headphones", false),
            _ => ("built-in", true),
        },
        b"hdmi" | b"dprt" => ("display", true),
        // A USB device that is also a microphone (by name: CoreAudio may list its two halves apart) plays into
        // its own headphone jack: a headset, a Yeti.
        b"usb " => ("usb", get_list(id, b"stm#", INPUT).is_empty() && !get_string(id, b"lnam").is_some_and(|n| microphones.contains(&n))),
        b"airp" => ("airplay", true),
        b"virt" | b"grup" => ("virtual", false),
        _ => ("other", true),
    }
}

/// Every device that plays sound: `{id, name, kind, speakers, default}`, its `id` its CoreAudio UID and
/// `speakers` whether the room (and so a microphone) hears it.
pub fn list() -> Vec<Value> {
    let default = get::<u32>(SYSTEM, b"dOut", GLOBAL);
    let devices = get_list(SYSTEM, b"dev#", GLOBAL);
    let microphones: Vec<String> = devices.iter().filter(|&&d| !get_list(d, b"stm#", INPUT).is_empty()).filter_map(|&d| get_string(d, b"lnam")).collect();
    devices
        .into_iter()
        .filter(|&d| !get_list(d, b"stm#", OUTPUT).is_empty())
        .filter_map(|d| {
            let (kind, speakers) = kind(d, &microphones);
            Some(json!({ "id": get_string(d, b"uid ")?, "name": get_string(d, b"lnam").unwrap_or_default(), "kind": kind, "speakers": speakers, "default": Some(d) == default }))
        })
        .collect()
}

/// Makes the device with this UID the Mac's sound output; returns the UID of the one it replaced.
pub fn set_default(uid: &str) -> Result<Option<String>, String> {
    let target = get_list(SYSTEM, b"dev#", GLOBAL).into_iter().find(|&d| get_string(d, b"uid ").as_deref() == Some(uid)).ok_or_else(|| format!("no sound output \"{uid}\""))?;
    let before = get::<u32>(SYSTEM, b"dOut", GLOBAL).and_then(|d| get_string(d, b"uid "));
    let status = unsafe { AudioObjectSetPropertyData(SYSTEM, &address(b"dOut", GLOBAL), 0, std::ptr::null(), size_of::<u32>() as u32, (&raw const target).cast()) };
    if status != 0 {
        return Err(format!("couldn't switch the sound output (CoreAudio {status})"));
    }
    Ok(before)
}
