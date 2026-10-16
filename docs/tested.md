# What has been tested

Who checked what, when, and on which commit, so nothing is checked twice by hand. **By hand** is the user in
the real app; **headless** is an agent (UI-harness flows, renders, core queries), which can't see the app's
window. A change to something after its check moves it back to *Not checked yet*. Update this file when a
feature lands and when it is checked.

## Phase 8 (`phase-8`)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| Voice narration: the microphone alone in the Record dialog (or Tools › Voice Narration…) turns it into narration (no previews, timeline sound off by default with a headphones warning, the span it plays: playhead, range, or nothing after the playhead so it records there), countdown, Stop and Discard in the title bar | 2026-10-16 | `9b26e7b` | UI flow; screenshots of the dialog and the title bar |
| Narration in core: plays the range muted on the audio device, ends by itself at the range's end, lands on a new Narration track at its start lined up by the host clock, one undo step; Discard adds nothing and deletes the take; with nothing after the playhead it records there without playing | 2026-10-16 | `9b26e7b` | Core test with a stand-in recorder (no microphone) and the real audio output |
| Record button (red dot) at the top left opens the Record dialog; hidden while narrating | 2026-10-16 | `f2d6996` | UI flow; screenshot |
| The Narration panel (tool rail), as Camtasia's: microphone and its level, timeline sound off by default, Start Voice Recording with a countdown, Stop | 2026-10-16 | `4175f89` | UI flow; screenshot |

### Not checked yet

- **A real narration take's alignment**: a clap recorded over a click in the timeline lands within a frame of it.
- Narrating in the app: the countdown, the timeline playing with and without its sound, ⌘⇧2, Space or a click on
  the timeline ending it, the take transcribed afterwards.
- `recorder_start` with `narrate` over MCP with the app open.

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
| Remove Silences and Remove Filler Words reviews on Test_yeti | 2026-10-16 | `a0b1f86` | "They both work great" |
| Export of a range with captions burned in, `.srt` beside it (Whisper on this Mac) | 2026-10-16 | `a0b1f86` | "Works perfectly"; frames checked: captions, Round Corners and Border, no CRT (none in the project) |

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
| One at a time in both reviews: ‹ ›, ⌥-click a mark, Skip, Cut This One (one undo step, review stays on the next) | 2026-10-16 | `495e005` | UI flows; both cut one item on Test_yeti headless |
| Caption style kept when a caption is pasted into another project, grouped, ungrouped or moved to another track (PR #15 review) | 2026-10-16 | `282580f` | Core commands on a copy of Test_yeti: size 90 kept (was lost on paste, group and move) |
| A drag's last value sent before Undo (PR #15 review) | 2026-10-16 | `c34b353` | Deferred replies: drag 1 → drag 3 → Undo → drag 4; UI flows |
| Cancelling an OpenAI transcription stops its uploads (PR #15 review) | 2026-10-16 | `f7e2cbc` | Mocked fetch, no audio uploaded: 1 request then cancelled (was 8 and stored) |
| Caption highlight in capitals with words that grow ("Straße") (PR #15 review) | 2026-10-16 | `cb99ec4` | Built only; not rendered |

### Not checked yet

- **The Phase 7 gate**, on a real take with each transcriber (Whisper on this Mac, Apple's, OpenAI's, which
  needs an API key): fillers cut cleanly; captions export burned in with a matching `.srt`; a camera clip with a
  rounded border looks the same in preview and export.

### Known, not fixed

- `packages/desktop/__tests__/app.test.ts` fails on this Mac with or without these changes (an installed Beacon
  was running); not looked into.
- Transcribing a 10½-minute take takes about 75 s with Whisper on this Mac: one encoder pass per short chunk
  (PLAN, Phase 7 progress). Ideas: transcribe while recording; Whisper's encoder on the Neural Engine.
