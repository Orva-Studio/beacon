//! The live preview handle: a render thread that owns an beacon-render
//! `Preview` and draws the latest submitted scene, so scrubbing never
//! queues frames and the Bun main thread never waits on the GPU or decoders.

use core_foundation::base::{CFRelease, CFRetain};
use std::ffi::{c_char, c_void};
use std::ptr;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use beacon_render::scene::{Job, Scene};
use beacon_render::{Mark, Placement, Preview};
use serde_json::json;

use crate::{c_string, copy_out, guard, str_arg};

enum Msg {
    Scene(u32, String),
    Preroll(String),
    Proxies(bool),
    Resize(u32, u32),
    Place(Option<Placement>),
    Surround([f32; 4]),
    Marks(Vec<Mark>),
    /// Replies once everything sent before it is drawn.
    Flush(Sender<Result<Vec<u8>, String>>),
    Stats(Sender<String>),
    Stop,
}

pub struct FfiPreview {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
    result: Vec<u8>,
    /// The `CAMetalLayer` drawn into, retained until the render thread has
    /// stopped: the view that owns it (Electrobun's) can go away first.
    layer: Option<usize>,
}

struct Layer(*mut c_void);
// The layer is only touched on the render thread once handed over.
unsafe impl Send for Layer {}

#[derive(Default)]
struct Stats {
    shown: u64,
    seq: u32,
    skipped: u64,
    last_ms: f64,
    error: Option<String>,
    /// The last error, kept after the frame it happened on (a source drawn transparent shows no error a frame later).
    last_error: Option<String>,
}

fn run(mut preview: Preview, rx: Receiver<Msg>) {
    let mut stats = Stats::default();
    let mut scene: Option<(u32, Scene)> = None;
    let mut place: Option<Placement> = None;
    // A frame the surface couldn't take (window occluded or resizing), drawn once it can.
    let mut waiting = false;
    // A canvas has been rendered, so a change of placement, marks or view size can just be re-fitted.
    let mut drawn = false;
    loop {
        let first = if waiting {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        } else {
            let Ok(m) = rx.recv() else { return };
            Some(m)
        };
        let mut msgs: Vec<Msg> = first.into_iter().collect();
        msgs.extend(rx.try_iter());
        let mut dirty = waiting;
        // Only a new scene needs rendering; the rest re-fits the last canvas.
        let mut redraw = false;
        let mut replies = Vec::new();
        let mut asks = Vec::new();
        for m in msgs {
            match m {
                Msg::Scene(seq, text) => match serde_json::from_str::<Scene>(&text) {
                    Ok(s) => {
                        // A scene defines the sources it is the first to use: keep them even if a newer scene replaces it before it's drawn.
                        preview.renderer().add_sources(&s);
                        if scene.is_some() && redraw {
                            stats.skipped += 1;
                        }
                        scene = Some((seq, s));
                        dirty = true;
                        redraw = true;
                    }
                    Err(e) => stats.error = Some(format!("scene: {e}")),
                },
                Msg::Preroll(text) => match serde_json::from_str::<Scene>(&text) {
                    Ok(s) => {
                        if let Err(e) = caught(|| preview.renderer().preroll(&s).map_err(|e| e.to_string())) {
                            stats.error = Some(e);
                        }
                    }
                    Err(e) => stats.error = Some(format!("scene: {e}")),
                },
                Msg::Proxies(on) => preview.renderer().use_proxies = on,
                Msg::Resize(w, h) => {
                    if let Err(e) = caught(|| {
                        preview.resize(w, h);
                        Ok(())
                    }) {
                        stats.error = Some(e);
                    }
                    dirty = true;
                }
                Msg::Place(p) => {
                    place = p;
                    dirty = true;
                }
                Msg::Surround(c) => {
                    preview.surround = c;
                    dirty = true;
                }
                Msg::Marks(m) => {
                    preview.marks = m;
                    dirty = true;
                }
                Msg::Flush(reply) => replies.push(reply),
                Msg::Stats(reply) => asks.push(reply),
                Msg::Stop => return,
            }
        }
        if dirty && let Some((seq, s)) = &scene {
            let at = place.unwrap_or(Placement { zoom: preview.fit_zoom(), pan: [0.0, 0.0] });
            let t = Instant::now();
            waiting = false;
            let full = redraw || !drawn;
            let before = preview.renderer().profile;
            match caught(|| if full { preview.show(s, at) } else { preview.recomposite(at) }.map_err(|e| e.to_string())) {
                Ok(true) => {
                    drawn = true;
                    stats.shown += 1;
                    stats.seq = *seq;
                    if full {
                        stats.error = preview.renderer().source_error.take();
                    }
                }
                Ok(false) => {
                    drawn |= full;
                    waiting = true;
                }
                Err(e) => stats.error = Some(e),
            }
            stats.last_ms = t.elapsed().as_secs_f64() * 1000.0;
            if full && std::env::var_os("BEACON_PROFILE").is_some() {
                let p = &preview.renderer().profile;
                let ms = |a: f64, b: f64| (a - b) * 1000.0;
                eprintln!(
                    "preview frame {}: {:.1} ms (open {:.1}, decode {:.1}, upload {:.1}, draw {:.1}){}",
                    stats.seq,
                    stats.last_ms,
                    ms(p.open, before.open),
                    ms(p.decode, before.decode),
                    ms(p.upload, before.upload),
                    ms(p.draw_and_readback, before.draw_and_readback),
                    if preview.renderer().use_proxies { " proxies" } else { "" }
                );
            }
        }
        if stats.error.is_some() {
            stats.last_error.clone_from(&stats.error);
        }
        for reply in replies {
            let _ = reply.send(match &stats.error {
                Some(e) => Err(e.clone()),
                None => preview.pixels().map_err(|e| e.to_string()),
            });
        }
        for ask in asks {
            let (w, h) = preview.size();
            let _ = ask.send(
                json!({
                    "shown": stats.shown,
                    "seq": stats.seq,
                    "skipped": stats.skipped,
                    "lastMs": stats.last_ms,
                    "error": stats.error,
                    "lastError": stats.last_error,
                    "waiting": waiting,
                    "width": w,
                    "height": h,
                    "fitZoom": preview.fit_zoom(),
                })
                .to_string(),
            );
        }
    }
}

