# Dependencies: versions and security

Checked 2026-10-06 against npm, crates.io, the Rust release channel and the
OSV vulnerability database (includes RustSec and GitHub advisories).

## Use the latest releases

| Dependency | Latest | Spikes used | Notes |
|---|---|---|---|
| Electrobun | **2.0.2** | 1.18.1 (same as hance) | 2.x has no npm dependencies (1.18.1 pulls `proxy-agent` → `basic-ftp` with a high-severity advisory). New APIs: `electrobun/main`, Rust main process, Rust SDK for GPU views. |
| wgpu (Rust) | **30.0.1** | 24.0.5 (same as hance) | 30 uses `objc2-metal`; 24 pulls the unmaintained `paste` crate via `metal`. API changes between 24 and 30 to absorb. |
| Bun | **1.4.2** | 1.4.0 installed | |
| Rust | **1.99.0** | 1.97.1 installed | `rustup update` |
| ffmpeg | **9.0.2** (Homebrew stable) | 7.1.3 installed | Spikes ran on 7.1.3; re-check `tscc2` decoding on 9.x before relying on it. |
| TypeScript | 7.0.2 | — | |
| React / React DOM | 19.3.0 | — | |
| Tailwind CSS | 4.3.3 | — | |
| @modelcontextprotocol/sdk | 1.32.1 | — | MCP server (Phase 3) |
| zod | 4.6.5 | — | schemas for commands/MCP tools |
| Phosphor Icons | 2.1.1 (`@phosphor-icons/core`) | — | The UI's icons from Phase 5.5, MIT: only the paths used, regular and fill, copied into `ui/src/controls/icon-paths.ts` by `scripts/icons.ts`; drawn by `Icon` (React) and `drawIcon` (the timeline's canvas) |
| Geist (font) | 5.3.0 (`@fontsource-variable/geist`) | — | The UI's typeface (2026-10-13, replacing Phase 5.5's Space Grotesk): the Latin variable woff2 inlined in `ui/src/fonts/fonts.css`, SIL OFL 1.1 (`ui/src/fonts/OFL.txt`) |
| pollster / bytemuck / serde / serde_json | 1.0.1 / 1.25.2 / 1.0.229 / 1.0.151 | 0.4 / 1.x / — | |
| ffmpeg-next / ffmpeg-sidecar | 9.0.0 / 2.6.0 | — | candidates for `beacon-media` (in-process libav vs. ffmpeg binary) |
| whisper-rs | 0.16.0 | — | candidate for local transcription |
| objc2-vision | 0.3.2 | — | Remove Background's person matte (`beacon-render/src/matte.rs`): Apple's Vision, same objc2 0.3.2 family as the other framework crates (MIT/Apache-2.0/Zlib). Added 2026-10-20 |
| GSAP | 3.15.0 (npm `gsap`) | — | Motion graphics' animation library (2026-10-26): `dist/gsap.min.js` copied unmodified to `features/src/motion/vendor/` and inlined into a composition's page when it uses `gsap`. Standard "No Charge" GSAP License (not open source): free commercial use; prohibits use in no-code visual animation builders competing with Webflow; its FAQ says AI-generated GSAP code is not a prohibited use |

## Advisories found in the spikes (176 package versions scanned)

| Id | Severity | Package | Path | Resolution |
|---|---|---|---|---|
| GHSA-c475-qrg2-pj4r | High | `basic-ftp` 5.3.1 (CPU DoS in directory-list parsing) | Electrobun 1.18.1 → `proxy-agent` → `get-uri` | Electrobun 2.x |
| RUSTSEC-2024-0436 | Informational (unmaintained) | `paste` 1.0.15 | wgpu 24 → `wgpu-hal` → `metal` | wgpu 30 |

Both are in build tooling or spike code, not in anything shipped. **hance
has the same two** (it pins Electrobun `^1.18.1` and wgpu 24), so the shared
`orva-kit` work is a good moment to upgrade hance too.

## Policy for the real repo
- Pin exact versions (`bun.lock`, `Cargo.lock` committed); upgrade on
  purpose, not by range drift.
- CI runs `bun audit`, `cargo deny check` (advisories, licences, bans) and an
  OSV scan of both lockfiles on every PR and weekly.
- Dependabot or Renovate opens grouped upgrade PRs; the render parity and
  agent tests gate them.
- Native tools the app calls (ffmpeg, whisper) are bundled at a known version
  inside the `.app`, not taken from the user's PATH, so a Homebrew upgrade
  can't change behaviour.
