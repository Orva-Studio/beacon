//! Frames decoded in process are byte-identical to the ffmpeg command line's (the decoder
//! the preview and export used before), including each source's colour matrix, through
//! FFmpeg's VideoToolbox path (export) and the native one (the preview) alike.
use beacon_decode::{Decoder, Next};
use std::path::PathBuf;
use std::process::Command;

/// A test file in `BEACON_FIXTURES` (default `~/beacon-fixtures`).
fn fixture(name: &str) -> PathBuf {
    std::env::var("BEACON_FIXTURES").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap()).join("beacon-fixtures")).join(name)
}

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
    let (recording, cta, other) = (fixture("recording.trec"), fixture("video-2.mp4"), fixture("video-3.mp4"));
    if ![&recording, &cta, &other].iter().all(|p| p.exists()) {
        return;
    }
    let cases = [
        (recording.clone(), 1, 30.0, 960, 540),
        (recording, 0, 30.0, 960, 622),
        (cta, 0, 2.0, 960, 540),
        (other, 0, 2.0, 640, 360),
    ];
    for (path, nth, t, w, h) in cases {
        let path = path.to_str().unwrap();
        let expected = theirs(path, nth, t, w, h);
        for native in [false, true] {
            assert!(ours(path, nth, t, w, h, native) == expected, "{path} v:{nth} at {t} s differs (native: {native})");
        }
    }
}

/// Stills (beacon-render's images) are decoded the same way: the first frame at its own size.
#[test]
fn images_match_the_ffmpeg_command_line() {
    let png = fixture("image.png");
    if !png.exists() {
        return;
    }
    let path = png.to_str().unwrap();
    let mut d = Decoder::open(path, 0, false, 0).unwrap();
    while !matches!(d.next().unwrap(), Next::Frame(_)) {}
    let (w, h) = d.size();
    let mut buf = vec![0u8; (w * h * 4) as usize];
    d.rgba(&mut buf, w, h).unwrap();
    let out = Command::new("ffmpeg").args(["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().unwrap();
    assert!(buf == out.stdout, "{path} differs");
}
