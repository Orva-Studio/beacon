//! Text for callouts, laid out and rasterized with Core Text so it uses the
//! system's fonts.

use core_foundation::attributed_string::CFMutableAttributedString;
use core_foundation::base::{CFRange, TCFType};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::base::{kCGBitmapByteOrder32Big, kCGImageAlphaPremultipliedLast};
use core_graphics::color::CGColor;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::path::CGPath;
use core_text::font::{self, CTFont};
use core_text::font_collection;
use core_text::font_descriptor::{SymbolicTraitAccessors, TraitAccessors};
use core_text::framesetter::CTFramesetter;
use core_text::string_attributes::{kCTFontAttributeName, kCTForegroundColorAttributeName, kCTKernAttributeName};
use serde::Deserialize;

use crate::sources::Pixels;
use crate::{Error, Result};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub text: String,
    /// Font family, e.g. "Suisse Intl".
    pub font: String,
    /// CSS weight, 100–900.
    #[serde(default = "regular")]
    pub weight: f64,
    #[serde(default)]
    pub italic: bool,
    /// Points, in box units.
    pub size: f64,
    /// Straight RGBA, 0–1.
    pub color: [f64; 4],
    /// Extra space between characters, in points.
    #[serde(default)]
    pub tracking: f64,
    /// Extra space between lines, in points.
    #[serde(default)]
    pub line_spacing: f64,
    /// "left" | "center" | "right"
    #[serde(default = "center")]
    pub align: String,
    /// "top" | "center" | "bottom"
    #[serde(default = "center")]
    pub valign: String,
    /// The text box, in box units.
    pub width: f64,
    pub height: f64,
    /// Raster pixels per box unit.
    #[serde(default = "unit")]
    pub scale: f64,
}

fn regular() -> f64 {
    400.0
}
fn center() -> String {
    "center".into()
}
fn unit() -> f64 {
    1.0
}

/// CSS weight → Core Text's normalized weight (-1…1); Apple's NSFontWeight values.
fn ct_weight(css: f64) -> f64 {
    const TABLE: [(f64, f64); 9] =
        [(100.0, -0.8), (200.0, -0.6), (300.0, -0.4), (400.0, 0.0), (500.0, 0.23), (600.0, 0.3), (700.0, 0.4), (800.0, 0.56), (900.0, 0.62)];
    let i = TABLE.partition_point(|(w, _)| *w < css).clamp(1, TABLE.len() - 1);
    let ((w0, v0), (w1, v1)) = (TABLE[i - 1], TABLE[i]);
    v0 + (v1 - v0) * ((css - w0) / (w1 - w0)).clamp(0.0, 1.0)
}

/// What a family that isn't installed (a project made on another Mac) is drawn in: every Mac has it.
const FALLBACK: &str = "Helvetica Neue";

/// The family member closest to the wanted weight and slant.
fn find_font(spec: &TextSpec, size: f64) -> Result<CTFont> {
    let faces = |name: &str| font_collection::create_for_family(name).and_then(|c| c.get_descriptors()).filter(|d| !d.is_empty());
    let family = faces(&spec.font).or_else(|| faces(FALLBACK)).ok_or_else(|| Error::Source(format!("font \"{}\" is not installed", spec.font)))?;
    let want = ct_weight(spec.weight);
    let best = family
        .iter()
        .min_by(|a, b| {
            let score = |d: &core_text::font_descriptor::CTFontDescriptor| {
                let t = d.traits();
                (t.normalized_weight() - want).abs() + if t.symbolic_traits().is_italic() != spec.italic { 10.0 } else { 0.0 }
            };
            score(a).total_cmp(&score(b))
        })
        .ok_or_else(|| Error::Source(format!("font \"{}\" has no faces", spec.font)))?;
    Ok(font::new_from_descriptor(&best, size))
}

/// Core Text's lines for a spec, each with where `render` draws it: x of its start and its baseline, in
/// raster pixels with y up from the box's bottom.
struct Laid {
    lines: Vec<core_text::line::CTLine>,
    at: Vec<(f64, f64)>,
    w: usize,
    h: usize,
}

fn lay_out(spec: &TextSpec) -> Result<Laid> {
    let s = spec.scale.max(0.01);
    let (w, h) = ((spec.width * s).round().max(1.0) as usize, (spec.height * s).round().max(1.0) as usize);
    let font = find_font(spec, spec.size * s)?;

    let mut string = CFMutableAttributedString::new();
    string.replace_str(&CFString::new(&spec.text), CFRange::init(0, 0));
    let range = CFRange::init(0, string.char_len());
    let [r, g, b, a] = spec.color;
    unsafe {
        string.set_attribute(range, kCTFontAttributeName, &font);
        string.set_attribute(range, kCTForegroundColorAttributeName, &CGColor::rgb(r, g, b, a));
        if spec.tracking != 0.0 {
            string.set_attribute(range, kCTKernAttributeName, &CFNumber::from(spec.tracking * s));
        }
    }

    let framesetter = CTFramesetter::new_with_attributed_string(string.as_concrete_TypeRef());
    // Lay out in a very tall box so nothing is dropped; vertical alignment is ours.
    let tall = 1.0e6;
    let path = CGPath::from_rect(CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(w as f64, tall)), None);
    let frame = framesetter.create_frame(CFRange::init(0, 0), &path);
    let lines: Vec<_> = frame.get_lines().to_vec();
    let origins = frame.get_line_origins(CFRange::init(0, 0));
    let mut at = Vec::with_capacity(lines.len());
    if let (Some(first), Some(last)) = (lines.first(), lines.last()) {
        let top = origins[0].y + first.get_typographic_bounds().ascent;
        let bottom = origins[origins.len() - 1].y - last.get_typographic_bounds().descent;
        let spacing = spec.line_spacing * s;
        let content = top - bottom + spacing * (lines.len() as f64 - 1.0);
        // Moves the laid-out block (y up) so its top lands where the alignment wants it.
        let shift = match spec.valign.as_str() {
            "top" => h as f64 - top,
            "bottom" => content - top,
            _ => (h as f64 + content) / 2.0 - top,
        };
        for (i, (line, origin)) in lines.iter().zip(origins.iter()).enumerate() {
            let width = line.get_typographic_bounds().width - trailing_space(line);
            let x = match spec.align.as_str() {
                "left" => 0.0,
                "right" => w as f64 - width,
                _ => (w as f64 - width) / 2.0,
            };
            at.push((x, origin.y + shift - spacing * i as f64));
        }
    }
    Ok(Laid { lines, at, w, h })
}

