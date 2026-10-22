//! Export sidecar. stdin: one `Job` JSON line, then one `Scene` JSON line per
//! frame. stdout: JSON-lines progress (`{"frame":n}`, then `{"done":n}` or
//! `{"error":"..."}`).
//!
//! `beacon-worker matte <input> <stream> <output>`: Remove Background's matte of a video stream instead
//! (`beacon_render::matte`); stdout: `{"time":seconds}` as it goes, then `{"done":[width,height]}` or `{"error":"..."}`.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use beacon_render::scene::{Job, Output, Scene};
use beacon_render::{Renderer, sources};

enum Sink {
    Video(Child, ChildStdin),
    /// VideoToolbox through AVAssetWriter, fed from the GPU (opened once the renderer exists).
    Encode,
    Png(String),
}

fn open_sink(job: &Job, output: &Output) -> Result<Sink, String> {
    match output {
        Output::Video { path, args } => {
            let mut child = Command::new(beacon_render::tool("ffmpeg"))
                .args(["-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba"])
                .args(["-s", &format!("{}x{}", job.width, job.height)])
                .args(["-framerate", &format!("{}/{}", job.fps.num, job.fps.den), "-i", "-"])
                .args(args)
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("ffmpeg: {e}"))?;
            let stdin = child.stdin.take().unwrap();
            Ok(Sink::Video(child, stdin))
        }
        Output::Png { dir } => {
            std::fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
            Ok(Sink::Png(dir.clone()))
        }
        Output::Encode(_) => Ok(Sink::Encode),
    }
}

fn report(msg: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

fn run() -> Result<u64, String> {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let header = lines.next().ok_or("no job on stdin")?.map_err(|e| e.to_string())?;
    let job: Job = serde_json::from_str(&header).map_err(|e| format!("job: {e}"))?;
    let output = job.output.clone().ok_or("job: no output")?;
    let mut renderer = Renderer::new(&job).map_err(|e| e.to_string())?;
    let mut sink = open_sink(&job, &output)?;
    let mut encoder = match &output {
        Output::Encode(e) => Some(beacon_render::encode::Encoder::new(&renderer, e).map_err(|e| e.to_string())?),
        _ => None,
    };
    let mut n = 0u64;
    for line in lines {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let scene: Scene = serde_json::from_str(&line).map_err(|e| format!("scene {n}: {e}"))?;
        if let Some(encoder) = encoder.as_mut() {
            let enc = renderer.draw(&scene).map_err(|e| format!("frame {n}: {e}"))?;
            let t = std::time::Instant::now();
            encoder.frame(&renderer, enc).map_err(|e| format!("frame {n}: {e}"))?;
            renderer.profile.encode += t.elapsed().as_secs_f64();
            n += 1;
            if n.is_multiple_of(30) {
                report(serde_json::json!({ "frame": n }));
            }
            continue;
        }
        let px = renderer.render(&scene).map_err(|e| format!("frame {n}: {e}"))?;
        match &mut sink {
            Sink::Encode => unreachable!("encoded above"),
            Sink::Video(_, stdin) => stdin.write_all(&px).map_err(|e| format!("encoder: {e}"))?,
            Sink::Png(dir) => {
                let name = scene.name.clone().unwrap_or_else(|| format!("{n:06}"));
                sources::encode_png(&Path::new(dir).join(format!("{name}.png")), job.width, job.height, &px).map_err(|e| e.to_string())?;
            }
        }
        n += 1;
        if n.is_multiple_of(30) {
            report(serde_json::json!({ "frame": n }));
        }
    }
    if let Some(encoder) = encoder {
        encoder.finish(&renderer).map_err(|e| e.to_string())?;
    }
    if std::env::var_os("BEACON_PROFILE").is_some() {
        eprintln!("profile: {:?}", renderer.profile);
    }
    if let Sink::Video(mut child, stdin) = sink {
        drop(stdin);
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("encoder exited with {status}"));
        }
    }
    Ok(n)
}

#[cfg(target_os = "macos")]
fn matte(args: &[String]) -> Result<(u32, u32), String> {
    let [input, stream, output] = args else { return Err("usage: beacon-worker matte <input> <stream> <output>".into()) };
    let stream = stream.parse().map_err(|_| format!("stream: {stream}"))?;
    let mut reported = f64::NEG_INFINITY;
    beacon_render::matte::make(input, stream, output, |t| {
        if t - reported >= 1.0 {
            reported = t;
            report(serde_json::json!({ "time": t }));
        }
    })
    .map_err(|e| e.to_string())
}

mod lineup;

type Subcommand = fn(&[String]) -> Result<serde_json::Value, String>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub: Option<Subcommand> = match args.first().map(String::as_str) {
        Some("align") => Some(lineup::align),
        Some("shift") => Some(lineup::shift),
        _ => None,
    };
    if let Some(sub) = sub {
        match sub(&args[1..]) {
            Ok(v) => report(serde_json::json!({ "done": v })),
            Err(e) => {
                report(serde_json::json!({ "error": e }));
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(target_os = "macos")]
    if args.first().map(String::as_str) == Some("matte") {
        match matte(&args[1..]) {
            Ok((w, h)) => report(serde_json::json!({ "done": [w, h] })),
            Err(e) => {
                report(serde_json::json!({ "error": e }));
                std::process::exit(1);
            }
        }
        return;
    }
    match run() {
        Ok(n) => report(serde_json::json!({ "done": n })),
        Err(e) => {
            report(serde_json::json!({ "error": e }));
            std::process::exit(1);
        }
    }
}
