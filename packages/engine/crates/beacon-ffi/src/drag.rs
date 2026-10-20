use std::ffi::c_char;
use std::ptr;

use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
use objc2_foundation::NSURL;

use crate::{c_string, guard};

/// The files of the last drag (the drop just received, until another drag starts) as a JSON array of
/// paths: the webview tells a drop's files only by name, size and date. Free with `beacon_string_free`.
#[unsafe(no_mangle)]
pub extern "C" fn beacon_drag_files() -> *mut c_char {
    guard(ptr::null_mut(), || {
        let board = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
        c_string(serde_json::to_string(&file_paths(&board)).map_err(|e| e.to_string())?)
    })
}

fn file_paths(board: &NSPasteboard) -> Vec<String> {
    let Some(items) = board.pasteboardItems() else { return Vec::new() };
    items
        .iter()
        .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
        .filter_map(|url| NSURL::URLWithString(&url))
        .filter_map(|url| url.path())
        .map(|path| path.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use objc2::AnyThread;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    #[test]
    fn a_drags_file_urls_come_back_as_paths() {
        let board = NSPasteboard::pasteboardWithUniqueName();
        board.clearContents();
        let urls = ["/Volumes/CARD/DCIM/107_PANA/P1078391.MP4", "/tmp/a b/c.mov"]
            .map(|p| NSURL::initFileURLWithPath(NSURL::alloc(), &NSString::from_str(p)));
        let writers: Vec<_> = urls.iter().map(|u| ProtocolObject::<dyn NSPasteboardWriting>::from_ref(&**u)).collect();
        assert!(board.writeObjects(&NSArray::from_slice(&writers)));
        assert_eq!(super::file_paths(&board), ["/Volumes/CARD/DCIM/107_PANA/P1078391.MP4", "/tmp/a b/c.mov"]);
        let _: () = unsafe { objc2::msg_send![&*board, releaseGlobally] };
    }
}
