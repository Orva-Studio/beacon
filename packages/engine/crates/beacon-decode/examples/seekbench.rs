// cargo run --release -p beacon-decode --example seekbench -- <file> <nth video stream> <hw 0|1|native> <threads> [width] [span seconds]
use beacon_decode::{Decoder, Next};
use std::time::Instant;

fn exact(d: &mut Decoder, t: f64) -> f64 {
    d.seek(t).unwrap();
    loop {
        match d.next().unwrap() {
            Next::Frame(pts) if pts >= t - 0.0005 => return pts,
            Next::Frame(_) => {}
            Next::End => return -1.0,
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (path, nth, hw, threads) = (&a[1], a[2].parse().unwrap(), a[3] == "1", a[4].parse().unwrap());
    let native = a[3] == "native";
    let width: u32 = a.get(5).map(|w| w.parse().unwrap()).unwrap_or(960);
    let span: f64 = a.get(6).map(|w| w.parse().unwrap()).unwrap_or(200.0);
    let t0 = Instant::now();
    let mut d = if native { Decoder::open_native(path, nth) } else { Decoder::open(path, nth, hw, threads) }.unwrap();
    let (sw, sh) = d.size();
    let height = (width as u64 * sh as u64 / sw as u64) as u32 & !1;
    let mut buf = vec![0u8; (width * height * 4) as usize];
    println!("{path} v:{nth} {sw}x{sh} hw={hw} threads={threads} open {:.1} ms", t0.elapsed().as_secs_f64() * 1e3);
    let mut seed: u64 = 1;
    let mut times = vec![];
    for _ in 0..40 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let t = 1.0 + (seed >> 11) as f64 / (1u64 << 53) as f64 * (span - 2.0);
        let s = Instant::now();
        exact(&mut d, t);
        d.rgba(&mut buf, width, height).unwrap();
        times.push(s.elapsed().as_secs_f64() * 1e3);
    }
    let mut back = vec![];
    for i in 0..60 {
        let t = (span * 0.8).min(120.0) - i as f64 * 2.0 / 30.0;
        let s = Instant::now();
        exact(&mut d, t);
        d.rgba(&mut buf, width, height).unwrap();
        back.push(s.elapsed().as_secs_f64() * 1e3);
    }
    // Straight through: decode alone, then decode plus the RGBA conversion.
    d.seek((span / 4.0).min(60.0)).unwrap();
    let s = Instant::now();
    for _ in 0..120 { d.next().unwrap(); }
    let decode = s.elapsed().as_secs_f64() * 1e3 / 120.0;
    let s = Instant::now();
    for _ in 0..120 { d.next().unwrap(); d.rgba(&mut buf, width, height).unwrap(); }
    let both = s.elapsed().as_secs_f64() * 1e3 / 120.0;
    println!("  straight through: decode {decode:.2} ms a frame, + RGBA at {width} wide {:.2} ms", both - decode);
    for (name, mut xs) in [("random jumps", times), ("backward 2-frame steps", back)] {
        xs.sort_by(f64::total_cmp);
        let p = |q: f64| xs[((xs.len() - 1) as f64 * q) as usize];
        println!("  {name:24} p50 {:6.1} ms  p95 {:6.1} ms  max {:6.1} ms", p(0.5), p(0.95), xs[xs.len() - 1]);
    }
}
