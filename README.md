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

## Install
Download `beacon-macos-arm64.dmg` from the
[latest release](https://github.com/Orva-Studio/beacon/releases/latest), open
it and drag Beacon to Applications. It carries everything it needs (its own
FFmpeg and whisper-cli); the speech model for transcripts is downloaded the
first time you ask for one. Beacon isn't signed with a Developer ID yet, so
macOS refuses to open it until its quarantine flag is cleared (step 3 below),
and it asks again for screen recording, camera and microphone permission after
each update.

Or paste this into an AI agent such as Claude Code:

```text
Install Beacon, a macOS screen-recording editor, on this Mac (Apple silicon):
1. Download beacon-macos-arm64.dmg and checksums.txt from the latest release of
   github.com/Orva-Studio/beacon (`gh release download --repo Orva-Studio/beacon
   --pattern beacon-macos-arm64.dmg --pattern checksums.txt`), and check it:
   `grep beacon-macos-arm64.dmg checksums.txt | shasum -a 256 -c`.
2. Quit Beacon if it is running. Mount the DMG (`hdiutil attach -nobrowse`), copy
   Beacon.app to /Applications (replacing an older one), and detach it.
3. Beacon isn't signed with a Developer ID yet, so clear the quarantine flag:
   `xattr -dr com.apple.quarantine /Applications/Beacon.app`.
4. Open it once: `open /Applications/Beacon.app`. Its first launch unpacks the
   app in place; wait until
   /Applications/Beacon.app/Contents/Resources/app/engine/beacon-mcp exists,
   then quit it: `osascript -e 'quit app "Beacon"'`.
5. Add its MCP server (replacing an existing `beacon` one):
   `claude mcp add -s user beacon -- /Applications/Beacon.app/Contents/Resources/app/engine/beacon-mcp`.
Then tell me two things: Beacon's tools appear in Claude Code sessions started
from now on (not this one), and until Beacon is signed, macOS asks again for
screen recording, camera and microphone permission after each update.
```

Each AI tool starts its own `beacon-mcp` when a session begins; the app
needn't be running. To use Beacon from another MCP client (Claude Desktop,
Cursor…), point its MCP config at the same
`/Applications/Beacon.app/Contents/Resources/app/engine/beacon-mcp`. With the
app open on a project, `project_open` connects to it: the agent's edits show
on its timeline, sharing your undo history.

## Requirements (to build it)
- [Bun](https://bun.sh) 1.4
- Rust via rustup (the toolchain is pinned in `packages/engine/rust-toolchain.toml`)
- pkg-config and cmake: `bun run build` builds Beacon's own FFmpeg and
  whisper-cli from pinned sources (it uses `nix shell` when they're missing)

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
`bun run build:mcp` for a standalone `dist/beacon-mcp` (with the engine and
Beacon's tools beside it, as in the app). If the app has the
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

Tests on real media read it from `BEACON_FIXTURES` (default `~/beacon-fixtures`):
`project.cmproj`, `small.cmproj`, `recording.trec`, `recording-2.trec`,
`video.mp4`, `video-2.mp4`, `video-3.mp4`, `audio.m4a`, `image.png` and
`take.brec` (a take from `beacon-recorder`). A test
whose file is missing is skipped.

`scripts/ui-harness/` serves the editor UI to headless Chromium against a real
core, for clicking, dragging and screenshotting without a window.

## Releasing
`bun run release 0.2.0` on a clean, up-to-date `main` sets the version in
every `package.json` (the app takes the root's), commits
`chore(release): v0.2.0`, tags `v0.2.0` and pushes, as hance does. The tag
runs `.github/workflows/release.yml`, which builds the app, checks the DMG and
publishes `beacon-macos-arm64.dmg`, `checksums.txt` and FFmpeg's source,
configure patch and options as a GitHub release. Locally,
`bun run --cwd packages/desktop package` builds the DMG into
`packages/desktop/artifacts`, and `bun scripts/check-release.ts <dmg>` checks it
as a Mac without Homebrew would see it: both apps signed (ad hoc until there is
a Developer ID), nothing linked from outside the app, and the app's own
`beacon-mcp` exporting MP4 and GIF with nothing on PATH.

## Layout
`packages/` holds the TypeScript workspaces (`model`, `features`, `core`,
`render`, `media`, `camtasia`, `mcp`, `ui`, `desktop`) and the Rust engine
(`engine`). Features are folders that register with the core; the core never
names a feature.

- [`PLAN.md`](PLAN.md): scope, architecture, phases and status
- [`ARCHITECTURE.md`](ARCHITECTURE.md): what exists today
- [`docs/formats/`](docs/formats): file formats Beacon reads

## Contributing
Beacon takes issues, not pull requests: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License
[FSL-1.1-ALv2](LICENSE): free to use, modify and redistribute, but not to
build a competing product or service. Each version becomes Apache 2.0 two
years after it is released. Third-party notices are in
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).