- Re-run `bun run dump-trec` after every new `.trec` recorder version and the S3
  decode check after every ffmpeg upgrade.

## Toolchain (updated 2026-10-06, Phase 1)
- Bun upgraded to 1.4.2 (`bun upgrade`).
- Rust 1.99.0 installed with rustup and pinned for the engine in
  `packages/engine/rust-toolchain.toml`. The global default stays 1.97.1, and
  the shell profile exports `RUSTUP_TOOLCHAIN=1.97.1`, which overrides the
  pin; the root scripts run cargo with `env -u RUSTUP_TOOLCHAIN`.
- `cargo-deny` installed; `bun run audit` is clean (no advisories, licences
  MIT, Apache-2.0, Unicode-3.0, ISC, Zlib and BSD only).
- Homebrew ffmpeg left at 7.1.3; Phase 1 doesn't decode. Re-check `tscc2` on
  9.x before Phase 2 relies on it.

## Phase 4 (2026-10-08)
- **Electrobun 2.0.2** (latest stable; 2.0.3 is in beta). 2.x is no longer
  an npm runtime: the `electrobun` npm package is a bootstrap that
  downloads the **Hutch** toolchain (0.27.1) from Electrobun's GitHub
  releases, checks its SHA-256 against the release index, and caches it in
  `~/.hutch`. `electrobun prepare` projects the SDK (the `electrobun/main`
  and `electrobun/view` sources) into `packages/desktop/.hutch/devkit`,
  which `tsconfig.json` maps. Those downloads are pinned by the npm
  version but not covered by `bun.lock`. The main process is **Bun**
  (`build.mainProcess: "bun"`; Electrobun 2.0.2 ships Bun 1.4.0), not the
  default Cottontail, because the engine loads through `bun:ffi`.
  `hutch electrobun init` fails on this machine (it refuses to adopt the
  `~/.hutch` the npm bootstrap creates); the project was written by hand
  and only `prepare`/`build`/`dev` are used.
- **React 19.3.0, Tailwind CSS 4.3.3** (`@tailwindcss/cli`) for the UI.
- **cpal 0.18.2** (Apache-2.0) for playback audio in `beacon-ffi`.
- **objc2 0.6.5** (MIT, already in the tree through wgpu) in `beacon-render`,
  to read the preview layer's bounds and flush Core Animation.
- Proxies are encoded with ffmpeg's `h264_videotoolbox`.

## Phase 6 spike (2026-10-13)
- **`beacon-record`** (the recording sidecar, `beacon-recorder`): objc2 0.6.5,
  block2 0.6.2, dispatch2 0.3.1, and the generated framework crates at
  **0.3.2** (`objc2-foundation`, `-core-foundation`, `-core-media`,
  `-core-video`, `-screen-capture-kit`, `-av-foundation` with its
  `objc2-core-media` feature), and the workspace's serde. MIT / Zlib /
  Apache-2.0; `cargo deny` passes.

## Beacon's own tools (Phase 6.5, 2026-10-15)
The app runs only its own builds, made by `scripts/build-tools.ts` from pinned,
hash-checked sources into `packages/engine/third-party/out` and staged into
the app by `scripts/bundle-tools.ts` (FFmpeg libraries found through
`@rpath`, so the app works on a Mac with no Homebrew or FFmpeg).

| Tool | Version | Licence | Source check |
|---|---|---|---|
| FFmpeg (ffmpeg, ffprobe, libav*, libsw*) | 7.1.3 | LGPL 2.1+ (no GPL, version3 or non-free parts; the script refuses another licence) | release tarball, signed by FFmpeg's release key FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8 |
| libvpx (VP9 encoding for WebM, static) | 1.15.2 | BSD 3-Clause | GitHub tag archive, hash pinned as fetched |
| Opus (WebM audio, static) | 1.5.2 | BSD 3-Clause | Xiph's SHA256SUMS |
| LAME (MP3 for audio-only export, static) | 3.100 | LGPL 2+ (its source goes with FFmpeg's in a release) | SourceForge tarball, the hash Homebrew and Debian pin |
| whisper.cpp (whisper-cli, Metal, static) | 1.9.2 | MIT | GitHub tag archive, hash pinned as fetched |

FFmpeg is configured with `--disable-everything` and only the protocols,
formats, codecs and filters Beacon uses (the list is in the script). H.264,
HEVC and ProRes encode through VideoToolbox; there is no x264. One line is
added to its configure script: 7.1.3 forgets that the `metadata` filter
needs libavformat. FFmpeg 9.x is out; 7.1.3 is the version `tscc2` decoding
and the decoder parity tests were checked on.
