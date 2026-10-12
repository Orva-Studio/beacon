# `.trec` format reference

Checked against the `beacon-media` reader (2026-10-06): all 338 recordings
(recorder versions 2026.1.4–2026.2.3 and 11 tagged `10.0.0`) read with zero
errors. Example values are from a 14.6 min recording. The reader
(`packages/engine/crates/beacon-media`) is the executable form of this page.

## Container
QuickTime/MP4: `ftyp, wide, mdat, moov, TSCR, TSCM` (top level, always in
this order).

| Stream | Codec | Example | Notes |
|---|---|---|---|
| 0 screen | `tscc2` (TechSmith) | 3600×2336 | ffmpeg ≥ 7 decodes it. **Sparse VFR**: frames only when the screen changes; decode with `-fps_mode passthrough`. No cursor in the pixels. |
| 1 camera | H.264 | 3840×2160 @ 29.97 | |
| 2 microphone | AAC | 44.1 kHz mono | |

Not every recording has all three. Across the corpus: screen + camera + mic
(about 170), screen only (85), **camera + mic only** (75, the intros and outros),
mic only (2), and a few with a second audio track. Screen sizes seen:
3600×2336 and 3360×2100; cameras 3840×2160, 1920×1080 and 1280×720. The
codec fourcc is `tsc2` (ffmpeg calls the codec `tscc2`).

`TSCR` body (64 bytes): `u32 1, u32 0`, then NUL-padded fixed-width
`name[20], version[16], platform[4], os[16]`, e.g. `Camtasia`, `2026.2.0`,
`Mac`, `26.6.2`. The 11 recordings tagged `10.0.0` have `Mac` in the name
field and an empty platform.

## `TSCM` metadata
A run of records: `u32 1, "DATA", u64 size (BE), 16-byte id, body`. All ids
end `…7a1f11e283d00017f200be7f`; the first 4 bytes give the type. Every body
starts `u32 version, u32 recordSize` (0 = variable-length records). Numbers
are little-endian; times are `f64` seconds from recording start.

| Id | Contents | Layout | Use in Beacon |
|---|---|---|---|
| `af2` | **Cursor position** | `f64 t, i32 x, i32 y` (points), ~30 Hz (25–94) | cursor rendering |
| `af1` | **Cursor image timeline** (body version **2**) | records `u32 n, f64 t, u64 imageIndex, u32 innerLen, inner`. A record that introduces an image has `u32 pngLen, u32 hotX, u32 hotY, PNG` then a 24-byte trailer; one that switches back to an earlier image has only the trailer. Trailer: `i32 (-1 new / 0 reuse), u32, u32, u32, f32 1.0, f32 scale` (0.5 for Retina cursors, 1.0 for some). Hotspot Y counts from the bottom of the PNG | cursor rendering |
| `af0` | **Mouse buttons** | `f64 t, u32 type` (12-byte records), starting with `(0.0, 256)`. 1/2 left down/up, 4/8 probably right down/up; rarer 17, 18, 130, 226 not yet decoded | click effects, auto-zoom on clicks |
| `af5` | **Keyboard shortcuts** | `f64 t, u32 key, u32 flags`; flags use macOS modifier bits (0x100000 ⌘, 0x40000 ⌃) | keystroke overlays; agent hints ("cut at ⌘Z") |
| `a05` | **Scroll wheel** | `f64 t, i32 dx, i32 dy` (4,638 events) | scroll-aware zoom/pan |
| `a06` | **Focused app timeline** | records `u32 n, f64 t, name[n-8]` (ChatGPT, Arc, WezTerm, Finder…) | chapters, agent context |
| `a07` | **Window title timeline** | same layout (e.g. `[3/4] vi script.md ~/c/f/chatgpt-plugin`) | chapters, agent context |
| `af7` | Focused window rect over time | `f64 t, i32 x, i32 y, i32 w, i32 h` | SmartFocus-style auto zoom |
| `af6` | Captured display bounds (in 261/338) | `f64 t, i32 x, i32 y, i32 w, i32 h` in global points, e.g. `(0, 1, 1800, 1168)` or `(-1800, 1, 1800, 1168)` for a second display | coordinate mapping |
| `a08` | Periodic stat every 5 s | `f64 t, f32 v` (~0.08–0.10; likely CPU load or dropped-frame ratio) | ignore |
| `a0a` | GPU samples | records `u32 n, f64 t, f32 value, u32 flags, name[n-16]` (`Apple M5 Pro`) | ignore |
| `a0f` / `a10` | Capture device names / ids | records `u32 n, f64 t, u32 kind, text[n-12]`; kind 1 display, 2 camera, 3 microphone, 4 system audio | show source info |
| `afc` | System info | records `u32 n, f64 t, text[n-8]` (`ProcessorCount:18`, `OSVersion:…`, `RAM:49152MB`) | ignore |
| `af3` | always `f64 0, f64 1.0` (record size 16) | | unknown |
| `afb` | always `f64 0, u32 2` (record size 12; in 261/338) | | unknown |
| `af8`, `af9`, `afa` | always empty | | unknown |

## Privacy note
Recordings carry app names, **window titles** and **keyboard shortcuts**.
Beacon should treat this as private: never send it to a cloud service
without the user asking, and keep it out of exported files.

## Ideas this enables (backlog)
- Auto-zoom to clicks and focused windows.
- Chapters or cut suggestions at app/window switches.
- Keystroke overlays for shortcuts.
- Agent context: "remove the part where I was in the terminal".
