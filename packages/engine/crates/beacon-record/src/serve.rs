//! `beacon-recorder serve`: one JSON command per stdin line, one JSON event per
//! stdout line. Commands: `devices`; `access` with `kind` (`camera` or
//! `microphone`); `start` with `dir` (the take's new `.brec`
//! folder) and `sources`; `status`; `stop`. Each event echoes the command's
//! `id`. `preview` with `camera` and `microphone` shows them in the Record
//! dialog until `previewStop` or a take starts: `previewFrame` events (base64
//! JPEG) and `previewLevel` events (dBFS) arrive without an `id`. When stdin
//! closes (the app quit or crashed), a take still recording is stopped and its
//! files finished.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture::{Device, Sources, Take};
use crate::preview::Preview;

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
    },
    Status {
        id: Option<Value>,
    },
    /// Replaces any preview; neither device stops it.
    Preview {
        id: Option<Value>,
        camera: Option<Device>,
        microphone: Option<Device>,
    },
    PreviewStop {
        id: Option<Value>,
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
        let line = match rx.recv_timeout(Duration::from_micros(8333)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(t) = &mut take {
                    t.poll_cursor();
                }
                if let Some(p) = &preview
                    && level_at.elapsed() >= Duration::from_millis(50)
                {
                    level_at = std::time::Instant::now();
                    if let Some(level) = p.level() {
                        emit(None, level);
                    }
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
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
            Command::Start { id, dir, sources } => match &take {
                Some(t) => error(id.as_ref(), format!("already recording to {}", t.dir().display())),
                None => match Take::start(&dir, &sources) {
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
            Command::Preview { id, camera, microphone } => {
                preview = None;
                if camera.is_none() && microphone.is_none() {
                    emit(id.as_ref(), json!({ "event": "previewing" }));
                    continue;
                }
                match Preview::start(camera.as_ref(), microphone.as_ref(), |e| emit(None, e)) {
                    Ok(p) => {
                        preview = Some(p);
                        emit(id.as_ref(), json!({ "event": "previewing" }));
                    }
                    Err(e) => error(id.as_ref(), e),
                }
            }
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
