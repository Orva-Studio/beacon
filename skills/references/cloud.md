# Beacon away from a Mac

`beacon` runs on Linux (a cloud agent's machine) as the same MCP server the app ships, so the tools are the
ones used with the app. What it can't do there is anything that needs Beacon's engine, which runs only in the
Beacon app on a Mac.

## Works
- `project_create` (with `standalone: true`, so imported media is copied into the project's `media` folder
  and the project moves to a Mac whole), `project_open`, `project_describe`, `project_save`.
- `media_import`: measured with the machine's ffprobe (from PATH, or `BEACON_TOOLS_DIR`).
- Editing: `transaction`, `script`, `timeline_rippleDelete`, clips, tracks, sections, comments, effects and
  animations by their parameters, `project_undo`.

## Needs the Beacon app on a Mac
- Looking: `frame_at`, `frames_sheet` (judge by `project_describe` and `timeline_clips` instead).
- Exports, transcripts (so `transcript_*`, captions and Remove Silences have nothing to read), motion
  graphics, text measured to fit, and anything else that draws. These fail saying so; leave them for the app.

## Hand-over
Give the user the `.beproj` folder. Media outside it is stored by absolute path and won't be found on their
Mac: import with `standalone: true`, or put the files in the project's `media` folder before importing them.
`beacon validate <dir>` checks a project before it is handed over. Media a project lists but never measured
is measured when Beacon opens it.
