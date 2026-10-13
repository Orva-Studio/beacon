//! The recording sidecar (PLAN §13 Phase 6). Spike: `devices` lists what can
//! be recorded; `spike <dir> [seconds]` records screen, system audio, camera
//! and microphone to one file each.
mod devices;
mod spike;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("devices") => devices::run(),
        Some("spike") => spike::run(&args[2..]),
        _ => Err("usage: beacon-recorder devices | spike <dir> [seconds]".into()),
    };
    if let Err(e) = result {
        println!("{}", serde_json::json!({ "event": "error", "message": e }));
        std::process::exit(1);
    }
}
