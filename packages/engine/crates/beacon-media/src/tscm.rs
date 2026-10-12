use serde::Serialize;

use crate::bytes::{Reader, hex, utf8};
use crate::{Result, TrecError};

/// Every TSCM id seen so far ends with this; the first 4 bytes are the type.
const ID_SUFFIX: [u8; 12] = [0x7a, 0x1f, 0x11, 0xe2, 0x83, 0xd0, 0x00, 0x17, 0xf2, 0x00, 0xbe, 0x7f];

#[derive(Debug, Clone, Copy, Serialize)]
pub struct TimedRect {
    pub t: f64,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimedText {
    pub t: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub t: f64,
    /// 1 display, 2 camera, 3 microphone, 4 system audio (observed).
    pub kind: u32,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuSample {
    pub t: f64,
    pub value: f32,
    pub flags: u32,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct KeyEvent {
    pub t: f64,
    /// macOS virtual key code.
    pub key: u32,
    /// NSEvent modifier flags (0x100000 ⌘, 0x80000 ⌥, 0x40000 ⌃, 0x20000 ⇧).
    pub flags: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ScrollEvent {
    pub t: f64,
    pub dx: i32,
    pub dy: i32,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Stat {
    pub t: f64,
    pub value: f32,
}

#[derive(Debug, Clone, Default)]
pub struct CursorTrack {
    pub t: Vec<f64>,
    pub x: Vec<i32>,
    pub y: Vec<i32>,
}

#[derive(Debug, Clone, Default)]
pub struct ButtonTrack {
    pub t: Vec<f64>,
    /// Observed: 256 (initial state), 1/2 left down/up, 4/8 probably right down/up,
    /// and rarer 17, 18, 130, 226.
    pub kind: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorImage {
    pub index: u64,
    pub width: u32,
    pub height: u32,
    /// Hotspot in image pixels from the top-left (Camtasia stores Y from the bottom).
    pub hot_x: u32,
    pub hot_y: u32,
    /// Image pixels to screen points (0.5 for Retina captures).
    pub scale: f32,
    #[serde(skip)]
    pub png: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct CursorImageChange {
    pub t: f64,
    pub index: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawChunk {
    pub id: String,
    pub version: u32,
    pub record_size: u32,
    pub body: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tscm {
    pub displays: Vec<TimedRect>,
    pub window_rects: Vec<TimedRect>,
    pub focused_apps: Vec<TimedText>,
    pub window_titles: Vec<TimedText>,
    pub system_info: Vec<TimedText>,
    pub devices: Vec<Device>,
    pub device_ids: Vec<Device>,
    pub gpu: Vec<GpuSample>,
    pub keys: Vec<KeyEvent>,
    pub scroll: Vec<ScrollEvent>,
    pub stats: Vec<Stat>,
    pub cursor_images: Vec<CursorImage>,
    pub cursor_image_changes: Vec<CursorImageChange>,
    /// Chunks with a known layout but no known meaning (af3, afb, af8–afa).
    pub raw_chunks: Vec<RawChunk>,
    #[serde(skip)]
    pub cursor: CursorTrack,
    #[serde(skip)]
    pub buttons: ButtonTrack,
}

pub(crate) fn parse_tscm(payload: &[u8]) -> Result<Tscm> {
    let mut out = Tscm::default();
    let mut seen = Vec::new();
    let mut r = Reader::new(payload, "TSCM");
    while !r.is_empty() {
        let start = r.pos();
        if r.u32_be()? != 1 || r.fourcc()? != "DATA" {
            return Err(TrecError::format(format!("TSCM: expected DATA record at {start}")));
        }
        let size = r.u64_be()? as usize;
        if size < 32 {
            return Err(TrecError::format(format!("TSCM: record at {start} has bad size {size}")));
        }
        let id = r.take(16)?;
        let body = r.take(size - 32)?;
        if id[4..] != ID_SUFFIX {
            return Err(TrecError::format(format!("TSCM: unknown chunk id {}", hex(id))));
        }
        let id = hex(&id[..4]);
        if seen.contains(&id) {
            return Err(TrecError::format(format!("TSCM: chunk {id} appears twice")));
        }
        parse_chunk(&mut out, &id, body)?;
        seen.push(id);
    }
    Ok(out)
}

/// Body header: `u32 version, u32 recordSize` (0 = variable length).
fn header<'a>(id: &str, body: &'a [u8], version: u32, record_size: u32) -> Result<Reader<'a>> {
    let mut r = Reader::new(body, "TSCM chunk");
    let (v, rs) = (r.u32_le()?, r.u32_le()?);
    if v != version || rs != record_size {
        return Err(TrecError::format(format!(
            "chunk {id}: expected version {version} record size {record_size}, got {v}/{rs}"
        )));
    }
    if record_size > 0 && !r.remaining().is_multiple_of(record_size as usize) {
        return Err(TrecError::format(format!(
            "chunk {id}: {} bytes is not a multiple of {record_size}",
            r.remaining()
        )));
    }
    Ok(r)
}

/// Variable-length records: `u32 n, n bytes`.
fn records<'a>(r: &mut Reader<'a>) -> Result<Vec<&'a [u8]>> {
    let mut out = Vec::new();
    while !r.is_empty() {
        let n = r.u32_le()? as usize;
        out.push(r.take(n)?);
    }
    Ok(out)
}

fn timed_texts(id: &str, body: &[u8]) -> Result<Vec<TimedText>> {
    let mut r = header(id, body, 1, 0)?;
    records(&mut r)?
        .into_iter()
        .map(|rec| {
            let mut r = Reader::new(rec, "text record");
            let t = r.f64_le()?;
            Ok(TimedText { t, text: utf8(r.take(r.remaining())?, "text record")? })
        })
        .collect()
}

fn devices(id: &str, body: &[u8]) -> Result<Vec<Device>> {
    let mut r = header(id, body, 1, 0)?;
    records(&mut r)?
        .into_iter()
        .map(|rec| {
            let mut r = Reader::new(rec, "device record");
            let t = r.f64_le()?;
            let kind = r.u32_le()?;
            Ok(Device { t, kind, value: utf8(r.take(r.remaining())?, "device record")? })
        })
        .collect()
}

fn rects(id: &str, body: &[u8]) -> Result<Vec<TimedRect>> {
    let mut r = header(id, body, 1, 24)?;
    let mut out = Vec::new();
    while !r.is_empty() {
        out.push(TimedRect { t: r.f64_le()?, x: r.i32_le()?, y: r.i32_le()?, w: r.i32_le()?, h: r.i32_le()? });
    }
    Ok(out)
}

fn parse_chunk(out: &mut Tscm, id: &str, body: &[u8]) -> Result<()> {
    match id {
        "2b7b6af2" => {
            let mut r = header(id, body, 1, 16)?;
            while !r.is_empty() {
                let t = r.f64_le()?;
                if out.cursor.t.last().is_some_and(|&p| t < p) {
                    return Err(TrecError::format(format!("cursor timestamps go backwards at {t}")));
                }
                out.cursor.t.push(t);
                out.cursor.x.push(r.i32_le()?);
                out.cursor.y.push(r.i32_le()?);
            }
        }
        "2b7b6af0" => {
            let mut r = header(id, body, 1, 12)?;
            while !r.is_empty() {
                out.buttons.t.push(r.f64_le()?);
                out.buttons.kind.push(r.u32_le()?);
            }
        }
        "2b7b6af1" => parse_cursor_images(out, id, body)?,
        "2b7b6af5" => {
            let mut r = header(id, body, 1, 16)?;
            while !r.is_empty() {
                out.keys.push(KeyEvent { t: r.f64_le()?, key: r.u32_le()?, flags: r.u32_le()? });
            }
        }
        "2b7b6a05" => {
            let mut r = header(id, body, 1, 16)?;
            while !r.is_empty() {
                out.scroll.push(ScrollEvent { t: r.f64_le()?, dx: r.i32_le()?, dy: r.i32_le()? });
            }
        }
        "2b7b6a08" => {
            let mut r = header(id, body, 1, 12)?;
            while !r.is_empty() {
                out.stats.push(Stat { t: r.f64_le()?, value: r.f32_le()? });
            }
        }
        "2b7b6a06" => out.focused_apps = timed_texts(id, body)?,
        "2b7b6a07" => out.window_titles = timed_texts(id, body)?,
        "2b7b6afc" => out.system_info = timed_texts(id, body)?,
        "2b7b6a0f" => out.devices = devices(id, body)?,
        "2b7b6a10" => out.device_ids = devices(id, body)?,
        "2b7b6af6" => out.displays = rects(id, body)?,
        "2b7b6af7" => out.window_rects = rects(id, body)?,
        "2b7b6a0a" => {
            let mut r = header(id, body, 1, 0)?;
            for rec in records(&mut r)? {
                let mut r = Reader::new(rec, "gpu record");
                out.gpu.push(GpuSample {
                    t: r.f64_le()?,
                    value: r.f32_le()?,
                    flags: r.u32_le()?,
                    name: utf8(r.take(r.remaining())?, "gpu record")?,
                });
            }
        }
        "2b7b6af3" | "2b7b6afb" | "2b7b6af8" | "2b7b6af9" | "2b7b6afa" => {
            let record_size = match id {
                "2b7b6af3" => 16,
                "2b7b6afb" => 12,
                _ => 0,
            };
            let mut r = header(id, body, 1, record_size)?;
            if record_size == 0 && !r.is_empty() {
                return Err(TrecError::format(format!("chunk {id}: expected empty, got {} bytes", r.remaining())));
            }
            out.raw_chunks.push(RawChunk { id: id.into(), version: 1, record_size, body: hex(r.take(r.remaining())?) });
        }
        _ => return Err(TrecError::format(format!("TSCM: unknown chunk {id} ({} bytes)", body.len()))),
    }
    Ok(())
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
const CURSOR_TRAILER: usize = 24;

/// Records: `u32 n, f64 t, u64 imageIndex, u32 innerLen, inner`. A record
/// that introduces a new image has `u32 pngLen, u32 hotX, u32 hotY, PNG`
/// before the 24-byte trailer; one that switches back to an earlier image
/// has only the trailer. The trailer ends with `f32 scale`.
fn parse_cursor_images(out: &mut Tscm, id: &str, body: &[u8]) -> Result<()> {
    let mut r = header(id, body, 2, 0)?;
    for rec in records(&mut r)? {
        let mut r = Reader::new(rec, "cursor image record");
        let t = r.f64_le()?;
        let index = r.u64_le()?;
        let inner_len = r.u32_le()? as usize;
        if inner_len != r.remaining() || inner_len < CURSOR_TRAILER {
            return Err(TrecError::format(format!("cursor image at {t}: inner length {inner_len} does not fit")));
        }
        if inner_len > CURSOR_TRAILER {
            let png_len = r.u32_le()? as usize;
            let hot_x = r.u32_le()?;
            let hot_y_bottom = r.u32_le()?;
            let png = r.take(png_len)?;
            if r.remaining() != CURSOR_TRAILER || png.len() < 24 || png[..8] != PNG_SIGNATURE || &png[12..16] != b"IHDR" {
                return Err(TrecError::format(format!("cursor image at {t}: not a PNG record")));
            }
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            if hot_x > width || hot_y_bottom > height {
                return Err(TrecError::format(format!("cursor image at {t}: hotspot outside the image")));
            }
            r.skip(CURSOR_TRAILER - 4)?;
            let scale = r.f32_le()?;
            // Images are looked up by position, so a gap or reordering would mislabel them.
            if index != out.cursor_images.len() as u64 {
                return Err(TrecError::format(format!("cursor image {index} out of order")));
            }
            out.cursor_images.push(CursorImage {
                index,
                width,
                height,
                hot_x,
                hot_y: height - hot_y_bottom,
                scale,
                png: png.to_vec(),
            });
        } else if !out.cursor_images.iter().any(|c| c.index == index) {
            return Err(TrecError::format(format!("cursor image at {t} refers to unknown image {index}")));
        }
        out.cursor_image_changes.push(CursorImageChange { t, index });
    }
    Ok(())
}
