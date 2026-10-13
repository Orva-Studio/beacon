//! `beacon-recorder serve`: one JSON command per stdin line, one JSON event per
//! stdout line. Commands: `devices`; `access` with `kind` (`camera` or
//! `microphone`); `start` with `dir` (the take's new `.brec`
//! folder) and `sources`; `status`; `stop`. Each event echoes the command's
//! `id`. When stdin closes (the app quit or crashed), a take still recording
//! is stopped and its files finished.
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::capture::{Sources, Take};

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
    emit(None, json!({ "event": "ready" }));
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
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
