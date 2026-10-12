# Beacon

Beacon by Orva: a macOS screen-recording editor on its own project format and
renderer, built so every edit can be automated.

- **Editor:** an Electrobun desktop app (Bun main process, React UI in
  WKWebView): timeline, canvas, properties panel and keymap.
- **Renderer:** a Rust/wgpu compositor; the preview and the export draw the
  same frames.
- **Automation:** every edit is a command, and an MCP server exposes each one
  as a tool. An agent can edit a project headlessly, or the one open in the app,
  live, sharing its undo history.
- **Imports:** reads `.trec` screen recordings and imports Camtasia `.cmproj`
  projects (read only; nothing is written back).

Personal project: macOS 26+ on Apple silicon only.

## Requirements
- [Bun](https://bun.sh) 1.4
- Rust via rustup (the toolchain is pinned in `packages/engine/rust-toolchain.toml`)
- ffmpeg (`brew install ffmpeg`)
- For transcripts: whisper.cpp (`brew install whisper-cpp`) and
  `ggml-large-v3-turbo-q5_0.bin` from
  [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)
  in `~/Library/Caches/Beacon/models/` (or set `BEACON_WHISPER_MODEL`)

## Getting started
```sh
bun install
bun run build        # the Rust engine; needed before anything reads media
bun run app          # build and open the editor
```
`BEACON_PROJECT=path/to/x.beproj bun run app` opens a project, and
`BEACON_BACKGROUND=1` starts the app without taking focus.

## Driving it with an agent
`.mcp.json` runs the MCP server from source, so Claude Code in this repo has
the `beacon` tools. To use it elsewhere, run `bun run mcp`, or
`bun run build:mcp` for a standalone `dist/beacon-mcp`. If the app has the
project open, `project_open` connects to it and the edits show on its timeline.
The server's built-in instructions are in `skills/SKILL.md`.

## Commands
| | |
|-|-|
| `bun run test` | Bun and cargo tests (the app test launches the app) |
| `bun run typecheck` | TypeScript across the workspace |
| `bun run audit` | `bun audit` and `cargo deny` |
| `bun run render-cmproj <project.cmproj> <out.mp4>` | Headless render of a `.cmproj` project |
| `bun run dump-trec [root]` | Read every `.trec` under a folder |

`scripts/ui-harness/` serves the editor UI to headless Chromium against a real
core, for clicking, dragging and screenshotting without a window.

## Releasing
`bun run release 0.2.0` on a clean, up-to-date `main` sets the version in
every `package.json` (the app takes the root's), commits
`chore(release): v0.2.0`, tags `v0.2.0` and pushes, as hance does. The app is
built by hand from the tag.

## Layout
`packages/` holds the TypeScript workspaces (`model`, `features`, `core`,
`render`, `media`, `camtasia`, `mcp`, `ui`, `desktop`) and the Rust engine
(`engine`). Features are folders that register with the core; the core never
names a feature.

- [`PLAN.md`](PLAN.md): scope, architecture, phases and status
- [`ARCHITECTURE.md`](ARCHITECTURE.md): what exists today
- [`docs/formats/`](docs/formats): file formats Beacon reads
