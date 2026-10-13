//! The cursor during a take, polled from the main thread (`poll`, ~120 Hz):
//! its position and buttons through CoreGraphics (no permission needed), and
//! its image through `NSCursor.currentSystemCursor`, each new image saved as a
//! PNG. Written as `cursor.jsonl` (docs/formats/brec.md), one record per line,
//! so a take the recorder never finished keeps its cursor up to then.
use std::collections::HashMap;
use std::fs::File;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSCursor};
use objc2_core_graphics::{CGEvent, CGEventSource, CGEventSourceStateID, CGMouseButton};
use objc2_foundation::NSDictionary;
use serde_json::{Value, json};

/// `.trec`'s `af0` button codes, which the cursor feature reads.
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 4;
const RIGHT_UP: u32 = 8;

/// Seconds between looks at the cursor's image: converting it costs more than reading the position.
const IMAGE_EVERY: f64 = 1.0 / 30.0;

pub struct CursorLog {
    dir: PathBuf,
    out: BufWriter<File>,
    position: Option<(f64, f64)>,
    left: bool,
    right: bool,
    /// Images saved so far, by a hash of their pixels and hotspot.
    images: HashMap<u64, usize>,
    image: Option<usize>,
    image_at: f64,
    flushed_at: f64,
    pub samples: u64,
    pub clicks: u64,
}

/// The cursor's image as PNG with its size in pixels, hotspot in pixels from the top left, and pixels to points.
fn system_cursor() -> Option<(Vec<u8>, i64, i64, f64, f64, f64)> {
    #[allow(deprecated)]
    let cursor = NSCursor::currentSystemCursor()?;
    let image = cursor.image();
    let points = image.size();
    let tiff = image.TIFFRepresentation()?;
    // The largest representation: a Retina cursor's 2x pixels rather than its 1x.
    let reps = NSBitmapImageRep::imageRepsWithData(&tiff);
    let rep = reps.iter().filter_map(|r| r.downcast::<NSBitmapImageRep>().ok()).max_by_key(|r| r.pixelsWide())?;
    let (w, h) = (rep.pixelsWide() as i64, rep.pixelsHigh() as i64);
    if w <= 0 || points.width <= 0.0 {
        return None;
    }
    let scale = points.width / w as f64;
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    let hot = cursor.hotSpot();
    Some((png.to_vec(), w, h, hot.x / scale, hot.y / scale, scale))
}

impl CursorLog {
    /// `display`: the captured display's bounds in points, in the same global space as the positions.
    pub fn new(dir: &Path, display: Option<[f64; 4]>) -> Result<CursorLog, String> {
        let path = dir.join("cursor.jsonl");
        let file = File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut log = CursorLog {
            dir: dir.to_path_buf(),
            out: BufWriter::new(file),
            position: None,
            left: false,
            right: false,
            images: HashMap::new(),
            image: None,
            image_at: f64::NEG_INFINITY,
            flushed_at: 0.0,
            samples: 0,
            clicks: 0,
        };
        if let Some([x, y, w, h]) = display {
            log.line(json!({ "display": { "x": x, "y": y, "w": w, "h": h } }));
        }
        Ok(log)
    }

    fn line(&mut self, v: Value) {
        let _ = writeln!(self.out, "{v}");
    }

    /// Records what changed since the last poll; `t` is seconds into the take.
    pub fn poll(&mut self, t: f64) {
        let t = (t * 1e4).round() / 1e4;
        if let Some(e) = CGEvent::new(None) {
            let p = CGEvent::location(Some(&e));
            let at = ((p.x * 100.0).round() / 100.0, (p.y * 100.0).round() / 100.0);
            if self.position != Some(at) {
                self.position = Some(at);
                self.samples += 1;
                self.line(json!({ "t": t, "x": at.0, "y": at.1 }));
            }
        }
        let state = CGEventSourceStateID::CombinedSessionState;
        let (left, right) = (CGEventSource::button_state(state, CGMouseButton::Left), CGEventSource::button_state(state, CGMouseButton::Right));
        for (down, was, press, release) in [(left, self.left, LEFT_DOWN, LEFT_UP), (right, self.right, RIGHT_DOWN, RIGHT_UP)] {
            if down != was {
                self.line(json!({ "t": t, "button": if down { press } else { release } }));
                if down {
                    self.clicks += 1;
                }
            }
        }
        (self.left, self.right) = (left, right);
        if t - self.image_at >= IMAGE_EVERY {
            self.image_at = t;
            self.poll_image(t);
        }
        if t - self.flushed_at >= 1.0 {
            self.flushed_at = t;
            let _ = self.out.flush();
        }
    }

    fn poll_image(&mut self, t: f64) {
        let Some((png, w, h, hot_x, hot_y, scale)) = system_cursor() else { return };
        let mut hasher = DefaultHasher::new();
        (&png, hot_x.to_bits(), hot_y.to_bits()).hash(&mut hasher);
        let key = hasher.finish();
        let index = match self.images.get(&key) {
            Some(&i) => i,
            None => {
                let i = self.images.len();
                let file = format!("cursor-{i}.png");
                if std::fs::write(self.dir.join(&file), &png).is_err() {
                    return;
                }
                self.images.insert(key, i);
                self.line(json!({ "image": i, "file": file, "width": w, "height": h, "hotX": hot_x, "hotY": hot_y, "scale": scale }));
                i
            }
        };
        if self.image != Some(index) {
            self.image = Some(index);
            self.line(json!({ "t": t, "cursor": index }));
        }
    }

    pub fn finish(&mut self) -> Value {
        let _ = self.out.flush();
        json!({ "file": "cursor.jsonl", "samples": self.samples, "clicks": self.clicks, "images": self.images.len() })
    }
}
