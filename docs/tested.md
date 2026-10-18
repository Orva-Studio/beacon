# What has been tested

Who checked what, when, and on which commit, so nothing is checked twice by hand. **By hand** is the user in
the real app; **headless** is an agent (UI-harness flows, renders, core queries), which can't see the app's
window. A change to something after its check moves it back to *Not checked yet*. Update this file when a
feature lands and when it is checked.

## Review fixes (`fix/review-bugs`, `docs/review-2026-10-17.md` §1)

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| A take started through core (as `recorder_start` does) gets the camera's measured delay from Settings | 2026-10-18 | `ebd8286` | Core with a stand-in recorder: `offsets: { camera: -0.12 }` sent for a 120 ms delay |
| Canvas Color shows a background with alpha (`#rrggbbaa`, as a Camtasia import keeps it) | 2026-10-18 | `cdfbd96` | UI flow: red, where it was black before the fix |
| Zoom To on stitched media works; `timeline_clips` gives it a size | 2026-10-18 | `4818dca` | Core on `video.mp4` split then stitched (it threw "no content size" before) |
| Clippy clean with warnings as errors, and part of `bun run typecheck` | 2026-10-18 | `284ee96` | Run |
| Export's data rate Automatic by default, from the dialog and for agents: 10 Mbps at 1080p30, by size and rate, never below 8; a typed rate kept | 2026-10-18 | (this branch) | UI flow (10000, then 40000 fitted within 4K); a 20 s export of `recording.trec` at 10.15 Mbps, a typed 3000 at 3.08 |

### Not checked yet

- A real camera take recorded by an agent over MCP lines up as one from the Record dialog does.
- GPU memory steady while zooming a tilted clip with a drop shadow (render targets now freed; not measured).
- Open Recent, the Export and Record dialogs' last choices still there after the update (their files moved
  into the config folder through core, same folder for the app).
- A Quiet proxy build with Beacon's MCP server started with a short PATH; Reveal in Finder and the narration
  countdown beeps still work (tools now run by their full paths).
- Forgetting a transcript while Apple's or OpenAI's transcriber runs cancels it (built only).
- A 12.5 fps `.cmproj` imports at 25/2 (built only; export's 12.5 fps test passes).
- The Export dialog in the app: it remembers its last settings, so choose Automatic once (yours were the old
  6000 default); then an export's size about 75 MB a minute at 1080p30.

## Phase 8 (`phase-8`)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|
| A dropped clip stays where it was dropped while the move applies; trims too | 2026-10-17 | `96521e4` | "Both fixes work" |
| Tab in the command palette moves through the list and never selects a clip behind it | 2026-10-17 | `07ac778` | "Both fixes work" |
| Favourites: starring, double-click to apply, reordering in the Favorites panel | 2026-10-17 | `6936f6e` | "Favourites work, so do shortcuts, colour labels" |
| Settings › Shortcuts: rebinding, clashes, reset | 2026-10-17 | `56ac44d` | "Favourites work, so do shortcuts, colour labels" |
| Colour labels from the clip menu: a stripe along the top | 2026-10-17 | `024f82e` | "Favourites work, so do shortcuts, colour labels" |
| Resizing on the canvas snaps (sides and corners, to the recording and the canvas) | 2026-10-17 | `2a0c805` | "Snapping works great" |
| Shortcuts run once (from the keys and the menus), and work with a dialog open | 2026-10-17 | `9e0bd91` | "Shortcuts run once"; "the shortcuts work with dialogs open" |
| No spelling suggestion bar or corrections over the caption and callout text boxes | 2026-10-17 | `74e0388` | "It's fixed now" |

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| Voice narration: the microphone alone in the Record dialog (or Tools › Voice Narration…) turns it into narration (no previews, timeline sound off by default with a headphones warning, the span it plays: playhead, range, or nothing after the playhead so it records there), countdown, Stop and Discard in the title bar | 2026-10-16 | `9b26e7b` | UI flow; screenshots of the dialog and the title bar |
| Narration in core: plays the range muted on the audio device, ends by itself at the range's end, lands on a new Narration track at its start lined up by the host clock, one undo step; Discard adds nothing and deletes the take; with nothing after the playhead it records there without playing | 2026-10-16 | `9b26e7b` | Core test with a stand-in recorder (no microphone) and the real audio output |
| Record button (red dot) at the top left opens the Record dialog; hidden while narrating | 2026-10-16 | `f2d6996` | UI flow; screenshot |
| The Narration panel (tool rail), as Camtasia's: microphone and its level, timeline sound off by default, Start Voice Recording with a countdown, Stop | 2026-10-16 | `4175f89` | UI flow; screenshot |
| The playhead's time white on the ruler's colour | 2026-10-17 | `fdb023c` | Screenshot |
| App settings through core: an agent's change shows in an open Settings window, the window's reaches core; ui_open shows Settings (on a tab), Export, Export Selection, New Project and Record, and closes them | 2026-10-17 | `0741288` | UI flow; screenshot |
| Offline: the AI tools greyed with why while OpenAI's transcriber has media to transcribe (not with Apple's); Settings marks it and offers the others; the speech model's download waits | 2026-10-17 | `a2d055a` | UI flow with the page told it's offline; screenshot |
| Command palette: ⌘K lists the panels' items (favourites first) and the AI tools, searched by name or description; Enter adds an annotation at the playhead, an effect on the selected clips, or opens an AI review; its key can be rebound | 2026-10-17 | `6d25603` | UI flow; screenshot |

### Not checked yet

- **A real narration take's alignment**: a clap recorded over a click in the timeline lands within a frame of it.
- Narrating in the app: the countdown, the timeline playing with and without its sound, ⌘⇧2, Space or a click on
  the timeline ending it, the take transcribed afterwards.
- `recorder_start` with `narrate` over MCP with the app open.
- `settings_set` and `ui_open` over MCP with the app open, checked with `ui_snapshot` (the gate's agent half).
- Offline in the app: turning Wi-Fi off greys the AI tools (with OpenAI's transcriber chosen and new media).
- **Menus showing shortcuts**: ⌘/⌃ keys beside items (File, Edit, View, Tools), others after the name; a rebound key
  showing in the menu at once; ⌘ keys not acting while typing in a text field (e.g. ⌘D in the project name), and ⌘A,
  ⌘Z, ⇧⌘Z still editing there.
- Settings › General's choices still there after the update (settings now saved by core).
- Settings › Shortcuts and the palette in the app: rebinding to a ⌘ key the menu also has (Export ⌘E), ⌘K over a
  dialog.
- `favorites_add` over MCP showing in the open window.

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
