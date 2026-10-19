//! Sharp cursors: a recording stores the cursor as a small bitmap (1x or 2x),
//! which blurs when the cursor is drawn larger. macOS draws its cursors from
//! vector PDFs, so a recorded image is swapped for the system cursor it shows
//! (the same size, and the same pixels when drawn at the recording's scale),
//! drawn at `PIXELS_PER_POINT`. Images that match nothing stay bitmaps.
//!
//! HIServices has most cursors as PDFs with their hotspot and shadow; the
//! arrow and I-beam are only in Accessibility's pointer-colour set, as an
//! fill layer and an outline layer that the system tints.

use std::ffi::c_void;
use std::path::Path;
use std::sync::OnceLock;

use core_foundation::base::TCFType;
use core_foundation::url::{CFURL, CFURLRef};
use core_graphics::base::{kCGBitmapByteOrder32Big, kCGImageAlphaPremultipliedLast};
use core_graphics::color::CGColor;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::sys::CGContextRef;
use foreign_types::ForeignType;

use crate::sources::Pixels;

const CURSORS: &str = "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/cursors";
const LAYERED: [&str; 2] = [
    "/System/Library/PrivateFrameworks/AccessibilitySupport.framework/Versions/A/Frameworks/AccessibilityFoundation.framework/Versions/A/Resources/Cursors-macOS16",
    "/System/Library/PrivateFrameworks/AccessibilitySupport.framework/Versions/A/Frameworks/AccessibilityFoundation.framework/Versions/A/Resources/Cursors",
];
/// Enough for the 3x cursor scales recordings use, drawn on a large screen.
pub const PIXELS_PER_POINT: f64 = 8.0;
/// Mean difference per channel (0-255) below which a system cursor is taken to be the recorded one.
const MATCH: f64 = 1.5;

/// A system cursor: its PDF layers, bottom first, each drawn as is or tinted
/// (grey level); its hotspot when known, size and shadow, in points.
struct Vector {
    layers: Vec<(String, Option<f64>)>,
    hot: Option<[f64; 2]>,
    size: [f64; 2],
    blur: f64,
    offset: [f64; 2],
    shadow: f64,
}

/// The recorded cursor `rec` (premultiplied RGBA, `scale` points per pixel,
/// hotspot in pixels) drawn sharp at `PIXELS_PER_POINT`, if it is a macOS cursor.
pub fn sharp(rec: &Pixels, scale: f64, hot: [f64; 2]) -> Option<Pixels> {
    let ppp = 1.0 / scale;
    let size = [rec.width as f64 * scale, rec.height as f64 * scale];
    let hot = [hot[0] * scale, hot[1] * scale];
    let mut best: Option<(f64, &Vector)> = None;
    static CANDIDATES: OnceLock<Vec<Vector>> = OnceLock::new();
    for v in CANDIDATES.get_or_init(candidates) {
        let off = |a: f64, b: f64| (a - b).abs() > 0.5;
        if off(v.size[0], size[0]) || off(v.size[1], size[1]) || v.hot.is_some_and(|h| off(h[0], hot[0]) || off(h[1], hot[1])) {
            continue;
        }
        let Some(px) = render(v, ppp, (rec.width, rec.height)) else { continue };
        let diff: f64 = rec.data.iter().zip(&px.data).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / rec.data.len() as f64;
        if diff < MATCH && best.as_ref().is_none_or(|(d, _)| diff < *d) {
            best = Some((diff, v));
        }
    }
    let (_, v) = best?;
    let k = PIXELS_PER_POINT;
    render(v, k, ((size[0] * k).round() as u32, (size[1] * k).round() as u32))
}

/// Every system cursor.
fn candidates() -> Vec<Vector> {
    let mut out = Vec::new();
    // HIServices' shadow, the same for every cursor there.
    let (blur, offset, shadow) = (2.0, [0.0, -1.0], 0.45);
    for dir in LAYERED {
        let Ok(files) = std::fs::read_dir(dir) else { continue };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix("-top.pdf") else { continue };
            let (top, bottom) = (format!("{dir}/{stem}-top.pdf"), format!("{dir}/{stem}-bottom.pdf"));
            let Some(size) = page_size(Path::new(&top)) else { continue };
            // The fill is the bottom layer: white for hands, black for the arrow and I-beam.
            for (fill, outline) in [(1.0, 0.0), (0.0, 1.0)] {
                out.push(Vector { layers: vec![(bottom.clone(), Some(fill)), (top.clone(), Some(outline))], hot: None, size, blur, offset, shadow });
            }
        }
    }
    let Ok(dirs) = std::fs::read_dir(CURSORS) else { return out };
    for d in dirs.flatten() {
        let dir = d.path();
        let (Ok(plist), Some(size)) = (std::fs::read_to_string(dir.join("info.plist")), page_size(&dir.join("cursor.pdf"))) else { continue };
        // Animated cursors stack their frames in one tall page.
        if number(&plist, "frames").unwrap_or(1.0) != 1.0 {
            continue;
        }
        out.push(Vector {
            layers: vec![(dir.join("cursor.pdf").to_string_lossy().into_owned(), None)],
            hot: Some([number(&plist, "hotx").unwrap_or(0.0), number(&plist, "hoty").unwrap_or(0.0)]),
            size,
            blur: number(&plist, "blur").unwrap_or(0.0),
            offset: [number(&plist, "shadowoffsetx").unwrap_or(0.0), number(&plist, "shadowoffsety").unwrap_or(0.0)],
            shadow: shadow_alpha(&plist).unwrap_or(0.0),
        });
    }
    out
}

