//! `beacon-recorder serve`: one JSON command per stdin line, one JSON event per
//! stdout line. Commands: `devices`; `access` with `kind` (`camera` or
//! `microphone`); `start` with `dir` (the take's new `.brec`
//! folder) and `sources`; `status`; `stop`. Each event echoes the command's
//! `id`. `setOutput` switches the Mac's sound output (`devices` lists them).
//! `preview` with `screen`, `systemAudio`, `camera` and `microphone`
//! shows them in the Record dialog until `previewStop` or a take starts; a take
//! started with `monitor` shows its camera and levels in the recording panel.
//! Both send `previewFrame` events (`source` and base64 JPEG) and
//! `previewLevel` events (`microphone` and `systemAudio` in dBFS) without an
//! `id`. `devicesChanged` (no `id`) says a display, camera or microphone was
//! connected or removed, while no take records. When stdin closes (the app quit or crashed), a take still recording is
//! stopped and its files finished.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use objc2_core_foundation::{CFRunLoop, CFRunLoopRunResult, kCFRunLoopDefaultMode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture::{Sources, Take};
use crate::preview::{Preview, PreviewSources};

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Devices {
        id: Option<Value>,
    },
    /// Asks for the camera or microphone permission.
    Access {
        id: Option<Value>,
        kind: String,
    },
    Start {
        id: Option<Value>,
        dir: PathBuf,
        #[serde(default)]
        sources: Sources,
        /// Sends the take's camera frames and levels, for the recording panel.
        #[serde(default)]
        monitor: bool,
    },
    Status {
        id: Option<Value>,
    },
    /// Replaces any preview; with no sources, stops it.
    Preview {
        id: Option<Value>,
        #[serde(flatten)]
        sources: PreviewSources,
    },
    PreviewStop {
        id: Option<Value>,
    },
    /// Makes `output` (a UID from `devices`) the Mac's sound output; answers with the one it replaced.
    SetOutput {
        id: Option<Value>,
        output: String,
    },
    Stop {
        id: Option<Value>,
    },
}

fn emit(id: Option<&Value>, mut event: Value) {
    if let Some(id) = id {
        event["id"] = id.clone();
    }
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

fn error(id: Option<&Value>, message: impl Into<String>) {
    emit(id, json!({ "event": "error", "message": message.into() }));
}

pub fn run() -> Result<(), String> {
    let mut take: Option<Take> = None;
    let mut preview: Option<Preview> = None;
    let mut level_at = std::time::Instant::now();
    let mut present = (crate::devices::present(), std::time::Instant::now());
    // The main thread polls the cursor (AppKit's), so stdin is read on another.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    emit(None, json!({ "event": "ready" }));
    loop {
        // AVFoundation learns of cameras and microphones connected or removed on the main run loop; without running
        // it, a device unplugged and plugged back (a monitor's hub losing power) stays the dead one until a restart.
        let line = match rx.try_recv() {
            Ok(line) => line,
            Err(mpsc::TryRecvError::Empty) => {
                // With nothing on the run loop yet it returns at once, so wait out the tick instead.
                if CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.008333, false) == CFRunLoopRunResult::Finished {
                    std::thread::sleep(Duration::from_micros(8333));
                }
                if let Some(t) = &mut take {
                    t.poll_cursor();
                    t.checkpoint();
                }
                if take.is_none() && present.1.elapsed() >= Duration::from_secs(1) {
                    let now = crate::devices::present();
                    if now != present.0 {
                        emit(None, json!({ "event": "devicesChanged" }));
                    }
                    present = (now, std::time::Instant::now());
                }
                if level_at.elapsed() >= Duration::from_millis(50) {
                    level_at = std::time::Instant::now();
                    let level = match (&take, &preview) {
                        (Some(t), _) if t.monitored() => t.level(),
                        (None, Some(p)) => p.level(),
                        _ => None,
                    };
                    if let Some(level) = level {
                        emit(None, level);
                    }
                }
                continue;
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
        };
        if let Some(t) = &mut take {
            t.poll_cursor();
        }
        if line.trim().is_empty() {
            continue;
        }
        let command: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id").cloned());
                error(id.as_ref(), format!("bad command: {e}"));
                continue;
            }
        };
        if matches!(command, Command::Start { .. }) && take.is_none() {
            // The preview's camera and microphone are let go before the take opens them.
            preview = None;
        }
        match command {
            Command::Devices { id } => emit(id.as_ref(), crate::devices::list()),
            Command::Access { id, kind } => match crate::devices::request(&kind) {
                Ok(e) => emit(id.as_ref(), e),
                Err(e) => error(id.as_ref(), e),
            },
            Command::Start { id, dir, sources, monitor } => match &take {
                Some(t) => error(id.as_ref(), format!("already recording to {}", t.dir().display())),
                None => match Take::start(&dir, &sources, monitor) {
                    Ok(t) => {
                        emit(id.as_ref(), json!({ "event": "recording", "dir": t.dir() }));
                        take = Some(t);
                    }
                    Err(e) => error(id.as_ref(), e),
                },
            },
            Command::Status { id } => match &take {
                Some(t) => emit(id.as_ref(), json!({ "event": "status", "recording": true, "dir": t.dir(), "status": t.status() })),
                None => emit(id.as_ref(), json!({ "event": "status", "recording": false })),
            },
            Command::Preview { id, .. } if take.is_some() => error(id.as_ref(), "recording: no preview until the take stops"),
            Command::Preview { id, sources } => {
                preview = None;
                if sources.is_empty() {
                    emit(id.as_ref(), json!({ "event": "previewing" }));
                    continue;
                }
                match Preview::start(&sources, |e| emit(None, e)) {
                    Ok(p) => {
                        preview = Some(p);
                        emit(id.as_ref(), json!({ "event": "previewing" }));
                    }
                    Err(e) => error(id.as_ref(), e),
                }
            }
            Command::SetOutput { id, output } => match crate::outputs::set_default(&output) {
                Ok(before) => emit(id.as_ref(), json!({ "event": "output", "before": before })),
                Err(e) => error(id.as_ref(), e),
            },
            Command::PreviewStop { id } => {
                preview = None;
                emit(id.as_ref(), json!({ "event": "previewStopped" }));
            }
            Command::Stop { id } => match take.take() {
                Some(t) => match t.stop() {
                    Ok(summary) => emit(id.as_ref(), json!({ "event": "stopped", "take": summary })),
                    Err(e) => error(id.as_ref(), e),
                },
                None => error(id.as_ref(), "not recording"),
            },
        }
    }
    if let Some(t) = take {
        match t.stop() {
            Ok(summary) => emit(None, json!({ "event": "stopped", "take": summary })),
            Err(e) => error(None, e),
        }
    }
    Ok(())
}
