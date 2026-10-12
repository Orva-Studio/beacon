---
description: Export the project to a video file
args:
  output: Path of the .mp4 to write (default ~/Movies/Beacon/<project>.mp4)
---
# Export

1. `project_describe`: confirm the canvas (usually 1920x1080 @ 30) and length.
2. `export_start` with `output` `{{output}}` (H.264; `codec: "prores"` for an
   intermediate). Then `job_status` with `wait: 50` until it is done.
3. Check the file: `frames_sheet` already showed the edit; report the path,
   length and size.