/// Runs one unit of the render thread's work, turning a panic into an error:
/// the thread must outlive a bad frame, or the canvas freezes with no word why.
fn caught<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    crate::caught("render thread panicked", f)
}

fn spawn(make: impl FnOnce() -> Result<Preview, String> + Send + 'static) -> Result<*mut FfiPreview, String> {
    let (tx, rx) = channel();
    let (ready_tx, ready_rx) = channel();
    let thread = std::thread::Builder::new()
        .name("ot-preview".into())
        .spawn(move || match make() {
            Ok(p) => {
                let _ = ready_tx.send(Ok(()));
                run(p, rx);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx.recv().map_err(|_| "preview thread stopped".to_string())??;
    Ok(Box::into_raw(Box::new(FfiPreview { tx, thread: Some(thread), result: Vec::new(), layer: None })))
}

fn job_arg(job_json: *const c_char) -> Result<Job, String> {
    serde_json::from_str(str_arg(job_json)?).map_err(|e| format!("job: {e}"))
}

fn handle<'a>(h: *mut FfiPreview) -> Result<&'a mut FfiPreview, String> {
    unsafe { h.as_mut() }.ok_or_else(|| "handle is null".into())
}

fn send(h: *mut FfiPreview, m: Msg) -> Result<i32, String> {
    handle(h)?.tx.send(m).map_err(|_| "preview thread stopped".to_string())?;
    Ok(0)
}

/// A preview drawing into `layer` (a `CAMetalLayer`), `width`×`height`
/// physical pixels. `job_json` is an beacon-render `Job` (its `output` is ignored).
///
/// # Safety
/// `layer` must be a live `CAMetalLayer` (it is retained until `beacon_preview_free`); `job_json` NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_new(layer: *mut c_void, width: u32, height: u32, job_json: *const c_char) -> *mut FfiPreview {
    guard(ptr::null_mut(), || {
        if layer.is_null() {
            return Err("layer is null".into());
        }
        let job = job_arg(job_json)?;
        unsafe { CFRetain(layer) };
        let raw = layer as usize;
        let layer = Layer(layer);
        match spawn(move || {
            let layer = layer;
            unsafe { Preview::on_layer(&job, layer.0, width, height) }.map_err(|e| e.to_string())
        }) {
            Ok(p) => {
                unsafe { (*p).layer = Some(raw) };
                Ok(p)
            }
            Err(e) => {
                unsafe { CFRelease(raw as *const c_void) };
                Err(e)
            }
        }
    })
}

/// A preview drawing into an offscreen texture, read with `beacon_preview_flush`.
///
/// # Safety
/// `job_json` must be NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_offscreen(width: u32, height: u32, job_json: *const c_char) -> *mut FfiPreview {
    guard(ptr::null_mut(), || {
        let job = job_arg(job_json)?;
        spawn(move || Preview::offscreen(&job, width, height).map_err(|e| e.to_string()))
    })
}

/// Queues a scene; only the latest one queued is drawn. `seq` comes back in the stats once it is on screen.
///
/// # Safety
/// `h` must be a live handle; `scene_json` NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_submit(h: *mut FfiPreview, seq: u32, scene_json: *const c_char) -> i32 {
    guard(-1, || send(h, Msg::Scene(seq, str_arg(scene_json)?.to_owned())))
}

