# What has been tested

Who checked what, when, and on which commit, so nothing is checked twice by hand. **By hand** is the user in
the real app; **headless** is an agent (UI-harness flows, renders, core queries), which can't see the app's
window. A change to something after its check moves it back to *Not checked yet*. Update this file when a
feature lands and when it is checked.

## Phase 7 (`phase-7`)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|
| Transcriber choice: Settings › General › Transcripts | 2026-10-15 | `b83f0a2` | "Looks good" |
| Start screen: New Project, Open…, recent projects | 2026-10-15 | `045def2` | |
| Start screen thumbnails of recent projects | 2026-10-16 | `d1b6147` | Four projects shown with their frames |
| Captions from the transcript, the Caption tab's style | 2026-10-16 | `f46d1c5` | Used on Test_yeti; style changes were slow (fixed since, see below) |
| Moving every caption by dragging one | 2026-10-16 | `8a163ba` | Found the outline lagging (fixed since) |
| Caption speed after the style moved onto the track | 2026-10-16 | `55d9400` | "Much much better" |

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| A pointer cursor over buttons, selects, checkboxes | 2026-10-15 | `d1b6147` | Computed style in Chromium |
| "Saved automatically" only for a moment after ⌘S | 2026-10-16 | `ed78e69` | UI flow |
| Border as a property of video and images (Visual tab), border v2 converting old Border effects | 2026-10-16 | `28bedd2` | UI flow, render with Round Corners, preview/export parity test, migration test |
| Missing transcripts start when the app shows a project | 2026-10-16 | `cd67b38` | Offscreen view on a project whose transcript a quit cancelled |
| Captions clicked before the transcript exists: progress, then made | 2026-10-16 | `cd67b38` | UI flow |
| Remove Silences shows the transcript's progress | 2026-10-16 | `cd67b38` | Built; no flow of its own |
| A drag sends only its newest value (every slider) | 2026-10-16 | `ba28850` | UI flows |
| Captions on the canvas: click selects, side handles set the width, double-click types in place (times kept), Align to page | 2026-10-16 | `8a163ba` | UI flows |
| The dragged caption's outline follows the pointer | 2026-10-16 | `bb1fc9f` | Frame by frame: 0.1 px behind (was 5) |
| A caption placed on its own: ⌥-drag, ⌥⇧ for it and those after, Use shared | 2026-10-16 | `bb1fc9f` | UI flow |
| Delete acts on what was selected last (a range made after a clip) | 2026-10-16 | `ad42de9` | UI flow |
| Remove Filler Words: AI tile, review marks, click keeps one, Apply one undo step, Cancel, one review at a time | 2026-10-16 | `a0b1f86` | UI flow (transcript with fillers written in); on a real take headless: 15 fillers, joins checked (PLAN, Phase 7) |
| Captions burned into the export, `.srt` beside it | 2026-10-15 | `f46d1c5` | Export of a range, frame compared with the preview |

### Not checked yet

- **The Phase 7 gate**, on a real take with each transcriber (Whisper on this Mac, Apple's, OpenAI's, which
  needs an API key): fillers cut cleanly; captions export burned in with a matching `.srt`; a camera clip with a
  rounded border looks the same in preview and export.

### Known, not fixed

- `packages/desktop/__tests__/app.test.ts` fails on this Mac with or without these changes (an installed Beacon
  was running); not looked into.
- Transcribing a 10½-minute take takes about 75 s with Whisper on this Mac: one encoder pass per short chunk
  (PLAN, Phase 7 progress). Ideas: transcribe while recording; Whisper's encoder on the Neural Engine.
