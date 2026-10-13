// cargo run --release -p beacon-decode --example native_vs_ffmpeg -- <file> <nth video stream> [width]
// PSNR of the native VideoToolbox path's frames against FFmpeg's, at a few times.
use beacon_decode::{Decoder, Next};

fn frame(d: &mut Decoder, t: f64, w: u32, h: u32) -> (f64, Vec<u8>) {
    d.seek(t).unwrap();
    loop {
        if let Next::Frame(pts) = d.next().unwrap() {
            if pts >= t - 0.0005 {
                let mut buf = vec![0u8; (w * h * 4) as usize];
                d.rgba(&mut buf, w, h).unwrap();
                return (pts, buf);
            }
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (path, nth) = (&a[1], a[2].parse().unwrap());
    let width: u32 = a.get(3).map(|w| w.parse().unwrap()).unwrap_or(960);
    let mut ff = Decoder::open(path, nth, true, 4).unwrap();
    let mut native = Decoder::open_native(path, nth).unwrap();
    let (sw, sh) = ff.size();
    let height = (width as u64 * sh as u64 / sw as u64) as u32 & !1;
    for t in [1.0, 7.3, 19.9, 42.0, 100.5] {
        let (pa, a) = frame(&mut ff, t, width, height);
        let (pb, b) = frame(&mut native, t, width, height);
        let mse = a.chunks(4).zip(b.chunks(4)).map(|(x, y)| (0..3).map(|i| (x[i] as f64 - y[i] as f64).powi(2)).sum::<f64>()).sum::<f64>() / (width * height * 3) as f64;
        let mean = |v: &[u8], i: usize| v.chunks(4).map(|p| p[i] as f64).sum::<f64>() / (width * height) as f64;
        println!("t={t}: pts {pa:.3} / {pb:.3}  PSNR {:.1} dB  mean RGB ffmpeg {:.1},{:.1},{:.1} native {:.1},{:.1},{:.1}", 10.0 * (255.0f64.powi(2) / mse.max(1e-9)).log10(), mean(&a, 0), mean(&a, 1), mean(&a, 2), mean(&b, 0), mean(&b, 1), mean(&b, 2));
    }
}
