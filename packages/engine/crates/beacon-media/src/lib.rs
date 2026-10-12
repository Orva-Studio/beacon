//! Reader for Camtasia `.trec` recordings: the QuickTime stream layout plus
//! every `TSCM` metadata chunk (`docs/formats/trec.md`). Strict by
//! design: an unexpected layout is an error, never a guess.

mod bytes;
mod mp4;
mod tscm;

use std::fs::File;
use std::path::Path;

use serde::Serialize;

pub use mp4::{Recorder, Stream, StreamKind};
pub use tscm::*;

pub type Result<T> = std::result::Result<T, TrecError>;

#[derive(Debug, thiserror::Error)]
pub enum TrecError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unexpected .trec layout: {0}")]
    Format(String),
}

impl TrecError {
    pub(crate) fn format(msg: impl Into<String>) -> Self {
        Self::Format(msg.into())
    }
}

const EXPECTED_BOXES: [&str; 6] = ["ftyp", "wide", "mdat", "moov", "TSCR", "TSCM"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trec {
    pub file_size: u64,
    pub recorder: Recorder,
    pub duration: f64,
    pub streams: Vec<Stream>,
    pub cursor_samples: usize,
    pub button_events: usize,
    #[serde(flatten)]
    pub tscm: Tscm,
}

impl Trec {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut file = File::open(path)?;
        let file_size = file.metadata()?.len();
        let boxes = mp4::top_level_boxes(&mut file, file_size)?;
        let kinds: Vec<&str> = boxes.iter().map(|b| b.kind.as_str()).collect();
        if kinds != EXPECTED_BOXES {
            return Err(TrecError::format(format!("top-level boxes {kinds:?}, expected {EXPECTED_BOXES:?}")));
        }
        let body = |kind: &str, file: &mut File| mp4::read_body(file, boxes.iter().find(|b| b.kind == kind).unwrap());

        let movie = mp4::parse_moov(&body("moov", &mut file)?)?;
        let recorder = mp4::parse_tscr(&body("TSCR", &mut file)?)?;
        let tscm = tscm::parse_tscm(&body("TSCM", &mut file)?)?;
        Ok(Self {
            file_size,
            recorder,
            duration: movie.duration,
            streams: movie.streams,
            cursor_samples: tscm.cursor.t.len(),
            button_events: tscm.buttons.t.len(),
            tscm,
        })
    }
}
