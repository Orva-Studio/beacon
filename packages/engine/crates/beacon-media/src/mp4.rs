use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

use crate::bytes::{Reader, fourcc, utf8};
use crate::{Result, TrecError};

#[derive(Debug, Clone)]
pub(crate) struct BoxRef {
    pub kind: String,
    pub pos: u64,
    pub size: u64,
    pub header: u64,
}

impl BoxRef {
    pub fn body_len(&self) -> u64 {
        self.size - self.header
    }
}

pub(crate) fn top_level_boxes(file: &mut File, file_size: u64) -> Result<Vec<BoxRef>> {
    let mut boxes = Vec::new();
    let mut pos = 0u64;
    while pos < file_size {
        if file_size - pos < 8 {
            return Err(TrecError::format(format!("trailing {} bytes after last box", file_size - pos)));
        }
        let mut h = [0u8; 16];
        let n = (file_size - pos).min(16) as usize;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut h[..n])?;
        let mut size = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind = fourcc(&h[4..8]);
        let mut header = 8;
        if size == 1 {
            if n < 16 {
                return Err(TrecError::format(format!("truncated 64-bit size for '{kind}'")));
            }
            size = u64::from_be_bytes(h[8..16].try_into().unwrap());
            header = 16;
        } else if size == 0 {
            size = file_size - pos;
        }
        let end = pos.checked_add(size).filter(|&e| size >= header && e <= file_size);
        let Some(end) = end else {
            return Err(TrecError::format(format!("box '{kind}' at {pos} has bad size {size}")));
        };
        boxes.push(BoxRef { kind, pos, size, header });
        pos = end;
    }
    Ok(boxes)
}

pub(crate) fn read_body(file: &mut File, b: &BoxRef) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; b.body_len() as usize];
    file.seek(SeekFrom::Start(b.pos + b.header))?;
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Child boxes inside an in-memory container body.
fn children(body: &[u8]) -> Result<Vec<(String, &[u8])>> {
    let mut out = Vec::new();
    let mut r = Reader::new(body, "box children");
    while !r.is_empty() {
        let size = r.u32_be()? as u64;
        let kind = r.fourcc()?;
        let (size, header) = match size {
            1 => (r.u64_be()?, 16),
            0 => ((r.remaining() + 8) as u64, 8),
            s => (s, 8),
        };
        if size < header {
            return Err(TrecError::format(format!("child box '{kind}' has bad size {size}")));
        }
        out.push((kind, r.take((size - header) as usize)?));
    }
    Ok(out)
}

fn child<'a>(body: &'a [u8], kind: &str) -> Result<Option<&'a [u8]>> {
    Ok(children(body)?.into_iter().find(|(k, _)| k == kind).map(|(_, b)| b))
}