/// Starts decoders for an upcoming scene (e.g. the next cut) without drawing it.
///
/// # Safety
/// `h` must be a live handle; `scene_json` NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_preroll(h: *mut FfiPreview, scene_json: *const c_char) -> i32 {
    guard(-1, || send(h, Msg::Preroll(str_arg(scene_json)?.to_owned())))
}

/// Whether video may be read from proxies (fast to seek): on while
/// scrubbing and playing, off to redraw a settled frame from the originals.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_proxies(h: *mut FfiPreview, on: i32) -> i32 {
    guard(-1, || send(h, Msg::Proxies(on != 0)))
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_resize(h: *mut FfiPreview, width: u32, height: u32) -> i32 {
    guard(-1, || send(h, Msg::Resize(width, height)))
}

/// Canvas pixels per view pixel and the canvas centre's offset from the view
/// centre in view pixels; `zoom` ≤ 0 fits the whole canvas.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_place(h: *mut FfiPreview, zoom: f32, pan_x: f32, pan_y: f32) -> i32 {
    guard(-1, || send(h, Msg::Place((zoom > 0.0).then_some(Placement { zoom, pan: [pan_x, pan_y] }))))
}

/// The colour around the canvas, straight-alpha RGBA 0–1.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_surround(h: *mut FfiPreview, r: f32, g: f32, b: f32) -> i32 {
    guard(-1, || send(h, Msg::Surround([r, g, b, 1.0])))
}

/// Replaces the marks drawn over the canvas (selection, handles, guides):
/// a JSON array of `beacon_render::Mark` (positions in canvas pixels, sizes in view pixels).
///
/// # Safety
/// `h` must be a live handle; `marks_json` NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_marks(h: *mut FfiPreview, marks_json: *const c_char) -> i32 {
    guard(-1, || {
        let marks: Vec<Mark> = serde_json::from_str(str_arg(marks_json)?).map_err(|e| format!("marks: {e}"))?;
        send(h, Msg::Marks(marks))
    })
}

/// Waits until everything queued is drawn. For an offscreen preview, returns
/// the byte length of its RGBA pixels (copy with `beacon_preview_result_copy`);
/// otherwise 0.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_flush(h: *mut FfiPreview) -> i64 {
    guard(-1, || {
        let p = handle(h)?;
        let (tx, rx) = channel();
        p.tx.send(Msg::Flush(tx)).map_err(|_| "preview thread stopped".to_string())?;
        match rx.recv().map_err(|_| "preview thread stopped".to_string())? {
            Ok(px) => {
                p.result = px;
                Ok(p.result.len() as i64)
            }
            Err(e) if e.contains("only offscreen") => Ok(0),
            Err(e) => Err(e),
        }
    })
}

/// # Safety
/// `h` must be a live handle; `out` must have room for `cap` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_result_copy(h: *mut FfiPreview, out: *mut u8, cap: usize) -> i32 {
    guard(-1, || {
        let p = handle(h)?;
        unsafe { copy_out(&p.result, out, cap) }
    })
}

/// JSON: frames shown, the last shown `seq`, scenes skipped for newer ones,
/// the last draw's milliseconds, the last error, view size and fit zoom.
/// Free with `beacon_string_free`.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_stats_json(h: *mut FfiPreview) -> *mut c_char {
    guard(ptr::null_mut(), || {
        let p = handle(h)?;
        let (tx, rx) = channel();
        p.tx.send(Msg::Stats(tx)).map_err(|_| "preview thread stopped".to_string())?;
        let s = rx.recv().map_err(|_| "preview thread stopped".to_string())?;
        c_string(s)
    })
}

/// # Safety
/// `h` must come from `beacon_preview_new`/`beacon_preview_offscreen`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_preview_free(h: *mut FfiPreview) {
    if h.is_null() {
        return;
    }
    let mut p = unsafe { Box::from_raw(h) };
    let _ = p.tx.send(Msg::Stop);
    if let Some(t) = p.thread.take() {
        let _ = t.join();
    }
    if let Some(layer) = p.layer.take() {
        unsafe { CFRelease(layer as *const c_void) };
    }
}
