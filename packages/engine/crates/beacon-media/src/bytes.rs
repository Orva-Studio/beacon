use crate::{Result, TrecError};

pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    what: &'static str,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], what: &'static str) -> Self {
        Self { buf, pos: 0, what }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if n > self.remaining() {
            return Err(TrecError::format(format!(
                "{}: wanted {n} bytes at offset {}, only {} left",
                self.what,
                self.pos,
                self.remaining()
            )));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn skip(&mut self, n: usize) -> Result<()> {
        self.take(n).map(|_| ())
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.take(N)?.try_into().unwrap())
    }

    pub fn u16_be(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    pub fn u32_be(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.array()?))
    }
    pub fn u64_be(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    pub fn u32_le(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    pub fn i32_le(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.array()?))
    }
    pub fn u64_le(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub fn f32_le(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.array()?))
    }
    pub fn f64_le(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.array()?))
    }
    pub fn f64_be(&mut self) -> Result<f64> {
        Ok(f64::from_be_bytes(self.array()?))
    }

    pub fn fourcc(&mut self) -> Result<String> {
        Ok(fourcc(self.take(4)?))
    }
}

pub(crate) fn fourcc(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|c| format!("{c:02x}")).collect()
}

/// Camtasia pads some strings with trailing NULs.
pub(crate) fn utf8(b: &[u8], what: &'static str) -> Result<String> {
    let end = b.iter().rposition(|&c| c != 0).map_or(0, |i| i + 1);
    String::from_utf8(b[..end].to_vec())
        .map_err(|_| TrecError::format(format!("{what}: string is not UTF-8")))
}