pub fn render(spec: &TextSpec) -> Result<Pixels> {
    let Laid { lines, at, w, h } = lay_out(spec)?;
    let mut data = vec![0u8; w * h * 4];
    let ctx = CGContext::create_bitmap_context(
        Some(data.as_mut_ptr() as *mut _),
        w,
        h,
        8,
        w * 4,
        &CGColorSpace::create_device_rgb(),
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big,
    );
    ctx.set_should_antialias(true);
    ctx.set_allows_font_smoothing(false);
    for (line, (x, y)) in lines.iter().zip(at) {
        ctx.set_text_position(x, y);
        line.draw(&ctx);
    }
    drop(ctx);
    Ok(Pixels { width: w as u32, height: h as u32, data })
}

/// Every font family installed, sorted, for the callout's font menu.
pub fn families() -> Vec<String> {
    let mut names: Vec<String> = font_collection::get_family_names().iter().map(|n| n.to_string()).filter(|n| !n.starts_with('.')).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// One laid-out line, in box units with y down from the box's top: for drawing a caret and selection over
/// the text `render` draws.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LineLayout {
    /// UTF-16 offsets into the text (as JavaScript counts), `end` exclusive.
    pub start: usize,
    pub end: usize,
    pub top: f64,
    pub bottom: f64,
    /// The caret's x before each offset from `start` to `end`.
    pub carets: Vec<f64>,
}

pub fn layout(spec: &TextSpec) -> Result<Vec<LineLayout>> {
    let Laid { lines, at, h, .. } = lay_out(spec)?;
    let s = spec.scale.max(0.01);
    Ok(lines
        .iter()
        .zip(at)
        .map(|(line, (x, y))| {
            let r = unsafe { CTLineGetStringRange(line.as_concrete_TypeRef()) };
            let (start, end) = (r.location as usize, (r.location + r.length) as usize);
            let b = line.get_typographic_bounds();
            let carets = (start..=end)
                .map(|i| (x + unsafe { CTLineGetOffsetForStringIndex(line.as_concrete_TypeRef(), i as isize, std::ptr::null_mut()) }) / s)
                .collect();
            LineLayout { start, end, top: (h as f64 - (y + b.ascent)) / s, bottom: (h as f64 - (y - b.descent)) / s, carets }
        })
        .collect())
}

fn trailing_space(line: &core_text::line::CTLine) -> f64 {
    unsafe { CTLineGetTrailingWhitespaceWidth(line.as_concrete_TypeRef()) }
}

unsafe extern "C" {
    fn CTLineGetTrailingWhitespaceWidth(line: core_text::line::CTLineRef) -> f64;
    fn CTLineGetStringRange(line: core_text::line::CTLineRef) -> CFRange;
    fn CTLineGetOffsetForStringIndex(line: core_text::line::CTLineRef, index: isize, secondary: *mut f64) -> f64;
}

/// Polylines stroked with round caps and joins (sketch callouts).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StrokeSpec {
    /// Points in box units, y down.
    pub lines: Vec<Vec<[f64; 2]>>,
    pub width: f64,
    pub height: f64,
    pub stroke_width: f64,
    /// Straight RGBA, 0–1.
    pub color: [f64; 4],
    /// Raster pixels per box unit.
    #[serde(default = "unit")]
    pub scale: f64,
}

pub fn render_strokes(spec: &StrokeSpec) -> Result<Pixels> {
    use core_graphics::context::{CGLineCap, CGLineJoin};
    let s = spec.scale.max(0.01);
    let (w, h) = ((spec.width * s).round().max(1.0) as usize, (spec.height * s).round().max(1.0) as usize);
    let mut data = vec![0u8; w * h * 4];
    let ctx = CGContext::create_bitmap_context(
        Some(data.as_mut_ptr() as *mut _),
        w,
        h,
        8,
        w * 4,
        &CGColorSpace::create_device_rgb(),
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big,
    );
    ctx.set_should_antialias(true);
    ctx.set_line_cap(CGLineCap::CGLineCapRound);
    ctx.set_line_join(CGLineJoin::CGLineJoinRound);
    ctx.set_line_width(spec.stroke_width * s);
    let [r, g, b, a] = spec.color;
    ctx.set_rgb_stroke_color(r, g, b, a);
    for line in &spec.lines {
        let Some(first) = line.first() else { continue };
        ctx.begin_path();
        // Core Graphics is y up.
        ctx.move_to_point(first[0] * s, h as f64 - first[1] * s);
        for p in &line[1..] {
            ctx.add_line_to_point(p[0] * s, h as f64 - p[1] * s);
        }
        ctx.stroke_path();
    }
    drop(ctx);
    Ok(Pixels { width: w as u32, height: h as u32, data })
}
