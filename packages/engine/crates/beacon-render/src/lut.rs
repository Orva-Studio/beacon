//! `.cube` LUTs (Adobe's Cube format, what nearly every LUT is sold as) for passes that name one: a 3D table of
//! colours, red varying fastest, loaded into a 3D texture.

use crate::{Error, Result};

pub struct Cube {
    pub size: u32,
    /// Red, green, blue for each entry, red fastest, then green, then blue.
    pub rgb: Vec<f32>,
}

/// Reads a 3D `.cube`: `LUT_3D_SIZE`, then size³ rows of three numbers. A 1D table is refused.
pub fn read(path: &str) -> Result<Cube> {
    let text = std::fs::read_to_string(path).map_err(|e| Error::Source(format!("{path}: {e}")))?;
    let bad = |what: String| Error::Source(format!("{path}: {what}"));
    let mut size = 0u32;
    let mut rgb = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut words = line.split_whitespace();
        let first = words.next().unwrap_or_default();
        match first {
            "LUT_3D_SIZE" => size = words.next().and_then(|n| n.parse().ok()).filter(|n| (2..=256).contains(n)).ok_or_else(|| bad(format!("bad size: {line}")))?,
            "LUT_1D_SIZE" => return Err(bad("a 1D LUT; only 3D LUTs are read".into())),
            "TITLE" | "DOMAIN_MIN" | "DOMAIN_MAX" | "LUT_3D_INPUT_RANGE" => {}
            _ if first.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '+' || c == '.') => {
                for word in std::iter::once(first).chain(words) {
                    rgb.push(word.parse::<f32>().map_err(|_| bad(format!("not a number: {line}")))?);
                }
            }
            _ => {}
        }
    }
    if size == 0 {
        return Err(bad("no LUT_3D_SIZE".into()));
    }
    if rgb.len() != (size * size * size * 3) as usize {
        return Err(bad(format!("{} values for a {size}³ table, not {}", rgb.len(), size * size * size * 3)));
    }
    Ok(Cube { size, rgb })
}

/// `v` as IEEE half-precision bits, rounded to nearest (what a 16-bit float texture holds).
pub fn half(v: f32) -> u16 {
    let bits = v.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = bits & 0x7f_ffff;
    if exp >= 31 {
        return sign | 0x7c00;
    }
    if exp <= 0 {
        if exp < -10 {
            return sign;
        }
        let m = (mant | 0x80_0000) >> (1 - exp);
        return sign | ((m + 0x1000) >> 13) as u16;
    }
    sign | (((exp as u32) << 10) + ((mant + 0x1000) >> 13)) as u16
}
