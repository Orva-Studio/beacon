---
description: Add zooms on the screen recording where the viewer needs to see detail
args:
  clip: Optional screen clip id; default every screen clip
---
# Zoom pass

Zoom in where the viewer needs to read something small (code, a form, an
error message) and out again when the attention moves on. Fewer, longer zooms
beat many short ones.

1. `project_describe` and `transcript_get`: find the moments the narration
   points at something ("this message", "here", "if I change this").
2. For each, `frame_at` at that time (full canvas). Work out the region of
   the **recording** to show, in recording pixels (top-left origin): screen
   clips report their size in `timeline_clips` props / the asset's media
   info; the frame shows where things are. Keep the region at the canvas
   aspect (16:9) and large enough to stay sharp (at most about 2.5× the
   fitted scale).
3. `zoom_to` with `at` a little before the narration reaches it, and `until`
   when it moves on (defaults: 0.4 s linear blocks, as in the user's
   projects). Several zooms: one `transaction`.
4. Check each with `frames_sheet` from `at - 0.5` to `until + 1` (8 frames):
   the target must be in frame and readable at the held zoom, and the move in
   and out must not cut off the cursor's action.