fn require<'a>(body: &'a [u8], kind: &'static str) -> Result<&'a [u8]> {
    child(body, kind)?.ok_or_else(|| TrecError::format(format!("missing '{kind}' box")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub index: usize,
    pub track_id: u32,
    pub kind: StreamKind,
    pub codec: String,
    pub timescale: u32,
    pub duration: f64,
    pub sample_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Video,
    Audio,
    Other,
}

pub(crate) struct Movie {
    pub duration: f64,
    pub streams: Vec<Stream>,
}

pub(crate) fn parse_moov(moov: &[u8]) -> Result<Movie> {
    let mvhd = require(moov, "mvhd")?;
    let (timescale, duration) = header_time(mvhd, "mvhd")?;
    let mut streams = Vec::new();
    for (kind, trak) in children(moov)? {
        if kind == "trak" {
            streams.push(parse_trak(trak, streams.len())?);
        }
    }
    Ok(Movie { duration: duration as f64 / timescale as f64, streams })
}

/// `(timescale, duration)` from an mvhd or mdhd body.
fn header_time(b: &[u8], what: &'static str) -> Result<(u32, u64)> {
    let mut r = Reader::new(b, what);
    let version = r.u32_be()? >> 24;
    let (timescale, duration) = match version {
        0 => {
            r.skip(8)?;
            (r.u32_be()?, r.u32_be()? as u64)
        }
        1 => {
            r.skip(16)?;
            (r.u32_be()?, r.u64_be()?)
        }
        v => return Err(TrecError::format(format!("{what}: unknown version {v}"))),
    };
    if timescale == 0 {
        return Err(TrecError::format(format!("{what}: timescale is 0")));
    }
    Ok((timescale, duration))
}

fn parse_trak(trak: &[u8], index: usize) -> Result<Stream> {
    let tkhd = require(trak, "tkhd")?;
    let mut r = Reader::new(tkhd, "tkhd");
    match r.u32_be()? >> 24 {
        0 => r.skip(8)?,
        1 => r.skip(16)?,
        v => return Err(TrecError::format(format!("tkhd: unknown version {v}"))),
    }
    let track_id = r.u32_be()?;

    let mdia = require(trak, "mdia")?;
    let (timescale, duration) = header_time(require(mdia, "mdhd")?, "mdhd")?;
    let mut hdlr = Reader::new(require(mdia, "hdlr")?, "hdlr");
    hdlr.skip(8)?;
    let handler = hdlr.fourcc()?;
    let kind = match handler.as_str() {
        "vide" => StreamKind::Video,
        "soun" => StreamKind::Audio,
        _ => StreamKind::Other,
    };

    let stbl = require(require(mdia, "minf")?, "stbl")?;
    let mut stsd = Reader::new(require(stbl, "stsd")?, "stsd");
    stsd.skip(4)?;
    let entries = stsd.u32_be()?;
    if entries != 1 {
        return Err(TrecError::format(format!("track {track_id}: {entries} sample descriptions")));
    }
    let entry_size = stsd.u32_be()? as usize;
    let codec = stsd.fourcc()?;
    if entry_size < 8 {
        return Err(TrecError::format(format!("track {track_id}: sample description size {entry_size}")));
    }
    let entry = stsd.take(entry_size - 8)?;

    let mut stream = Stream {
        index,
        track_id,
        kind,
        codec,
        timescale,
        duration: duration as f64 / timescale as f64,
        sample_count: sample_count(stbl)?,
        width: None,
        height: None,
        sample_rate: None,
        channels: None,
    };
    // Sample entries start with 6 reserved bytes and a 2-byte data reference index.
    let mut e = Reader::new(entry, "sample entry");
    e.skip(8)?;
    match kind {
        StreamKind::Video => {
            e.skip(16)?;
            stream.width = Some(e.u16_be()? as u32);
            stream.height = Some(e.u16_be()? as u32);
        }
        StreamKind::Audio => {
            let qt_version = e.u16_be()?;
            e.skip(6)?;
            if qt_version == 2 {
                e.skip(16)?;
                stream.sample_rate = Some(e.f64_be()?);
                stream.channels = Some(e.u32_be()?);
            } else {
                stream.channels = Some(e.u16_be()? as u32);
                e.skip(6)?;
                stream.sample_rate = Some((e.u32_be()? >> 16) as f64);
            }
        }
        StreamKind::Other => {}
    }
    Ok(stream)
}

fn sample_count(stbl: &[u8]) -> Result<u64> {
    if let Some(stsz) = child(stbl, "stsz")? {
        let mut r = Reader::new(stsz, "stsz");
        r.skip(8)?;
        return Ok(r.u32_be()? as u64);
    }
    let mut r = Reader::new(require(stbl, "stts")?, "stts");
    r.skip(4)?;
    let mut total = 0u64;
    for _ in 0..r.u32_be()? {
        total += r.u32_be()? as u64;
        r.skip(4)?;
    }
    Ok(total)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorder {
    /// "Camtasia"; recordings tagged 10.0.0 have "Mac" here and no platform.
    pub name: String,
    pub version: String,
    pub platform: String,
    pub os: String,
}

/// TSCR body: `u32 1, u32 0`, then NUL-padded `name[20], version[16],
/// platform[4], os[16]`.
pub(crate) fn parse_tscr(body: &[u8]) -> Result<Recorder> {
    let mut r = Reader::new(body, "TSCR");
    let (a, b) = (r.u32_le()?, r.u32_le()?);
    if (a, b) != (1, 0) || body.len() != 64 {
        return Err(TrecError::format(format!("TSCR: unexpected header {a}/{b}, length {}", body.len())));
    }
    Ok(Recorder {
        name: utf8(r.take(20)?, "TSCR name")?,
        version: utf8(r.take(16)?, "TSCR version")?,
        platform: utf8(r.take(4)?, "TSCR platform")?,
        os: utf8(r.take(16)?, "TSCR os")?,
    })
}
