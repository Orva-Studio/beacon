# Beacon
Beacon (by Orva): a macOS screen-recording editor on its own project format, with a Rust/wgpu renderer and MCP automation. `PLAN.md` is the source of truth for scope, architecture, phases and working rules; read it first.

## Stack
- Bun workspaces (`packages/*`, consumed as TypeScript source, no per-package build), TypeScript 7, Zod 4, Immer
- Rust engine: Cargo workspace in `packages/engine` (`beacon-media`, `beacon-decode` over FFmpeg's libraries, `beacon-ffi` cdylib loaded with `bun:ffi`), toolchain pinned in `rust-toolchain.toml`
- Beacon's own LGPL FFmpeg (ffmpeg, ffprobe, libraries) and whisper-cli, built from pinned sources by `scripts/build-tools.ts` into `packages/engine/third-party/out` (needs pkg-config and cmake; it uses `nix shell` when they're missing). Nothing runs tools from PATH: `tool()` in `packages/media/src/tool.ts` and `beacon_decode::tool` resolve them
- App: Electrobun 2.0.2 (Bun main process) in `packages/desktop`, React 19 + Tailwind 4 UI in `packages/ui`; Electrobun's SDK comes from its Hutch toolchain into `packages/desktop/.hutch/devkit` (`electrobun prepare`), not from npm

## Commands
- `bun run build` - build Beacon's tools (once, ~1 min) and the Rust engine (needed before anything that reads media)
- `bun scripts/bundle-tools.ts` - stage the app's `engine` folder (engine, tools, FFmpeg libraries via @rpath); `dev` and `build` in `packages/desktop` run it
- `bun run app` - build the engine and run the editor (`BEACON_PROJECT=<x.beproj>` opens a project; `BEACON_BACKGROUND=1` opens without taking focus)
- `bun run test` - bun tests + cargo tests (the app test builds and launches the app in the background)
- `bun run test:ui` - the editor's flows in headless Chromium (`scripts/ui-harness/editor.test.ts`, no window); part of `bun run test`. Add a flow there when a UI feature lands
- `bun run typecheck`, `bun run audit` (bun audit + cargo deny)
- `bun run dump-trec [root] [--out dir]` - read every `.trec` under `root` (default `~/client-videos`); the Phase 1 gate
- `bun run render-cmproj <project.cmproj> <out.mp4 | dir/> [--from s] [--to s] [--frames a,b]` - headless render of a `.cmproj` project
- `bun scripts/perf.ts <project> [--size WxH]` - times the preview offscreen on a copy (jumps, settles, scrubbing, play); `docs/performance.md`
- `BEACON_PROFILE=1` prints the worker's per-stage times, and each file drop's steps (`[drop]`, printed anyway when a drop takes over a second)
- `scripts/ui-harness/` - the editor UI served to headless Chromium, backed by a `LocalCore`: `serveUi(project)` then `openPage(url)` to click, drag, type and screenshot with no window (use it instead of the app during working hours)

## Rules
- Never modify anything under `~/client-videos` or a user's `.cmproj`; work on copies.
- The user's shell exports `RUSTUP_TOOLCHAIN`; root scripts unset it so the repo's pinned toolchain is used. Do the same when calling cargo directly.
- All document changes go through commands (`ProjectStore`); features are folders that register with the `FeatureRegistry`, and core never names a feature.
- `.trec` parsing is strict: unknown layouts are errors. Findings go in `docs/formats/trec.md`.
- Features never edit core: extend the contract in `packages/model/src/feature.ts` if a feature needs something new.
- Tests: few, on real data (PLAN §12), read from `BEACON_FIXTURES` (default `~/beacon-fixtures`, links to the user's media); never name client files in the repo. Unit tests only for undo exactness, migrations, ticks maths.
- Exact pinned versions; commit `bun.lock` and `Cargo.lock`.
- Conventional Commits; work on a branch, not `main`.
- `docs/tested.md` records what was checked by hand and what only headless, with dates and commits: add a feature there when it lands, move it when the user confirms it, and ask the user to check only what isn't checked by hand.
