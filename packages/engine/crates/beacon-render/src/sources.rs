use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};

use serde::{Deserialize, Serialize};

use crate::{Error, Result, scene::Source};

/// Source paths come from project files: ffmpeg may read local files only,
/// never URLs, `concat:` lists or what a playlist points at.
const FILES_ONLY: [&str; 2] = ["-protocol_whitelist", "file"];

/// Decoded RGBA pixels, premultiplied.
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Decoded images kept after their textures are dropped, so showing one again is an upload, not a decode
/// (a screenshot takes 15-80 ms to decode). Least recently used first.
#[derive(Default)]
pub struct StillCache {
    items: std::collections::VecDeque<(String, std::sync::Arc<Pixels>)>,
    bytes: usize,
}

const STILL_CACHE_BYTES: usize = 256 << 20;

impl StillCache {
    pub fn get(&mut self, path: &str) -> Option<std::sync::Arc<Pixels>> {
        let i = self.items.iter().position(|(p, _)| p == path)?;
        let item = self.items.remove(i).unwrap();
        let px = item.1.clone();
        self.items.push_back(item);
        Some(px)
    }

    pub fn put(&mut self, path: &str, px: std::sync::Arc<Pixels>) {
        self.bytes += px.data.len();
        self.items.push_back((path.to_string(), px));
        while self.bytes > STILL_CACHE_BYTES && self.items.len() > 1 {
            self.bytes -= self.items.pop_front().unwrap().1.data.len();
        }
    }
}

/// Presentation times of every frame of one video stream, as ffmpeg sees
/// them, so decoding with `-fps_mode passthrough` yields exactly this list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameIndex {
    pub width: u32,
    pub height: u32,
    pub pts: Vec<f64>,
    pub codec: Option<String>,
}

#[derive(Deserialize)]
struct Probe {
    streams: Vec<ProbeStream>,
    #[serde(default)]
    packets: Vec<ProbePacket>,
}

#[derive(Deserialize)]
struct ProbeStream {
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default)]
    codec_name: Option<String>,
}

#[derive(Deserialize)]
struct ProbePacket {
    pts_time: Option<String>,
}

#[derive(Deserialize)]
struct ProbeFrames {
    #[serde(default)]
    frames: Vec<ProbePacket>,
}

