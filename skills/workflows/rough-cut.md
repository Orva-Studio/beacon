---
description: Rough-cut a raw recording from its transcript - remove retakes, false starts and dead air
args:
  recording: The .trec (or other media) to cut
  project: Where to create the .beproj project
---
# Rough cut from the transcript

Goal: a tight, watchable first cut of `{{recording}}` in a new project at
`{{project}}`, keeping the best take of everything said and nothing else.

1. `project_create` at `{{project}}`, then `media_import` the recording.
   `job_status` with `wait` until its transcript job is done.
2. Read `transcript_get` (text). Lines are `[first-last] start-end words`.
   Retakes look like repeated phrases, often ending in `...` (an abandoned
   take). The **last** complete take of a sentence is usually the good one.
   A retake can also be **reworded**: two neighbouring lines that say the
   same thing in different words ("how it handles errors" / "when it comes
   to handling errors") are one idea said twice. Keep the one that leads
   into what follows and cut the other. Read the kept transcript as a
   viewer would: no idea should be said twice in a row.
   Also cut false starts, filler-only lines, and talk to yourself before or
   after the real content ("ok", "let me try that again").
   `transcript_retakes` lists the lines said more than once that it finds
   (word for word, a restart or a line said again): a start, not the whole
   list; reworded retakes are yours to find.
3. Cut all the bad takes in **one** `transcript_cut` call (indices refer to
   the transcript you just read). Re-read `transcript_get` and check every
   sentence now reads once, in order, with nothing missing.
4. `transcript_removePauses` (default: pauses over 0.6 s down to 0.3 s).
   Silence can be on-screen action (typing, waiting for a page to load):
   before removing pauses, look at long ones (`transcript_pauses` with
   `min: 1.5`) with `frames_sheet` over each, and pass the ones showing
   meaningful action in `except`.
5. Prefer `transcript_cut` and `transcript_removePauses` over
   `timeline_rippleDelete`: they cut in silence. If you cut by hand,
   `transcript_joins` with `chopped: true` must come back empty: a chopped
   join is a word cut off, which plays as an audible skip. Fix it with
   `project_undo` and a range that ends in silence (`transcript_pauses`).
6. Review: `transcript_get` once more, and a `frames_sheet` over the whole
   timeline (16-24 frames). Look for cuts that land mid-word (a word missing
   or doubled in the transcript) and fix with `project_undo` or a smaller cut.
7. Report what you cut (each retake, in a sentence) and the before/after
   length.
