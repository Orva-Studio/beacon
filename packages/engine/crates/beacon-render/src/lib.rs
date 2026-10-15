//! The compositor shared by export and the live preview: draws a `Scene` of
//! generic layers, running effect passes by name from WGSL loaded at runtime.

pub use beacon_decode::{set_tools_dir, tool};
pub mod preview;
mod cursor;
mod render;
pub mod scene;
pub mod sources;
#[cfg(target_os = "macos")]
pub mod encode;
#[cfg(target_os = "macos")]
mod surface;
#[cfg(target_os = "macos")]
pub mod text;

pub use preview::{Mark, Placement, Preview};
pub use render::Renderer;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("gpu: {0}")]
    Gpu(String),
    #[error("source: {0}")]
    Source(String),
    #[error("scene: {0}")]
    Scene(String),
    #[error("output: {0}")]
    Output(String),
}