fn run(cmd: &mut Command, what: &str) -> Result<Vec<u8>> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| Error::Source(format!("{what}: {e}")))?;
    if !out.status.success() {
        return Err(Error::Source(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(out.stdout)
}

fn cache_key(path: &str, stream: u32) -> Result<String> {
    let meta = fs::metadata(path).map_err(|e| Error::Source(format!("{path}: {e}")))?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (path, stream, meta.len(), meta.modified().ok()).hash(&mut h);
    Ok(format!("frames-v3-{:016x}.json", h.finish()))
}

pub fn frame_index(path: &str, stream: u32, cache_dir: Option<&Path>) -> Result<FrameIndex> {
    let cached = cache_dir.map(|d| cache_key(path, stream).map(|k| d.join(k))).transpose()?;
    if let Some(index) = cached.as_ref().and_then(|p| fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()) {
        return Ok(index);
    }
    let select = format!("v:{stream}");
    let ffprobe = |entries: &str| {
        run(
            Command::new(beacon_decode::tool("ffprobe")).args(["-v", "error", "-select_streams", &select, "-show_entries", entries, "-of", "json"]).args(FILES_ONLY).arg(path),
            &format!("ffprobe {path}"),
        )
    };
    let probe: Probe = serde_json::from_slice(&ffprobe("stream=width,height,codec_name:packet=pts_time")?)
        .map_err(|e| Error::Source(format!("ffprobe {path}: {e}")))?;
    let s = probe.streams.first().ok_or_else(|| Error::Source(format!("{path}: no video stream {stream}")))?;
    // TechSmith's screen codec stores "unchanged" as 1-byte packets that
    // decode to no frame, so its frame times come from decoding (fast for
    // this codec). For other codecs every packet is a frame.
    let times = if s.codec_name.as_deref() == Some("tscc2") {
        let frames: ProbeFrames =
            serde_json::from_slice(&ffprobe("frame=pts_time")?).map_err(|e| Error::Source(format!("ffprobe {path}: {e}")))?;
        frames.frames
    } else {
        probe.packets
    };
    let mut pts: Vec<f64> = times.iter().filter_map(|p| p.pts_time.as_deref()?.parse().ok()).collect();
    pts.sort_by(f64::total_cmp);
    if pts.is_empty() {
        return Err(Error::Source(format!("{path}: video stream {stream} has no frames")));
    }
    let index = FrameIndex { width: s.width.unwrap_or(0), height: s.height.unwrap_or(0), pts, codec: s.codec_name.clone() };
    if let Some(p) = cached {
        let _ = fs::create_dir_all(p.parent().unwrap());
        let _ = fs::write(p, serde_json::to_vec(&index).unwrap());
    }
    Ok(index)
}

/// Reads frames of one video stream from an in-process decoder (beacon-decode), decoding ahead on a
/// thread, at a reduced size when the frame is drawn small. Seeks only when the wanted frame is behind or
/// far ahead of what the thread is decoding.
pub struct VideoDecoder {
    path: String,
    stream: u32,
    pub index: FrameIndex,
    /// Decoded size: the stream scaled by `factor`.
    pub width: u32,
    pub height: u32,
    pub factor: f64,
    /// Size over the original stream's (differs from `factor` when reading a proxy).
    pub scale: f64,
    pub proxy: bool,
    /// Decode with VideoToolbox when the codec has it: a quarter of the CPU
    /// for a 4K H.264 camera reading straight through, but slower to seek.
    pub hardware: bool,
    /// Decode H.264/HEVC natively through VideoToolbox (the preview): seeks ~4× faster at a hundredth
    /// of the CPU, with frames identical to FFmpeg's (beacon-decode's matches_ffmpeg test).
    pub native: bool,
    /// Hand natively decoded NV12 frames over in their IOSurfaces, for the renderer to convert on the GPU.
    pub surfaces: bool,
    pipe: Option<Pipe>,
    worker: Option<Worker>,
    /// Index of the next frame the pipe will deliver.
    next: usize,
    /// Index of the frame in `frame`.
    current: Option<usize>,
    frame: Frame,
    /// The first frame ffmpeg failed to deliver (a truncated or damaged file):
    /// later frames show the last good one instead of restarting ffmpeg for
    /// every frame.
    pub broken_at: Option<usize>,
}

/// A decoded frame: still in its IOSurface for the GPU to convert (VideoToolbox's NV12), or RGBA at the decode
/// size, converted on the CPU (tscc2, ProRes, 10-bit, or when the renderer can't take surfaces).
pub enum Frame {
    Rgba(Vec<u8>),
    Surface(beacon_decode::Surface, beacon_decode::Matrix),
}

/// Frames from the decoding thread, starting at the frame asked for.
struct Pipe {
    frames: Receiver<std::result::Result<Frame, String>>,
}

/// Where the decoding thread should start, and where its frames go.
struct Start {
    time: f64,
    width: u32,
    height: u32,
    frames: SyncSender<std::result::Result<Frame, String>>,
}

/// A thread owning one in-process decoder, opened once and kept open across
/// seeks (no process per jump). Dropping the receiver of a run stops it.
struct Worker {
    starts: Sender<Start>,
}

/// Decoded frames a decoding thread keeps behind its position, so a step
/// back is served without seeking (each seek decodes from a keyframe).
const KEEP_BYTES: usize = 256 << 20;
/// Seconds before a start that are kept (a drag back moves a few frames a step).
const KEEP_BEFORE: f64 = 0.5;

impl Worker {
    fn spawn(path: String, stream: u32, hardware: bool, native: bool, surfaces: bool) -> Self {
        let (starts, rx) = channel::<Start>();
        std::thread::Builder::new()
            .name("beacon-decode".into())
            .spawn(move || {
                let mut decoder: Option<beacon_decode::Decoder> = None;
                // Consecutive frames ending at the decoder's position.
                let mut kept: std::collections::VecDeque<(f64, beacon_decode::Kept)> = Default::default();
                let mut kept_bytes = 0usize;
                let mut pending: Option<Start> = None;
                loop {
                    let Some(start) = pending.take().or_else(|| rx.recv().ok()) else { return };
                    let d = match &mut decoder {
                        Some(d) => d,
                        // BEACON_DECODE_SOFTWARE: every source in software on all cores (docs/performance.md, "Fast without proxies").
                        None => match if std::env::var_os("BEACON_DECODE_SOFTWARE").is_some() {
                            beacon_decode::Decoder::open(&path, stream, false, 0)
                        } else if native {
                            beacon_decode::Decoder::open_native(&path, stream)
                        } else {
                            beacon_decode::Decoder::open(&path, stream, hardware, 4)
                        } {
                            Ok(d) => decoder.insert(d),
                            Err(e) => {
                                let _ = start.frames.send(Err(e.0));
                                continue;
                            }
                        },
                    };
                    let convert = |d: &mut beacon_decode::Decoder, k: Option<&beacon_decode::Kept>| {
                        if surfaces && let Some(surface) = match k {
                            Some(k) => d.surface_of(k),
                            None => d.surface(),
                        } {
                            return Ok(Frame::Surface(surface, d.matrix()));
                        }
                        let mut frame = vec![0u8; start.width as usize * start.height as usize * 4];
                        match k {
                            Some(k) => d.rgba_of(k, &mut frame, start.width, start.height),
                            None => d.rgba(&mut frame, start.width, start.height),
                        }
                        .map(|_| Frame::Rgba(frame))
                        .map_err(|e| e.0)
                    };
                    let held = kept.front().is_some_and(|(p, _)| *p <= start.time) && kept.back().is_some_and(|(p, _)| *p >= start.time);
                    if held {
                        let mut stopped = false;
                        for (_, k) in kept.iter().filter(|(p, _)| *p >= start.time) {
                            if start.frames.send(convert(d, Some(k))).is_err() {
                                stopped = true;
                                break;
                            }
                            if let Ok(next) = rx.try_recv() {
                                pending = Some(next);
                                stopped = true;
                                break;
                            }
                        }
                        if stopped {
                            continue;
                        }
                    } else {
                        kept.clear();
                        kept_bytes = 0;
                        if let Err(e) = d.seek(start.time) {
                            let _ = start.frames.send(Err(e.0));
                            continue;
                        }
                    }
                    loop {
                        // A newer start replaces this run at once.
                        if let Ok(next) = rx.try_recv() {
                            pending = Some(next);
                            break;
                        }
                        match d.next() {
                            Ok(beacon_decode::Next::Frame(pts)) => {
                                // Far before the target, keeping costs more than it saves: a codec that
                                // updates its last frame in place (tscc2) copies it whenever it's held.
                                if pts < start.time - KEEP_BEFORE {
                                    kept.clear();
                                    kept_bytes = 0;
                                    continue;
                                }
                                if let Some(k) = d.keep() {
                                    kept_bytes += k.bytes;
                                    kept.push_back((pts, k));
                                    while kept_bytes > KEEP_BYTES && kept.len() > 1 {
                                        kept_bytes -= kept.pop_front().unwrap().1.bytes;
                                    }
                                }
                                if pts < start.time {
                                    continue;
                                }
                                if start.frames.send(convert(d, None)).is_err() {
                                    break;
                                }
                            }
                            Ok(beacon_decode::Next::End) => break,
                            Err(e) => {
                                let _ = start.frames.send(Err(e.0));
                                break;
                            }
                        }
                    }
                }
            })
            .expect("decoding thread");
        Self { starts }
    }
}

/// Reading ahead is cheaper than restarting ffmpeg for short jumps.
const MAX_SKIP: usize = 45;
/// Frames decoded ahead of the renderer.
const READ_AHEAD: usize = 3;

/// The smallest power-of-two reduction that still has at least one source
/// pixel per output pixel at `scale` (output pixels per source pixel).
pub fn decode_factor(scale: f64) -> f64 {
    let mut f = 1.0;
    while f / 2.0 >= scale * 1.05 && f > 1.0 / 16.0 {
        f /= 2.0;
    }
    f
}

impl VideoDecoder {
    pub fn new(path: &str, stream: u32, cache_dir: Option<&Path>, factor: f64) -> Result<Self> {
        let index = frame_index(path, stream, cache_dir)?;
        let even = |v: u32| (((v as f64 * factor) / 2.0).round() as u32 * 2).max(2);
        let (width, height) = (even(index.width), even(index.height));
        Ok(Self {
            path: path.into(),
            stream,
            index,
            width,
            height,
            factor,
            scale: factor,
            proxy: false,
            hardware: true,
            native: false,
            surfaces: false,
            pipe: None,
            worker: None,
            next: 0,
            current: None,
            frame: Frame::Rgba(Vec::new()),
            broken_at: None,
        })
    }

    /// The frame showing at `time` seconds: the last one presented at or before it.
    pub fn frame_for(&self, time: f64) -> usize {
        self.index.pts.partition_point(|&p| p <= time + 1e-6).saturating_sub(1)
    }

    /// True when frame `i` is current or the running pipe will reach it without restarting.
    pub fn can_reach(&self, i: usize) -> bool {
        self.current == Some(i) || (self.pipe.is_some() && i >= self.next && i - self.next <= MAX_SKIP)
    }

    /// Starts decoding at frame `i` in the background, so a later `seek_to(i)` doesn't wait for ffmpeg to start.
    pub fn start_at(&mut self, i: usize) -> Result<()> {
        if !self.can_reach(i) {
            self.restart(i)?;
        }
        Ok(())
    }

    /// Decodes frame `i`; returns false if it was already current.
    pub fn seek_to(&mut self, i: usize) -> Result<bool> {
        let i = match self.broken_at {
            Some(0) => return Err(Error::Source(format!("{}: no frame can be decoded", self.path))),
            Some(b) => i.min(b - 1),
            None => i,
        };
        if self.current == Some(i) {
            return Ok(false);
        }
        if self.pipe.is_none() || i < self.next || i - self.next > MAX_SKIP {
            self.restart(i)?;
        }
        while self.next <= i {
            let frame = self.pipe.as_ref().unwrap().frames.recv();
            match frame {
                Ok(Ok(frame)) => self.frame = frame,
                Ok(Err(e)) => {
                    self.broken_at = Some(self.next);
                    self.pipe = None;
                    return Err(Error::Source(format!("{}: frame {} of {}: {e}", self.path, self.next, self.index.pts.len())));
                }
                Err(_) => {
                    self.broken_at = Some(self.next);
                    self.pipe = None;
                    return Err(Error::Source(format!("{}: decoder stopped at frame {} of {}", self.path, self.next, self.index.pts.len())));
                }
            }
            self.next += 1;
        }
        self.current = Some(i);
        Ok(true)
    }

    fn restart(&mut self, i: usize) -> Result<()> {
        self.pipe = None;
        let hardware = self.hardware && matches!(self.index.codec.as_deref(), Some("h264" | "hevc" | "prores"));
        let native = self.native && hardware;
        let worker = self.worker.get_or_insert_with(|| Worker::spawn(self.path.clone(), self.stream, hardware, native, native && self.surfaces));
        let (tx, rx) = sync_channel(READ_AHEAD);
        // Frames presented before frame `i` are dropped, so the run starts exactly at it.
        let start = Start { time: self.index.pts[i] - 0.0005, width: self.width, height: self.height, frames: tx };
        worker.starts.send(start).map_err(|_| Error::Source(format!("{}: the decoding thread stopped", self.path)))?;
        self.pipe = Some(Pipe { frames: rx });
        self.next = i;
        self.current = None;
        Ok(())
    }

    pub fn has_frame(&self) -> bool {
        self.current.is_some()
    }

    pub fn frame(&self) -> &Frame {
        &self.frame
    }
}

pub fn load_still(source: &Source, trecs: &mut HashMap<PathBuf, beacon_media::Trec>) -> Result<Pixels> {
    match source {
        Source::Image { path } => {
            // In process: the same pixels as the ffmpeg command line's, without two processes (~40-70 ms) per image.
            let err = |e: beacon_decode::Error| Error::Source(e.0);
            let mut d = beacon_decode::Decoder::open(path, 0, false, 0).map_err(err)?;
            loop {
                match d.next().map_err(err)? {
                    beacon_decode::Next::Frame(_) => break,
                    beacon_decode::Next::End => return Err(Error::Source(format!("{path}: no image"))),
                }
            }
            let (width, height) = d.size();
            let mut data = vec![0u8; width as usize * height as usize * 4];
            d.rgba(&mut data, width, height).map_err(err)?;
            premultiply(&mut data);
            Ok(Pixels { width, height, data })
        }
        Source::Cursor { path, index } => {
            let key = PathBuf::from(path);
            if !trecs.contains_key(&key) {
                let trec = beacon_media::Trec::open(path).map_err(|e| Error::Source(format!("{path}: {e}")))?;
                trecs.insert(key.clone(), trec);
            }
            let img = trecs[&key]
                .tscm
                .cursor_images
                .get(*index as usize)
                .ok_or_else(|| Error::Source(format!("{path}: no cursor image {index}")))?;
            let mut px = decode_png(&img.png, path)?;
            premultiply(&mut px.data);
            Ok(crate::cursor::sharp(&px, img.scale as f64, [img.hot_x as f64, img.hot_y as f64]).unwrap_or(px))
        }
        Source::Rgba { path, width, height } => {
            let mut data = fs::read(path).map_err(|e| Error::Source(format!("{path}: {e}")))?;
            check_len(path, &data, *width, *height)?;
            premultiply(&mut data);
            Ok(Pixels { width: *width, height: *height, data })
        }
        Source::Text(spec) => crate::text::render(spec),
        Source::Strokes(spec) => crate::text::render_strokes(spec),
        Source::Video { .. } => unreachable!("videos are decoded by VideoDecoder"),
    }
}

fn premultiply(rgba: &mut [u8]) {
    for p in rgba.as_chunks_mut::<4>().0 {
        let a = p[3] as u16;
        if a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u16 * a + 127) / 255) as u8;
            }
        }
    }
}

fn check_len(path: &str, data: &[u8], w: u32, h: u32) -> Result<()> {
    if data.len() != w as usize * h as usize * 4 {
        return Err(Error::Source(format!("{path}: expected {w}x{h} RGBA, got {} bytes", data.len())));
    }
    Ok(())
}

pub fn decode_png(bytes: &[u8], what: &str) -> Result<Pixels> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16 | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().map_err(|e| Error::Source(format!("{what}: {e}")))?;
    let mut buf = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buf).map_err(|e| Error::Source(format!("{what}: {e}")))?;
    buf.truncate(info.buffer_size());
    let data = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::GrayscaleAlpha => buf.chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        other => return Err(Error::Source(format!("{what}: unexpected PNG colour type {other:?}"))),
    };
    Ok(Pixels { width: info.width, height: info.height, data })
}

pub fn encode_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<()> {
    fs::write(path, png_bytes(width, height, rgba)?).map_err(|e| Error::Output(format!("{}: {e}", path.display())))
}

pub fn png_bytes(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(|e| Error::Output(e.to_string()))?;
    w.write_image_data(rgba).map_err(|e| Error::Output(e.to_string()))?;
    w.finish().map_err(|e| Error::Output(e.to_string()))?;
    Ok(out)
}
