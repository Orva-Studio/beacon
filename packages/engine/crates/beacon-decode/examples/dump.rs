// cargo run --release -p beacon-decode --example dump -- <file> <nth video stream> <seconds> <width> <height> <out.rgba>
use beacon_decode::{Decoder, Next};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (w, h): (u32, u32) = (a[4].parse().unwrap(), a[5].parse().unwrap());
    let t: f64 = a[3].parse().unwrap();
    let mut d = Decoder::open(&a[1], a[2].parse().unwrap(), true, 4).unwrap();
    d.seek(t).unwrap();
    while let Next::Frame(pts) = d.next().unwrap() {
        if pts >= t - 0.0005 {
            let mut buf = vec![0u8; (w * h * 4) as usize];
            d.rgba(&mut buf, w, h).unwrap();
            std::fs::write(&a[6], buf).unwrap();
            return;
        }
    }
}
