# Beacon

Beacon edits screen recordings (tracks, clips, animation blocks, effects) on
its own project format, and renders them with its own engine. Everything is a command or a query; this
server exposes each as a tool. No app needs to be open, but if the Beacon
app has the project open, `project_open` connects to it: your edits appear on
its timeline live and share its undo history with the user.

## Basics
- **One project per session.** `project_create` (new `.beproj` folder, optionally
  from a Camtasia `.cmproj`) or `project_open` first. Every change is saved
  as it is made.
- **Times are timeline seconds**, snapped to frames. Source positions
  (`mediaStart`) are seconds into the media file.
- **Read before you edit:** `project_describe` (plain text), `timeline_clips`,
  `transcript_get`. Ids come from these; never guess them.
- **Never modify the user's source files or `.cmproj` projects.** Media is read
  in place; projects are new `.beproj` folders.

## Media
`media_import` adds files at the end of the timeline (or at `at`). A Camtasia
recording (`.trec`) becomes clips on separate tracks: "Screen" (with
its recorded cursor), "Camera" and "Audio", each fitted to the canvas. The camera and audio are linked
(the screen and audio, when there is no camera); the screen and camera are separate. Linked clips are cut, moved and trimmed together;
`clip_unlink` separates them. The camera covers the screen until you lay it
out (`clip_set` transform/crop, or `track_set` hidden): see the
`beacon://docs/house-style` resource.

Importing speech starts a background transcript job (seconds per minute of
audio). `job_status` with `wait` blocks until it is done. Who transcribes is
the user's choice (`preference_list`, id `transcriber`): Whisper on this Mac
(the default), Apple's on-device transcriber (no download, faster, weaker on
technical words and exact word times), or Whisper through OpenAI's API (the
audio is uploaded, with the user's own key). `preference_set` changes it; media
without a transcript by the new choice is transcribed again. Only change it
when the user asks.
Whisper on this Mac needs its speech model, which isn't part of Beacon: until
it is downloaded, imports report it in `needs` and no transcript starts.
`resource_list` says whether it is there; `resource_fetch` downloads it (about
575 MB, once) as a job. Ask the user before fetching; transcripts of media
already imported start when it is done.

The Favorites panel is the user's, app-wide: `favorites_list` reads it
(`annotation:<preset>`, `effect:<id>`, `audio:fade-in` / `audio:fade-out`);
`favorites_add`, `favorites_remove` and `favorites_move` change it, only when
the user asks.

## Recording
`recorder_start` records a take into the project's `recordings` folder: the
screen (without its cursor; Beacon draws its own), the system audio, a camera
and a microphone, each optional (`recorder_devices` lists them with their ids
and permissions; `recorder_access` asks the user's permission for the camera or
microphone). `recorder_stop` ends it and imports it as a `.trec` is imported, at
the end of the timeline or at `at`. Only record when the user asks: it captures
their screen, camera and microphone.

Voice narration: `recorder_start` with only a `microphone` and `narrate` (the
project open in the app). The app plays the timeline from the playhead, or
through the in/out range, silently unless `hear` (only with headphones), while
the user speaks over it; with nothing after the playhead, it records there. `recorder_stop`, a pause or the end of the range ends
it; the take goes on a new Narration track where it began, lined up with what
played, and is transcribed. `recorder_status`'s `last` says what a narration
that ended by itself imported; `recorder_stop` with `discard` throws a take away.

## Editing
- `timeline_rippleDelete` removes time ranges from every track at once and
  closes the gaps; all ranges in one call are read against the timeline as it
  was before the call. Prefer one call with every cut over many calls.
- `transcript_cut` removes words by index; `transcript_removePauses` shortens
  silences. Word indices change after every edit: re-read `transcript_get`.
- Remove Silences, as the editor's AI panel does it: `transcript_silences`
  shows each silence, whether it is screen action (the recording's cursor
  moving or clicking) and whether it is cut. With the user in the app,
  prepare it for them to look over rather than cutting: `silences_review`
  (settings), `silences_flip` the ones you judge differently (after looking at
  frames), then tell them it is marked on the timeline for Apply; or
  `silences_apply` when they say so.
- `zoom_to` zooms a clip into a region of its content (pixels of the
  recording, top-left origin) and optionally back out (`until`).
- `clip_move` moves several clips as a block (`by` seconds, `tracks` up or
  down); it is refused over other media or on locked tracks. `clip_trim`
  edges stop at the media's ends; `ripple` on either keeps later clips
  butted up. `clip_extendFrame` holds a video's last frame after it.
- `timeline_deleteRanges` removes time and leaves gaps;
  `timeline_insertSpace` opens a gap on every track.
- `edit_*` tools do what the editing keys do, on the editor's
  selection, in/out range and playhead (`selection_set`, `range_set`,
  `playhead_set` first): `edit_rippleDelete`, `edit_cut`, `edit_copy`,
  `edit_paste`, `edit_split`, `edit_duplicate`, ... Ripple-deleting clips on
  several tracks moves the later clips on each of those tracks left by the
  same amount, so they stay in sync.
- `transaction` runs several commands as one undo step, all or nothing.
- Every command tool takes `dryRun: true` to see the change without applying
  it, and `project_undo` / `project_redo` step through history.

## The editor
The editor's state is driven and read with commands too, with or without the
app: `playhead_set` / `playhead_step` / `playhead_jump`, `selection_set` /
`selection_step`, `range_set`, `timeline_zoom` / `timeline_view`,
`panel_show`, `inspector_tab`, `canvas_zoom`; `playback_play` and
`playback_pause` need the app. `ui_state` reads it all; `ui_snapshot` adds a
screenshot of the app window (with the canvas at the playhead drawn in) and
what the window reports it has drawn. These don't change the project and
aren't undone.

## Look at the result
Judge edits by looking, not by numbers alone:
- `frame_at` renders the canvas at a time (default 960 px wide).
- `frames_sheet` renders a grid of frames across a range: use it to check a
  whole cut or the pacing of a zoom.
- `frame_capture` is Snapshot: the frame at the playhead saved
  into the project's media folder and added to the Media Bin.
Work in a loop: act (with `dryRun` when unsure) → render frames → compare
with the intent → fix → repeat.

## Export
`export_start` renders in the background (H.264 by default, about real time
for 4K sources); poll `job_status` with `wait`. Exports go wherever the user
asks; default to `~/Movies/Beacon/<name>.mp4`.

## Workflows
`rough-cut`, `zoom-pass`, `review` and `export` walk through the common
jobs: read them as resources (`beacon://workflows/<name>`) or, as a user,
run them as prompts. The command reference is the
`beacon://reference/commands` resource.
