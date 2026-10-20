# What has been tested

Who checked what, when, and on which commit, so nothing is checked twice by hand. **By hand** is the user in
the real app; **headless** is an agent (UI-harness flows, renders, core queries), which can't see the app's
window. A change to something after its check moves it back to *Not checked yet*. Update this file when a
feature lands and when it is checked.

## Phase 8.5 (`phase-8.5`)

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| Files dropped from Finder are found by the drag's own paths (macOS's drag pasteboard), on any drive: no more home folders or Spotlight | 2026-10-19 | this commit | Cargo test (file URLs on a pasteboard come back as paths); core test (matched by name, size and date among the drag's paths); a copy of `video.mp4` under the scratchpad's `card/DCIM/107_PANA` (not in Spotlight) put on the drag pasteboard as Finder would: `findDropped` returned its path |

### Not checked yet

- Dragging a clip straight off the camera card onto the timeline, the canvas and the Media Bin.

## Structure (`refactor/structure`, `docs/review-2026-10-17.md` §3)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|
| Shortcuts work straight after switching back from another app, with no click (the page takes the keys back from the canvas's native view) | 2026-10-19 | `12c6909` | The user: "just tested the app switching and it works" |
| Unlink Recording unlinks every selected recording, not only the clicked one (`edit.unlink` on the selection; `clip.unlink` takes `clips`) | 2026-10-19 | `c942190` | Core test (two takes, both cameras selected, one Unlink: no links left, one undo restores them; fails without the fix); UI flow (two recordings selected, Unlink by a key: all unlinked, one undo); the user: "I've tested all these things" |
| **Recording in the app** (`349dbb8` changed how the take and the Record dialog's previews set up capture): a take with screen, system audio, camera and microphone; the Record dialog's camera and screen previews and levels; voice narration; Check Sync. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **The canvas in the app** after the shader changes (`d584f2b`): video, a tilted clip with drop shadow, CRT, round corners, the selection handles and guides drawn by the preview; an MP4 export plays as before. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Settings › General's proxy choices** taking effect at once (video files on/off) and Quiet/Fast, now applied by core. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Panels**: Annotations, Visual Effects and Audio Effects tiles and their names (Corner Rounding…), favourites. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Renaming** a track, a medium and the project in place: Return keeps, Escape drops, clicking away keeps. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **⌘S** shows "Saved automatically"; on the start screen ⌘N and ⌘O. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Dialog corners over the canvas** (Settings, Export, Record…), the toast's and the colour picker's: the dimmed video shows around the rounded corner, no dark square. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Return in dialogs** (Export, Record, New Project, Save As, the speech model sheet) does the default action with any button or checkbox focused, and doesn't also press it. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **New Project with Auto-normalize off**, then Project Settings shows it off. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Context menus in the app** (rebuilt from `actions.json`): clip menu (Cut … Split at Playhead, colour labels, Open Group/Ungroup only on a group, Group otherwise, Remove All Stitches on stitched media, Stitch Selected Media only when the selection can be stitched, shortcuts shown beside items), canvas menu (Project Settings…, Paste, Zoom to Fit), track menus, Media Bin menu (Reveal in Finder now through Finder's own call). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| File menu: New, Open, Open Recent (and Clear Menu), Save As, renaming the project from its name; switching projects keeps the canvas, thumbnails, waveforms and missing-media marks; the start screen's pictures. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Export dialog's last folder and settings; the Media Bin preview (play, seek, close). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| Core split (analyses, recording, thumbnails, registry info) behaves as before | 2026-10-18 | `dc4ae1c` | core, features, mcp, camtasia tests; UI flows |
| Desktop split: boot, open, MCP over the socket | 2026-10-18 | `6235adc` | `app.test.ts` (passes on this Mac now); UI flows |
| Proxies follow Settings › General in core; a settings.json written by another process is told and followed; the desktop keeps no settings copy | 2026-10-18 | `7d3faab` | Core test (no proxy for a video until an agent's core turns video proxies on); UI flow (a video file gets no proxy with video off); `app.test.ts` |
| Project names: one check for rename, New Project and Save As; export makes its folder; MCP undo says what it undid | 2026-10-18 | `7d3faab` | Core and MCP tests |
| Effects through `EffectDef.apply`; Camtasia effects filled from defaults; migrations' walkers; shutter, solid, audio defaults, envelope import | 2026-10-18 | `8842c3d`, `049c242`, `6f2b85a` | All 34 `.cmproj` under ~/client-videos and the fixtures: imports and evaluated scenes (60 times each) identical before and after; migration tests (transform v2 new) |
| Panels from the feature contract (annotation and audio items, effect titles, new user's favourites in the same order) | 2026-10-18 | `20b4691` | UI flow |
| One review panel; the timeline's and canvas's modules; renames in place (track, media, project), ⌘S and the start screen's keys from the keymap (rebinding New Project works there) | 2026-10-18 | `288a090`, `02c1e09`, `d79b972`, `6ee798b` | UI flows (new: rename in place; start screen with a rebound New Project) |
| Export options from one schema; canvas form ↔ settings; prop-group defaults; eyedropper context | 2026-10-19 | `eca39b6`, `f40fdab`, `07a7e40`, `c373bf2` | MCP test (export_start's fields), core tests (new project with Auto-normalize off, schema defaults), UI flows |
| ffmpeg helpers and PCM decoding; JSON-lines reader; Check Sync's version check; scene building; release scripts | 2026-10-19 | `0c8e3eb`…`f254513` | Waveform peaks of the fixtures identical; core/render/MCP tests; a take with `recording.json` version 2 refused; `check-release.ts` on a staged engine folder (exports, import, frame, whisper, speech) |
| Engine: FFI marshalling, common.wgsl and gpu.rs, the scene walk, CoreFoundation, bitmap context, colour matrix; the worker without its raw output | 2026-10-19 | `047f94b`, `d584f2b`, `cdc4240`, `78f941d`, `768e9f3` | 36 PNG frames of three projects (two client projects with CRT, drop shadow, round corners, motion blur, callouts, cursors) byte-identical before and after; FFI smoke (cursor track, cursor image, PNG paste, a bad PNG's error); core export, parity and playback tests; clippy |
| The desktop imports only core and ui | 2026-10-19 | `8b9718a` | `app.test.ts`; UI flows |
| The PR review's fixes: bad settings leave no folder; Camtasia shadow defaults; settings reloaded from disk told once (back to defaults too); Return in a dialog is its default action, never also the focused button's click | 2026-10-19 | `2dc92f7`, this commit | Core tests (a standalone copy that fails half way leaves no folder: fails without the fix); features tests (registry's panel-item checks); UI flows (Return on a focused Not Now downloads and doesn't decline: fails without the fix) |

## Hot paths (`perf/hot-paths`, `docs/review-2026-10-17.md` §2, numbers in `docs/performance.md`)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|
| Dragging on the canvas and sliders on a long timeline in the app: smooth, and Undo puts it back in one step. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Scrubbing and jumping around a `.trec` project from its originals in the app: cursors and captions draw right after they come back on screen. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Waveforms in the app: importing a file again (or one another project analysed) shows its waveform at once (built only: the desktop now sends the waveforms the window doesn't have yet, after jobs and edits). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| Progress messages and playback with a group open don't redraw the timeline | 2026-10-18 | `ce98793` | Redraws counted in the UI harness on a copy of a 304-clip project: 20 → 0, 30 → 0 |
| Imports probe four files at a time; a finished waveform is sent alone | 2026-10-18 | `917f8fa` | 7 fixtures imported in 0.26 s (was 0.67); UI flows |
| The decode thread reuses frame buffers; cursors, text and strokes cached | 2026-10-18 | `7189a08`, `fb1612b` | `perf.ts --no-proxies` on the 304-clip project; still loads counted (13 → 8) |
| A drag step validates only what it changed | 2026-10-18 | `a4771b4` | 2.2 → 0.16 ms on the 304-clip project; bad values still rejected; undo-exactness tests |
| The timeline lets go of thumbnails no clip shows | 2026-10-18 | `0c0581b` | UI flows |

## Review fixes (`fix/review-bugs`, `docs/review-2026-10-17.md` §1)

### Checked by hand

| What | Date | Commit | Notes |
|---|---|---|---|
| GPU memory steady while zooming a tilted clip with a drop shadow (render targets now freed; not measured). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Open Recent, the Export and Record dialogs' last choices still there after the update (their files moved into the config folder through core, same folder for the app). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Forgetting a transcript while Apple's or OpenAI's transcriber runs cancels it (built only). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| A 12.5 fps `.cmproj` imports at 25/2 (built only; export's 12.5 fps test passes). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| The Export dialog in the app opens on Automatic (a saved 6000, the old default, is taken as Automatic), and an export at 1080p30 is about 75 MB a minute; with ProRes the Data rate row is hidden; WebM's says constant quality. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Zoom To on a stitched clip next to another stitched clip zooms only the one asked for (built only). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |

### Checked headless only (still to see by hand)

| What | Date | Commit | How |
|---|---|---|---|
| A take started through core (as `recorder_start` does) gets the camera's measured delay from Settings | 2026-10-18 | `ebd8286` | Core with a stand-in recorder: `offsets: { camera: -0.12 }` sent for a 120 ms delay |
| Canvas Color shows a background with alpha (`#rrggbbaa`, as a Camtasia import keeps it), and a colour picked keeps the alpha | 2026-10-18 | `89c6a39` | UI flow: red, where it was black before the fix; white picked gives `#ffffff80` |
| Zoom To on stitched media works; `timeline_clips` gives it a size | 2026-10-18 | `4818dca` | Core on `video.mp4` split then stitched (it threw "no content size" before) |
| Clippy clean with warnings as errors, and part of `bun run typecheck` | 2026-10-18 | `284ee96` | Run |
| Export's data rate Automatic by default, from the dialog and for agents: 10 Mbps at 1080p30, by size and rate, never below 8; a typed rate kept | 2026-10-18 | `f793f55` | UI flow (10000, then 40000 fitted within 4K); a 20 s export of `recording.trec` at 10.15 Mbps, a typed 3000 at 3.08 |

### Not checked yet

- A real camera take recorded by an agent over MCP lines up as one from the Record dialog does.
- A Quiet proxy build with Beacon's MCP server started with a short PATH; Reveal in Finder and the narration countdown beeps still work (tools now run by their full paths).

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
| **A real narration take's alignment**: a clap recorded over a click in the timeline lands within a frame of it. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Narrating in the app: the countdown, the timeline playing with and without its sound, ⌘⇧2, Space or a click on the timeline ending it, the take transcribed afterwards. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Offline in the app: turning Wi-Fi off greys the AI tools (with OpenAI's transcriber chosen and new media). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| **Menus showing shortcuts**: ⌘/⌃ keys beside items (File, Edit, View, Tools), others after the name; a rebound key showing in the menu at once; ⌘ keys not acting while typing in a text field (e.g. ⌘D in the project name), and ⌘A, ⌘Z, ⇧⌘Z still editing there. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Settings › General's choices still there after the update (settings now saved by core). | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |
| Settings › Shortcuts and the palette in the app: rebinding to a ⌘ key the menu also has (Export ⌘E), ⌘K over a dialog. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |

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

- `recorder_start` with `narrate` over MCP with the app open.
- `settings_set` and `ui_open` over MCP with the app open, checked with `ui_snapshot` (the gate's agent half).
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
| **The Phase 7 gate**, on a real take with each transcriber (Whisper on this Mac, Apple's, OpenAI's, which needs an API key): fillers cut cleanly; captions export burned in with a matching `.srt`; a camera clip with a rounded border looks the same in preview and export. | 2026-10-19 | `5d76110` | The user: "I've tested all these things" (the gates' run, on web-hijack) |

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

### Known, not fixed

- `app.test.ts` fails while the screen is locked or the display asleep (the window draws nothing, so it never reports
  what it shows); it passes once unlocked (2026-10-19).
- One full UI run (2026-10-19, on a loaded Mac, 223 s instead of 62) timed out four caption flows; the next run passed
  all 73.
- `bun audit` reports a high advisory in `braces` (dev only: `@tailwindcss/cli` → `@parcel/watcher` → `micromatch`), at
  `main` too; cargo deny is clean.

- The UI flow "the ruler moves the playhead past the last clip" failed once in a full run (2026-10-18; the
  playhead 1.7 s off the view's end after the edge auto-scroll) and passed in the next full run and alone
  three times: its fixed sleeps around the auto-scroll are timing-sensitive.

- `packages/desktop/__tests__/app.test.ts` fails on this Mac with or without these changes (an installed Beacon
  was running); not looked into.
- Transcribing a 10½-minute take takes about 75 s with Whisper on this Mac: one encoder pass per short chunk
  (PLAN, Phase 7 progress). Ideas: transcribe while recording; Whisper's encoder on the Neural Engine.
