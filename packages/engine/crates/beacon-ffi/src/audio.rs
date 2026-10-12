//! Playback audio: an ffmpeg mix (the export's filter graph, from
//! TypeScript) streamed into the default output device. The samples the
//! device has played are the playback clock, so video follows audio.

use std::collections::VecDeque;
use std::ffi::c_char;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::{guard, str_arg};

/// Decoded audio kept ahead of the device.
const AHEAD_SECONDS: usize = 2;

#[derive(Default)]
struct Play {
    playing: bool,
    /// Interleaved stereo.
    buf: VecDeque<f32>,
    /// The mix has ended: the clock keeps running on silence.
    eof: bool,
    start: f64,
    played: u64,
    latency: f64,
    error: Option<String>,
}

pub struct FfiAudio {
    _stream: cpal::Stream,
    state: Arc<Mutex<Play>>,
    generation: Arc<AtomicU64>,
    child: Option<Child>,
    rate: u32,
}

fn handle<'a>(h: *mut FfiAudio) -> Result<&'a mut FfiAudio, String> {
    unsafe { h.as_mut() }.ok_or_else(|| "handle is null".into())
}

/// Opens the default output device (f32). Nothing plays until `beacon_audio_play`.
#[unsafe(no_mangle)]
pub extern "C" fn beacon_audio_new() -> *mut FfiAudio {
    guard(ptr::null_mut(), || {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or("no audio output device")?;
        let config = device.default_output_config().map_err(|e| e.to_string())?;
        if config.sample_format() != cpal::SampleFormat::F32 {
            return Err(format!("unsupported output format {:?}", config.sample_format()));
        }
        let config: cpal::StreamConfig = config.into();
        let rate = config.sample_rate;
        let channels = config.channels as usize;
        let state = Arc::new(Mutex::new(Play::default()));
        let cb = state.clone();
        let stream = device
            .build_output_stream(
                config,
                move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    let Ok(mut p) = cb.lock() else { return out.fill(0.0) };
                    if !p.playing {
                        return out.fill(0.0);
                    }
                    let ts = info.timestamp();
                    p.latency = ts.playback.duration_since(ts.callback).as_secs_f64();
                    for frame in out.chunks_mut(channels) {
                        let (l, r) = if p.buf.len() >= 2 {
                            p.played += 1;
                            (p.buf.pop_front().unwrap(), p.buf.pop_front().unwrap())
                        } else {
                            // Waiting for the decoder holds the clock; after the end it runs on.
                            if p.eof {
                                p.played += 1;
                            }
                            (0.0, 0.0)
                        };
                        for (i, s) in frame.iter_mut().enumerate() {
                            *s = match i {
                                0 => l,
                                1 => r,
                                _ => 0.0,
                            };
                        }
                        if channels == 1 {
                            frame[0] = (l + r) * 0.5;
                        }
                    }
                },
                |e| eprintln!("audio output: {e}"),
                None,
            )
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Box::into_raw(Box::new(FfiAudio { _stream: stream, state, generation: Arc::new(AtomicU64::new(0)), child: None, rate })))
    })
}

impl FfiAudio {
    fn stop(&mut self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Ok(mut p) = self.state.lock() {
            p.playing = false;
            p.buf.clear();
        }
    }
}

/// The device's sample rate: the mix must be rendered at it.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_audio_rate(h: *mut FfiAudio) -> i32 {
    guard(-1, || Ok(handle(h)?.rate as i32))
}

/// Starts playing at timeline second `start`: `args_json` is an ffmpeg argv
/// (inputs and filters) whose output this appends as f32 stereo at the
/// device rate on stdout. An empty argv plays silence.
///
/// # Safety
/// `h` must be a live handle; `args_json` NUL-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_audio_play(h: *mut FfiAudio, args_json: *const c_char, start: f64) -> i32 {
    guard(-1, || {
        let a = handle(h)?;
        let args: Vec<String> = serde_json::from_str(str_arg(args_json)?).map_err(|e| format!("args: {e}"))?;
        a.stop();
        let generation = a.generation.load(Ordering::SeqCst);
        {
            let mut p = a.state.lock().map_err(|_| "audio state poisoned")?;
            *p = Play { playing: true, eof: args.is_empty(), start, latency: p.latency, ..Default::default() };
        }
        let Some((bin, rest)) = args.split_first() else { return Ok(0) };
        let mut child = Command::new(bin)
            .args(rest)
            .args(["-f", "f32le", "-ac", "2", "-ar", &a.rate.to_string(), "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Stopping playback kills the mix mid-write; its broken-pipe complaint is expected.
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        let mut out = child.stdout.take().unwrap();
        a.child = Some(child);
        let (state, current, cap) = (a.state.clone(), a.generation.clone(), a.rate as usize * 2 * AHEAD_SECONDS);
        std::thread::Builder::new()
            .name("ot-audio".into())
            .spawn(move || {
                let mut bytes = vec![0u8; 4096 * 8];
                let mut carry = Vec::new();
                loop {
                    if current.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if state.lock().map(|p| p.buf.len() >= cap).unwrap_or(true) {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    let n = match out.read(&mut bytes) {
                        Ok(n) if n > 0 => n,
                        end => {
                            // A stopped mix ends too (killed): it must not mark the next play's mix ended.
                            if let Ok(mut p) = state.lock()
                                && current.load(Ordering::SeqCst) == generation
                            {
                                p.eof = true;
                                p.error = end.err().map(|e| e.to_string());
                            }
                            return;
                        }
                    };
                    carry.extend_from_slice(&bytes[..n]);
                    let whole = carry.len() / 4 * 4;
                    let Ok(mut p) = state.lock() else { return };
                    if current.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    p.buf.extend(carry[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
                    carry.drain(..whole);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(0)
    })
}

/// Timeline seconds now audible, or -1 when stopped.
///
/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_audio_time(h: *mut FfiAudio) -> f64 {
    guard(-1.0, || {
        let a = handle(h)?;
        let p = a.state.lock().map_err(|_| "audio state poisoned")?;
        if !p.playing {
            return Ok(-1.0);
        }
        Ok(p.start + (p.played as f64 / a.rate as f64 - p.latency).max(0.0))
    })
}

/// # Safety
/// `h` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_audio_stop(h: *mut FfiAudio) -> i32 {
    guard(-1, || {
        handle(h)?.stop();
        Ok(0)
    })
}

/// # Safety
/// `h` must come from `beacon_audio_new`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beacon_audio_free(h: *mut FfiAudio) {
    if !h.is_null() {
        let mut a = unsafe { Box::from_raw(h) };
        a.stop();
    }
}
