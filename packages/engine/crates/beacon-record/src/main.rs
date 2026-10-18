//! The recording sidecar (PLAN §13 Phase 6). `devices` lists what can be
//! recorded; `access camera|microphone` asks for that permission; `serve`
//! takes commands on stdin (`serve.rs`); `record <dir> [seconds] [--tones]`
//! records every source to a `.brec` folder from the command line, with
//! `--tones` playing a sound every few seconds to check the streams' sync
//! against each other.
mod capture;
mod cursor;
mod devices;
mod monitor;
mod outputs;
mod preview;
mod serve;

use std::path::Path;
use std::time::{Duration, Instant};

fn record(args: &[String]) -> Result<(), String> {
    let usage = "usage: beacon-recorder record <dir.brec> [seconds] [--tones]";
    let tones = args.iter().any(|a| a == "--tones");
    let mut rest = args.iter().filter(|a| *a != "--tones");
    let dir = Path::new(rest.next().ok_or(usage)?);
    let seconds: f64 = rest.next().map_or(Ok(10.0), |s| s.parse()).map_err(|_| usage)?;
    let list = devices::list();
    let granted = |k: &str| list["permissions"][k] == "granted";
    let sources = capture::Sources {
        screen: Some(capture::Screen { display: None, fps: 60, exclude: None }),
        system_audio: true,
        camera: (granted("camera") && list["cameras"].as_array().is_some_and(|c| !c.is_empty())).then_some(capture::Device { id: None }),
        microphone: (granted("microphone") && list["microphones"].as_array().is_some_and(|m| !m.is_empty())).then_some(capture::Device { id: None }),
        offsets: Default::default(),
    };
    let mut take = capture::Take::start(dir, &sources, false)?;
    println!("{}", serde_json::json!({ "event": "recording", "dir": dir, "camera": sources.camera.is_some(), "microphone": sources.microphone.is_some() }));
    let step = if seconds <= 30.0 { 3.0 } else { 20.0 };
    let mut next = (1..).map(|i| i as f64 * step).take_while(|&at| at < seconds - 1.0).peekable();
    let begun = Instant::now();
    while begun.elapsed().as_secs_f64() < seconds {
        if tones && next.peek().is_some_and(|&at| begun.elapsed().as_secs_f64() >= at) {
            next.next();
            take.mark();
            let _ = std::process::Command::new("/usr/bin/afplay").arg("/System/Library/Sounds/Ping.aiff").spawn();
        }
        take.poll_cursor();
        take.checkpoint();
        std::thread::sleep(Duration::from_millis(8));
    }
    println!("{}", serde_json::json!({ "event": "stopped", "take": take.stop()? }));
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("devices") => {
            println!("{}", devices::list());
            Ok(())
        }
        Some("access") => args.get(2).ok_or_else(|| "usage: beacon-recorder access camera|microphone".to_string()).and_then(|k| devices::request(k)).map(|e| println!("{e}")),
        Some("serve") => serve::run(),
        Some("record") => record(&args[2..]),
        _ => Err("usage: beacon-recorder devices | access camera|microphone | serve | record <dir.brec> [seconds] [--tones]".into()),
    };
    if let Err(e) = result {
        println!("{}", serde_json::json!({ "event": "error", "message": e }));
        std::process::exit(1);
    }
}
