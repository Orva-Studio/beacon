# `.brec`: a Beacon recording

A take recorded by `beacon-recorder` (PLAN §13 Phase 6): a folder named
`<name>.brec` holding one file per stream and `recording.json`. Named
2026-10-13; `.trec` is TechSmith's and is not written.

## Files
| File | Stream | Format |
|-|-|-|
| `screen.mp4` | the display, without the cursor | HEVC (VideoToolbox), fragmented MPEG-4 (2 s fragments), the display's pixel size, scaled down to fit 4K (3840×2160) when larger, up to 60 fps, frames only when the screen changes |
| `camera.mp4` | the camera | HEVC, fragmented MPEG-4, the camera's recommended size |
| `system-audio.wav` | what the Mac plays | 16-bit PCM, 48 kHz stereo |
| `microphone.wav` | the microphone | 16-bit PCM, the device's rate and channels (e.g. 16 kHz mono for Bluetooth headphones) |
| `cursor.jsonl` | the cursor, when the screen is recorded | below |
| `cursor-N.png` | each cursor image seen | PNG at the image's full resolution (Retina: 2× or more) |
| `recording.json` | what the take holds | below |

A stream that wasn't recorded has no file. Audio is PCM, not AAC: FFmpeg reads
AVAssetWriter's AAC 44 ms late (its priming), and an unfinished `.m4a` can't be
read at all; an unfinished WAV and fragmented MP4 can.

## Importing
A take imports as one recording asset whose path is the folder, like a
`.trec`: one Media Bin item, its streams' clips stacked and linked as a
`.trec`'s (camera and audio together, the screen apart). The probe lists each
stream with its `file`, `start` and role (`screen`, `camera`, `microphone`,
`systemAudio`), and `streamSource` (`@beacon/media`) is what everything that
opens a stream reads it through: a `.brec`'s stream `n` is its file's stream 0.
Each clip starts as far into its file as the latest-starting file began after
it, so all show the same moment of the take; a measured device delay (an
`offset` in seconds added to a stream's `start`, from the sync check) moves a
stream the same way. The cursor's times are moved into the screen file's time;
its images are drawn from their PNGs.

## `cursor.jsonl`
The cursor, polled about 120 times a second on the recorder's main thread:
positions and buttons through CoreGraphics (no permission needed), the image
through `NSCursor.currentSystemCursor` (deprecated, but the only way to read
the system cursor; checked on macOS 26) about 30 times a second. One JSON
record per line, appended and flushed every second, so an unfinished take
keeps its cursor up to then. Times are seconds into the take; positions are
global screen points (top-left origin), as `display` is.

```jsonl
{"display":{"x":0.0,"y":0.0,"w":1800.0,"h":1169.0}}
{"t":0.0004,"x":547.29,"y":634.85}
{"image":0,"file":"cursor-0.png","width":280,"height":400,"hotX":50.0,"hotY":50.0,"scale":0.1}
{"t":0.0004,"cursor":0}
{"t":1.2417,"button":1}
{"t":1.3333,"button":2}
```

- `display`: the recorded display's bounds, first.
- A position is written only when it changes.
- `button`: `.trec`'s `af0` codes, which the cursor feature reads: 1 left
  down, 2 left up, 4 right down, 8 right up.
- `image` introduces a cursor image: its PNG, its size in pixels, its hotspot
  in pixels from the top left, and `scale`, image pixels to points (0.1: a
  280×400 image drawn 28×40 points, macOS's large cursor setting). `cursor`
  says which image is in use from `t` on.

## `recording.json`
Written when the take starts (`complete: false`, `duration: null`), again as
soon as each stream's first sample arrives and every 5 s while recording, and
once more when it stops. A take whose recorder was killed still says where
each stream starts, so its files import.

```json
{
  "version": 1,
  "complete": true,
  "startedAt": 1791922870.87,
  "hostStart": 412873.553921,
  "duration": 6.0065,
  "streams": {
    "screen": { "file": "screen.mp4", "start": 0.0162, "display": 1, "width": 3600, "height": 2338, "fps": 60, "buffers": 196, "dropped": 0, "latencyMs": { "p50": -0.9, "p95": 7.9, "max": 16.3 }, "error": null },
    "systemAudio": { "file": "system-audio.wav", "start": 0.0006, "rate": 48000, "channels": 2, "driftPpm": 0, "buffers": 298, "dropped": 0, "latencyMs": {}, "error": null },
    "microphone": { "file": "microphone.wav", "start": 0.0185, "device": "WH-XB900N", "rate": 16000, "channels": 1, "driftPpm": 0, "buffers": 301, "dropped": 0, "latencyMs": {}, "error": null },
    "camera": { "file": "camera.mp4", "start": 0.02, "device": "MacBook Pro Camera", "width": 1920, "height": 1080, "…": "…" }
  },
  "cursor": { "file": "cursor.jsonl", "samples": 412, "clicks": 3, "images": 2 },
  "idleScreenFrames": 151,
  "marks": [3.0067],
  "errors": []
}
```

- **Times** are seconds from the take's start, on the host clock that both
  ScreenCaptureKit and AVFoundation stamp buffers with. `startedAt` is Unix
  seconds; `duration` is the take's length.
- **`hostStart`**: the take's start on the host clock (mach time in seconds, as
  `CMClockGetHostTimeClock` and CoreAudio's timestamps read it). A voice narration
  is placed by it: the app's audio output notes the host time its first sample was
  heard (the output's latency included), and the microphone file starts
  `hostStart + start` on the same clock, so the take lands under what was playing.
  Takes recorded before 2026-10-16 have none.
- **`start`**: when the stream's first sample falls in the take. Each file
  begins there, so a stream is placed at `start` on the timeline; streams line
  up by it.
- **The take's length is `duration`**, not a file's: a still screen sends no
  frames, so `screen.mp4` can end before the take, and an audio file can run a
  buffer past it.
- **`offset`** (seconds, on a stream, when set): added to its `start` on import.
  Beacon writes the camera's from the sync check: minus how late the camera's
  picture is behind the microphone (a capture card's delay), so its clip moves
  earlier and lips match the voice.
- `buffers`, `dropped`, `latencyMs` (arrival delay after each buffer's
  timestamp) and `driftPpm` (samples written against the host clock's span) are
  for checking a take; `marks` are the times of `record --tones` tones.
