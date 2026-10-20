use std::ffi::c_void;

use dispatch2::DispatchQueue;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};

/// Hands the keys back to the window's page. Electrobun, as the window becomes key, makes its first
/// WGPU view (the canvas) the first responder, and that view keeps the keys: shortcuts waited for a
/// click on the page after switching apps. Leaves any other first responder alone.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_focus_page(window: *mut c_void) {
    if window.is_null() {
        return;
    }
    let window = window as usize;
    // AppKit's responders belong to the main thread; Bun calls from its own.
    DispatchQueue::main().exec_async(move || unsafe { focus_page(window as *mut AnyObject) });
}

unsafe fn focus_page(window: *mut AnyObject) {
    let (Some(canvas), Some(page)) = (AnyClass::get(c"WGPUInputView"), AnyClass::get(c"WKWebView")) else { return };
    unsafe {
        let responder: *mut AnyObject = msg_send![window, firstResponder];
        if responder.is_null() || !is_kind(responder, canvas) {
            return;
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        if let Some(view) = find(content, page) {
            let _: Bool = msg_send![window, makeFirstResponder: view];
        }
    }
}

unsafe fn is_kind(object: *mut AnyObject, class: &AnyClass) -> bool {
    let kind: Bool = unsafe { msg_send![object, isKindOfClass: class] };
    kind.as_bool()
}

unsafe fn find(view: *mut AnyObject, class: &AnyClass) -> Option<*mut AnyObject> {
    if view.is_null() {
        return None;
    }
    unsafe {
        if is_kind(view, class) {
            return Some(view);
        }
        let subviews: *mut AnyObject = msg_send![view, subviews];
        let count: usize = msg_send![subviews, count];
        (0..count).find_map(|i| {
            let child: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            find(child, class)
        })
    }
}