/// A `<real>` or `<integer>` value from an XML plist.
fn number(plist: &str, key: &str) -> Option<f64> {
    let tag = format!("<key>{key}</key>");
    let rest = &plist[plist.find(&tag)? + tag.len()..];
    let value = &rest[rest.find('>')? + 1..];
    value[..value.find('<')?].trim().parse().ok()
}

/// The alpha of `shadowcolor` (an array of four reals).
fn shadow_alpha(plist: &str) -> Option<f64> {
    let rest = &plist[plist.find("<key>shadowcolor</key>")?..];
    let array = &rest[..rest.find("</array>")?];
    array.split("<real>").nth(4).or_else(|| array.split("<integer>").nth(4))?.split('<').next()?.trim().parse().ok()
}

#[allow(non_snake_case)]
unsafe extern "C" {
    fn CGPDFDocumentCreateWithURL(url: CFURLRef) -> *mut c_void;
    fn CGPDFDocumentRelease(doc: *mut c_void);
    fn CGPDFDocumentGetPage(doc: *mut c_void, page: usize) -> *mut c_void;
    fn CGPDFPageGetBoxRect(page: *mut c_void, box_: i32) -> CGRect;
    fn CGContextDrawPDFPage(ctx: CGContextRef, page: *mut c_void);
}

struct Pdf(*mut c_void);

impl Pdf {
    fn open(path: &Path) -> Option<Self> {
        let url = CFURL::from_path(path, false)?;
        let doc = unsafe { CGPDFDocumentCreateWithURL(url.as_concrete_TypeRef()) };
        (!doc.is_null()).then_some(Self(doc))
    }

    fn page(&self) -> Option<*mut c_void> {
        let page = unsafe { CGPDFDocumentGetPage(self.0, 1) };
        (!page.is_null()).then_some(page)
    }
}

impl Drop for Pdf {
    fn drop(&mut self) {
        unsafe { CGPDFDocumentRelease(self.0) }
    }
}

fn page_size(path: &Path) -> Option<[f64; 2]> {
    let pdf = Pdf::open(path)?;
    let r = unsafe { CGPDFPageGetBoxRect(pdf.page()?, 0) };
    Some([r.size.width, r.size.height])
}

/// A Core Graphics context drawing into `data`: `w` × `h` premultiplied RGBA.
pub(crate) fn bitmap(data: &mut [u8], w: usize, h: usize) -> CGContext {
    CGContext::create_bitmap_context(Some(data.as_mut_ptr() as *mut _), w, h, 8, w * 4, &CGColorSpace::create_device_rgb(), kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big)
}

/// The cursor at `ppp` pixels per point on a `size` pixel canvas, with its shadow, premultiplied.
fn render(v: &Vector, ppp: f64, size: (u32, u32)) -> Option<Pixels> {
    let (w, h) = (size.0 as usize, size.1 as usize);
    let mut shape = vec![0u8; w * h * 4];
    for (pdf, tint) in &v.layers {
        let pdf = Pdf::open(Path::new(pdf))?;
        let page = pdf.page()?;
        let mut layer = vec![0u8; w * h * 4];
        {
            let ctx = bitmap(&mut layer, w, h);
            ctx.scale(ppp, ppp);
            unsafe { CGContextDrawPDFPage(ctx.as_ptr() as CGContextRef, page) };
        }
        for (d, s) in shape.as_chunks_mut::<4>().0.iter_mut().zip(layer.as_chunks::<4>().0) {
            let a = s[3] as f64 / 255.0;
            let src = |c: u8| tint.map_or(c as f64, |g| g * 255.0 * a);
            for c in 0..3 {
                d[c] = (src(s[c]) + d[c] as f64 * (1.0 - a)).round() as u8;
            }
            d[3] = (s[3] as f64 + d[3] as f64 * (1.0 - a)).round() as u8;
        }
    }
    let mut out = vec![0u8; w * h * 4];
    {
        let image = bitmap(&mut shape, w, h).create_image()?;
        let ctx = bitmap(&mut out, w, h);
        // Shadows are in device space, not scaled with the drawing.
        ctx.set_shadow_with_color(CGSize::new(v.offset[0] * ppp, v.offset[1] * ppp), v.blur * ppp, &CGColor::rgb(0.0, 0.0, 0.0, v.shadow));
        ctx.draw_image(CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(w as f64, h as f64)), &image);
    }
    Some(Pixels { width: size.0, height: size.1, data: out })
}
