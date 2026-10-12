//! Frames decoded in process are byte-identical to the ffmpeg command line's (the decoder
//! the preview and export used before), including each source's colour matrix, through
//! FFmpeg's VideoToolbox path (export) and the native one (the preview) alike.
use beacon_decode::{Decoder, Next};
use std::path::PathBuf;
use std::process::Command;

fn ours(path: &str, nth: u32, t: f64, w: u32, h: u32, native: bool) -> Vec<u8> {
    let mut d = if native { Decoder::open_native(path, nth) } else { Decoder::open(path, nth, true, 4) }.unwrap();
    d.seek(t).unwrap();
    loop {
        if let Next::Frame(pts) = d.next().unwrap() {
            if pts >= t - 0.0005 {
                let mut buf = vec![0u8; (w * h * 4) as usize];
                d.rgba(&mut buf, w, h).unwrap();
                return buf;
            }
        }
    }
}

fn theirs(path: &str, nth: u32, t: f64, w: u32, h: u32) -> Vec<u8> {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &format!("{:.4}", t - 0.0005), "-i", path, "-map", &format!("0:v:{nth}"), "-frames:v", "1"])
        .args(["-vf", &format!("scale={w}:{h}:flags=area"), "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()
        .unwrap();
    out.stdout
}

#[test]
fn frames_match_the_ffmpeg_command_line() {
    let project = PathBuf::from(std::env::var("HOME").unwrap()).join("client-videos/firecrawl/ai-slop/ai-slop.cmproj");
    if !project.exists() {
        return;
    }
    let recording = std::fs::read_dir(project.join("recordings")).unwrap().flatten().map(|e| e.path().join("demo_3.trec")).find(|p| p.exists()).unwrap();
    let cases = [
        (recording.clone(), 1, 30.0, 960, 540),
        (recording, 0, 30.0, 960, 622),
        (project.join("media/1787669072.456843/cta.mp4"), 0, 2.0, 960, 540),
        (project.join("media/1787678532.040916/firecrawl_2090832086106022127.mp4"), 0, 2.0, 640, 360),
    ];
    for (path, nth, t, w, h) in cases {
        let path = path.to_str().unwrap();
        let expected = theirs(path, nth, t, w, h);
        for native in [false, true] {
            assert!(ours(path, nth, t, w, h, native) == expected, "{path} v:{nth} at {t} s differs (native: {native})");
        }
    }
}
