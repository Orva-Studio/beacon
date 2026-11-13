# Beacon

Beacon edits screen recordings (tracks, clips, effects, animations) on its own
`.beproj` project format. Every command and query is a tool. If the Beacon app
has the project open, `project_open` connects to it: edits show there live and
share its undo history with the user.

## Start
- `project_open` (no path: the project in the app's front window) or
  `project_create` (optionally from a Camtasia `.cmproj`, read only). Changes
  save as made. `project_open` also gives the summary and the user's memory.
- Read before editing: `project_describe`, then `timeline_clips` filtered by
  `from`/`to`, `track` or `type` (`detail` for one clip's props), and
  `transcript_get` (`from`/`to`, `find` a phrase). Ids come from these.
- Follow the user's memory (`project_open` lists it; `memory_list` for more).
- Times are timeline seconds, snapped to frames; `mediaStart` is seconds into
  the media file.

## Edit
- Fewest calls: `transaction` runs several commands and actions as one undo
  step, all or nothing; `script` runs JavaScript (`beacon.query`/`beacon.run`)
  for loops and maths over many clips or words, also one undo step. Prefer
  either to many single calls, and to working things out in a shell.
- Do the work in Beacon: when a tool exists, use it rather than files or
  scripts outside. Outside work the user can't see: say it with `status`.
- Every command takes `dryRun: true`; `project_undo` undoes only your own change.
- `timeline_rippleDelete` cuts time ranges from every track and closes the
  gaps, all ranges in one call; `transcript_cut` removes words by index
  (re-read `transcript_get` after any edit: indices change).
- Linked clips (a recording's camera and audio) move, cut and trim together.
- Selection-based editor keys (`edit_*` in the app) aren't tools: call the
  command they run (`clip_split`, `clip_remove`, `marker_add`…).

## Look
Judge by looking: `frame_at` renders a frame, `frames_sheet` a grid across a
range. Act, look, fix.

## Ask the user first
Recording (`recorder_start`), downloads (`resource_fetch`), anything that
spends their money (B-roll, music, OpenAI) and changing their settings,
preferences or shortcuts. Never modify their source media or `.cmproj`.

## Background jobs
Imports start transcripts; exports and analyses run as jobs: `job_status`
with `wait` blocks until one ends.

## More
Resources: `beacon://docs/guide` (the full guide: sections, media, recording,
reviews, B-roll, captions, export), `beacon://docs/house-style` (layout),
`beacon://reference/commands` (every command's arguments), and workflows
`beacon://workflows/rough-cut`, `zoom-pass`, `review`, `export`.
