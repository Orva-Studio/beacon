//! The wire format between `evaluate()` (TypeScript) and the renderer.
//! Mirrored in `packages/model/src/scene.ts`; change both together.

use std::collections::HashMap;

use serde::Deserialize;

/// First line of a worker job.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    /// What the export worker writes; renderers that only draw (the preview, frame grabs) have none.
    #[serde(default)]
    pub output: Option<Output>,
    pub sources: HashMap<String, Source>,
    #[serde(default)]
    pub passes: HashMap<String, PassDef>,
    /// Where derived data (frame indexes) is cached between runs.
    pub cache_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Output {
    /// Encoded with ffmpeg; `args` are the encoder options (e.g. `-c:v hevc_videotoolbox -b:v 20M`).
    Video { path: String, args: Vec<String> },
    /// One PNG per scene, named by `Scene::name` or the frame number.
    Png { dir: String },
    /// Encoded by VideoToolbox from the GPU's frames, through AVAssetWriter (H.264, HEVC, ProRes).
    Encode(Encode),
}

/// The native encoder's settings (`Output::Encode`): `width`×`height` is the video's size, the canvas fitted.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Encode {
    pub path: String,
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    /// The video's frame rate (frames are evaluated at it).
    pub fps: Fps,
    /// Average bits per second (H.264, HEVC; ProRes has none). Always given: automatic is worked out in TypeScript.
    pub bitrate: u64,
    /// A keyframe at most this many frames apart (H.264, HEVC).
    pub keyframe: u32,
    /// H.264's profile.
    pub profile: Option<H264Profile>,
    /// The transfer function tagged: sRGB's shows in macOS players as the editor does.
    #[serde(default)]
    pub srgb: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Codec {
    H264,
    Hevc,
    Prores,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum H264Profile {
    Baseline,
    Main,
    High,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A video stream, decoded with ffmpeg. `stream` is the index among video streams.
    /// `proxy`: a seek-friendly copy, used only when the renderer allows it.
    Video {
        path: String,
        stream: u32,
        #[serde(default)]
        proxy: Option<Proxy>,
    },
    /// Any still image ffmpeg can read (PNG, JPEG, ...).
    Image { path: String },
    /// A cursor image stored in a `.trec` (`cursorImages[index]`).
    Cursor { path: String, index: u32 },
    /// Straight-alpha RGBA pixels written by the caller to a file.
    Rgba { path: String, width: u32, height: u32 },
    /// Text laid out with Core Text into a box.
    Text(crate::text::TextSpec),
    /// Stroked polylines (sketch callouts).
    Strokes(crate::text::StrokeSpec),
}

/// A copy of a video stream at `factor` of its size, with the same frame times.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Proxy {
    pub path: String,
    pub factor: f64,
}

/// A render pass loaded at runtime: WGSL fragment entry points that run in
/// order over a canvas-size texture. See `prelude.wgsl` for the bindings.
#[derive(Debug, Clone, Deserialize)]
pub struct PassDef {
    pub wgsl: String,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    #[serde(default)]
    pub name: Option<String>,
    /// Sources first used by this scene, added to the job's.
    #[serde(default)]
    pub sources: HashMap<String, Source>,
    /// Straight RGBA, 0–1.
    pub background: [f32; 4],
    pub layers: Vec<Layer>,
}

/// Row-major 2×3 affine: `X = a·x + c·y + e`, `Y = b·x + d·y + f`, mapping
/// layer pixels (top-left origin, after crop) to target pixels.
pub type Affine = [f32; 6];

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layer {
    Visual(Visual),
    Backdrop(Backdrop),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visual {
    pub content: Content,
    /// Content size in pixels before crop.
    pub size: [f32; 2],
    /// left, top, right, bottom in content pixels.
    #[serde(default)]
    pub crop: [f32; 4],
    pub transform: Affine,
    /// `[g, h]`: the perspective row of a homography with `transform`, `W = g·x + h·y + 1`
    /// dividing X and Y (3D rotation). Passes still see the affine part.
    #[serde(default)]
    pub perspective: [f32; 2],
    /// Extra transforms averaged with `transform` for motion blur.
    #[serde(default)]
    pub motion: Vec<Affine>,
    /// Each `motion` transform's perspective row; flat where missing.
    #[serde(default)]
    pub motion_perspective: Vec<[f32; 2]>,
    /// Corner radii in layer pixels: top-left, top-right, bottom-right, bottom-left.
    #[serde(default)]
    pub radius: [f32; 4],
    #[serde(default = "one")]
    pub opacity: f32,
    #[serde(default)]
    pub passes: Vec<PassUse>,
}

impl Visual {
    /// The perspective row of motion sample `i` (0 is `transform`).
    pub fn perspective_of(&self, i: usize) -> [f32; 2] {
        if i == 0 { self.perspective } else { self.motion_perspective.get(i - 1).copied().unwrap_or_default() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Content {
    /// `time` is seconds of media time; ignored for stills.
    Source { source: String, #[serde(default)] time: f64 },
    Solid { color: [f32; 4] },
    Group { background: [f32; 4], layers: Vec<Layer> },
}

/// Processes what is already composited under its masked rectangle (blur,
/// pixelate, spotlight).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backdrop {
    pub size: [f32; 2],
    pub transform: Affine,
    #[serde(default)]
    pub radius: [f32; 4],
    /// Apply outside the rectangle instead of inside.
    #[serde(default)]
    pub invert: bool,
    #[serde(default = "one")]
    pub opacity: f32,
    pub passes: Vec<PassUse>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PassUse {
    pub pass: String,
    /// Up to 32 floats, in the order the pass's WGSL reads them.
    #[serde(default)]
    pub params: Vec<f32>,
}

fn one() -> f32 {
    1.0
}
