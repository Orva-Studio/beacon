//! The `.trec` readers fed damaged copies of a real recording's boxes: each must answer with an error or a value,
//! never panic, hang or run away with memory (PLAN Phase 14's gate). Ignored by default (a minute's run);
//! `BEACON_FUZZ_TREC=<file.trec> cargo test -p beacon-media --release -- --ignored fuzz`.

use crate::{mp4, tscm};
use std::fs::File;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

/// xorshift64*: enough randomness for mutations, no dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// A damaged copy: bytes flipped, a run overwritten with extremes (sizes and counts the parser trusts), or cut short.
fn mutate(rng: &mut Rng, src: &[u8]) -> Vec<u8> {
    let mut v = src.to_vec();
    match rng.below(4) {
        0 => {
            for _ in 0..1 + rng.below(16) {
                let i = rng.below(v.len());
                v[i] ^= 1 << rng.below(8);
            }
        }
        1 => {
            let i = rng.below(v.len());
            let fill = [0x00, 0xff, 0x7f, 0x80][rng.below(4)];
            for b in v.iter_mut().skip(i).take(1 + rng.below(8)) {
                *b = fill;
            }
        }
        2 => v.truncate(rng.below(v.len())),
        _ => {
            let i = rng.below(v.len());
            let j = rng.below(v.len());
            let n = rng.below(64).min(v.len() - i.max(j));
            v.copy_within(i..i + n, j);
        }
    }
    v
}

#[test]
#[ignore]
fn fuzz_trec_readers() {
    let Ok(path) = std::env::var("BEACON_FUZZ_TREC") else {
        eprintln!("BEACON_FUZZ_TREC isn't set: nothing to fuzz");
        return;
    };
    let seconds: u64 = std::env::var("BEACON_FUZZ_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let mut file = File::open(&path).unwrap();
    let size = file.metadata().unwrap().len();
    let boxes = mp4::top_level_boxes(&mut file, size).unwrap();
    let body = |kind: &str, file: &mut File| mp4::read_body(file, boxes.iter().find(|b| b.kind == kind).unwrap()).unwrap();
    let (moov, tscr, tscm_body) = (body("moov", &mut file), body("TSCR", &mut file), body("TSCM", &mut file));

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let end = Instant::now() + Duration::from_secs(seconds);
    let (mut cases, mut slow) = (0u64, Duration::ZERO);
    let mut failures = Vec::new();
    while Instant::now() < end {
        let which = rng.below(3);
        let input = mutate(&mut rng, [&moov, &tscr, &tscm_body][which]);
        let t = Instant::now();
        let ran = catch_unwind(AssertUnwindSafe(|| match which {
            0 => drop(mp4::parse_moov(&input)),
            1 => drop(mp4::parse_tscr(&input)),
            _ => drop(tscm::parse_tscm(&input)),
        }));
        let took = t.elapsed();
        slow = slow.max(took);
        if ran.is_err() || took > Duration::from_secs(2) {
            let out = std::env::temp_dir().join(format!("trec-fuzz-{}-{cases}.bin", ["moov", "TSCR", "TSCM"][which]));
            std::fs::write(&out, &input).unwrap();
            failures.push(format!("{} ({}): {}", out.display(), if ran.is_err() { "panicked" } else { "too slow" }, ["moov", "TSCR", "TSCM"][which]));
        }
        cases += 1;
    }
    eprintln!("{cases} damaged boxes read, slowest {slow:?}");
    assert!(failures.is_empty(), "{} inputs broke a reader:\n{}", failures.len(), failures.join("\n"));
}
