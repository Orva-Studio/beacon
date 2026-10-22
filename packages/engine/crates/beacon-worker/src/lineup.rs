//! Lining a cleaned file up with what was sent (Clean with Auphonic): how late it is at places across it, and its
//! samples moved by that, here rather than in the app's main process, where a minute of audio held it up.

use std::fs;

/// The rate the decoded mono files compared are at: enough to line two takes of the same audio up.
const RATE: f64 = 8000.0;

fn floats(path: &str) -> Result<Vec<f32>, String> {
    let bytes = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    Ok(bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect())
}

/// How late `b` is against `a` over `seconds` from `at` (seconds), looked for within `reach` (coarse, then fine),
/// and how alike they are there (0–1): a stretch with little to go on (near silence, a hum) lines up anywhere.
pub fn matched(a: &[f32], b: &[f32], at: f64, seconds: f64, reach: f64) -> (f64, f64) {
    let from = (at * RATE).round() as usize;
    let to = a.len().min(((at + seconds) * RATE).round() as usize);
    let sample = |j: i64| if j >= 0 && (j as usize) < b.len() { b[j as usize] as f64 } else { 0.0 };
    let score = |d: i64, stride: usize| (from..to).step_by(stride).map(|i| a[i] as f64 * sample(i as i64 + d)).sum::<f64>();
    let search = |lo: i64, hi: i64, step: usize, stride: usize| {
        let (mut best, mut top) = (lo, f64::NEG_INFINITY);
        for d in (lo..=hi).step_by(step) {
            let v = score(d, stride);
            if v > top {
                (top, best) = (v, d);
            }
        }
        best
    };
    let r = (reach * RATE).round() as i64;
    let coarse = search(-r, r, 16, 8);
    let best = search(coarse - 16, coarse + 16, 1, 2);
    let (mut ea, mut eb) = (0.0, 0.0);
    for i in (from..to).step_by(2) {
        ea += (a[i] as f64).powi(2);
        eb += sample(i as i64 + best).powi(2);
    }
    let alike = if ea * eb > 0.0 { score(best, 2) / (ea * eb).sqrt() } else { 0.0 };
    (best as f64 / RATE, alike)
}

/// `align <sent.raw> <back.raw>`: the offset and likeness at about 11 places across the sent audio (5 s each, a
/// third of a shorter one), mono f32 at 8 kHz both.
pub fn align(args: &[String]) -> Result<serde_json::Value, String> {
    let [sent, back] = args else { return Err("usage: align <sent.raw> <back.raw>".into()) };
    let (a, b) = (floats(sent)?, floats(back)?);
    let total = a.len() as f64 / RATE;
    let span = 5f64.min(total / 3.0);
    let step = span.max((total - span) / 10.0);
    let mut places = Vec::new();
    let mut at = 0.0;
    while span > 0.0 && at + span <= total + 1e-9 {
        let (shift, alike) = matched(&a, &b, at, span, 1.0);
        places.push(serde_json::json!({ "at": at, "shift": shift, "alike": alike }));
        at += step;
    }
    Ok(serde_json::Value::Array(places))
}

/// `shift <in.pcm> <out.pcm> <channels> <skip> <frames>`: s16le samples moved by `skip` frames (late: dropped from
/// the start; early, negative: silence before), cut or padded to `frames`.
pub fn shift(args: &[String]) -> Result<serde_json::Value, String> {
    let [input, output, channels, skip, frames] = args else { return Err("usage: shift <in.pcm> <out.pcm> <channels> <skip> <frames>".into()) };
    let parse = |s: &String| s.parse::<i64>().map_err(|e| format!("{s}: {e}"));
    let (channels, skip, frames) = (parse(channels)? as usize, parse(skip)?, parse(frames)? as usize);
    let bytes = fs::read(input).map_err(|e| format!("{input}: {e}"))?;
    let have = bytes.len() / 2 / channels.max(1);
    let mut out = vec![0u8; frames * channels * 2];
    for f in 0..frames {
        let g = f as i64 + skip;
        if g < 0 || g as usize >= have {
            continue;
        }
        let (src, dst) = (g as usize * channels * 2, f * channels * 2);
        out[dst..dst + channels * 2].copy_from_slice(&bytes[src..src + channels * 2]);
    }
    fs::write(output, out).map_err(|e| format!("{output}: {e}"))?;
    Ok(serde_json::json!(frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_delay_and_how_alike() {
        // Noise, and the same noise 46 ms (368 samples at 8 kHz) later.
        let mut seed = 7u32;
        let a: Vec<f32> = (0..40_000)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) as f32 / 32_768.0 - 1.0
            })
            .collect();
        let b: Vec<f32> = std::iter::repeat_n(0.0, 368).chain(a.iter().copied()).collect();
        let (late, alike) = matched(&a, &b, 0.0, 4.0, 1.0);
        assert!((late - 0.046).abs() < 1e-9, "{late}");
        assert!(alike > 0.99, "{alike}");
        let (_, unlike) = matched(&a, &vec![0.0; a.len()], 0.0, 4.0, 1.0);
        assert_eq!(unlike, 0.0);
    }
}
