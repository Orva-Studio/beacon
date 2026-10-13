# `.brec`: a Beacon recording

A take recorded by `beacon-recorder` (PLAN §13 Phase 6): a folder named
`<name>.brec` holding one file per stream and `recording.json`. Named
2026-10-13; `.trec` is TechSmith's and is not written.

## Files
| File | Stream | Format |
|-|-|-|
| `screen.mp4` | the display, without the cursor | HEVC (VideoToolbox), fragmented MPEG-4 (2 s fragments), the display's pixel size, up to 60 fps, frames only when the screen changes |
| `camera.mp4` | the camera | HEVC, fragmented MPEG-4, the camera's recommended size |
| `system-audio.wav` | what the Mac plays | 16-bit PCM, 48 kHz stereo |
| `microphone.wav` | the microphone | 16-bit PCM, the device's rate and channels (e.g. 16 kHz mono for Bluetooth headphones) |
| `recording.json` | what the take holds | below |

A stream that wasn't recorded has no file. Audio is PCM, not AAC: FFmpeg reads
AVAssetWriter's AAC 44 ms late (its priming), and an unfinished `.m4a` can't be
read at all; an unfinished WAV and fragmented MP4 can.

## `recording.json`
Written when the take starts (`complete: false`, `duration: null`) and again
when it stops, so a take the recorder never finished still describes itself.

```json
{
  "version": 1,
  "complete": true,
  "startedAt": 1791922870.87,
  "duration": 6.0065,
  "streams": {
    "screen": { "file": "screen.mp4", "start": 0.0162, "display": 1, "width": 3600, "height": 2338, "fps": 60, "buffers": 196, "dropped": 0, "latencyMs": { "p50": -0.9, "p95": 7.9, "max": 16.3 }, "error": null },
    "systemAudio": { "file": "system-audio.wav", "start": 0.0006, "rate": 48000, "channels": 2, "driftPpm": 0, "buffers": 298, "dropped": 0, "latencyMs": {}, "error": null },
    "microphone": { "file": "microphone.wav", "start": 0.0185, "device": "WH-XB900N", "rate": 16000, "channels": 1, "driftPpm": 0, "buffers": 301, "dropped": 0, "latencyMs": {}, "error": null },
    "camera": { "file": "camera.mp4", "start": 0.02, "device": "MacBook Pro Camera", "width": 1920, "height": 1080, "…": "…" }
  },
  "idleScreenFrames": 151,
  "marks": [3.0067],
  "errors": []
}
```

- **Times** are seconds from the take's start, on the host clock that both
  ScreenCaptureKit and AVFoundation stamp buffers with. `startedAt` is Unix
  seconds; `duration` is the take's length.
- **`start`**: when the stream's first sample falls in the take. Each file
  begins there, so a stream is placed at `start` on the timeline; streams line
  up by it.
- **The take's length is `duration`**, not a file's: a still screen sends no
  frames, so `screen.mp4` can end before the take, and an audio file can run a
  buffer past it.
- `buffers`, `dropped`, `latencyMs` (arrival delay after each buffer's
  timestamp) and `driftPpm` (samples written against the host clock's span) are
  for checking a take; `marks` are the times of `record --tones` tones.
