# Security

What an attacker could reach, what Beacon does about it, and the risks accepted for now. From the Phase 14 audit
(2026-11-05, PLAN §13 Phase 14); update it when one of these changes.

## Fixed

| Area | What could happen | What Beacon does now |
|---|---|---|
| Updates | The app is unsigned and Electrobun's update `hash` is a build tag, not a check of the download: whoever could publish a release could ship code to every copy | Each release carries `stable-macos-arm64-update.sig.json`, an Ed25519 signature (CI, secret `BEACON_UPDATE_KEY`) over the version, the build hash and the SHA-256 of the app's tar. The app checks it with the public key it holds before downloading, and hashes the tar it is about to swap in, deleting it on a mismatch (`packages/desktop/src/bun/update-signature.ts`) |
| The window | No Content Security Policy: an injection would get the window's RPC (commands, export, recording, files) | A strict CSP: only Beacon's own script, connecting only to itself and Electrobun's loopback socket (`packages/ui/src/index.html`) |
| Motion graphics | A page (written by AI, or by hand) ran in a frame that could fetch anywhere, sending what's in it | It runs in `motion-frame.html` under its own policy: inline script and style, nothing loaded or sent |
| `showFile` | Page script could have `open` start any app or script | Only an existing export (a video, sound, picture or captions file) opens, with `--` before the path |
| The app's socket | Any process running as the user could drive the app | A per-launch token, in a file only the user can read, is asked for in `hello`; nothing (not even app events) is sent before it |
| Recording | An agent could record the screen, camera and microphone with no one knowing | An agent's recording asks in the app (Record / Don't Record); with no app open, an agent can't record |
| Paths | A take's name (`../x`), a link on an export's path, a feature task's file, or Save As following a project's links could write or copy outside where they should | Take names are files in the recordings folder; exports are checked with links followed; task files go in the media folder or a temporary one; Save As follows links only to the project's own files and its media |
| FFmpeg | A few features ran ffmpeg/ffprobe without the local-files-only guard | Every call opens its inputs with `-protocol_whitelist file` (`ffmpegInput`) |
| Camtasia projects | `project.tscproj` read whole, whatever its size | Over 200 MB, or not a Camtasia project, it is refused |
| Dependencies | Nothing checked advisories in CI | CI runs `bun run audit` (bun audit and cargo deny); `qs` pinned past an advisory |

## Accepted for now

- **The app isn't signed or notarized by Apple** (no Developer ID yet): macOS warns on first open and asks for screen,
  camera and microphone permission again after each update. Updates are signed by Beacon itself (above). The release
  is ready for one: see "Developer ID" below.
- **Keychain items** are written with `/usr/bin/security`, which puts that tool on each item's access list: any
  process running as the user can read the API keys with it, without a prompt. Signed, Beacon can store them through
  the Security framework with an access list naming only itself.
- **The socket's token** is in a file the user can read, so code already running as the user can still connect; it
  keeps out what can reach the socket but not the user's files.
- **`BEACON_*_URL` overrides** (tests' stand-ins for OpenAI, Replicate, Auphonic, Epidemic, Firecrawl, Anthropic) are
  honoured in release builds: setting them needs the app's environment, which only code already running as the user
  can set.
- **The motion web fetch** checks each address and every redirect is on the public internet, but resolves the name
  separately from the connection, so DNS rebinding could slip past it.
- **FFmpeg's demuxers** aren't limited to what Beacon reads (only its protocols are): a crafted media file reaches
  every demuxer FFmpeg is built with.
- **Camtasia projects** may name media anywhere on disk, as Camtasia's own do: importing one reads and probes those
  files.

## Developer ID

Signing and notarizing wait only on the certificate. `packages/desktop/sign.ts` signs each app inside out (libraries,
then helpers, then the bundle; no `--deep`): ad hoc, as now, or, when `BEACON_SIGN_IDENTITY` names a Developer ID,
with it, a secure timestamp and the hardened runtime, each binary with only the entitlements it needs:

| Binary | Entitlements |
|---|---|
| `bun` (the main process) | JIT (`allow-jit`, `allow-unsigned-executable-memory`), camera, microphone |
| `beacon-mcp` | JIT |
| `launcher`, `beacon-recorder` | camera, microphone |
| everything else | none |

`BEACON_HARDENED=1` turns the hardened runtime on for an ad hoc build (adding `disable-library-validation`, as ad hoc
code has no Team ID), to try the app under it without the certificate. `scripts/check-release.ts` checks every binary
has the runtime and its entitlements whenever either is set.

The release workflow imports the certificate into a keychain of the run's own, signs with it, then
`scripts/notarize.ts` signs the DMG, submits it to Apple (`notarytool`, waiting), staples the ticket and checks it with
Gatekeeper. Without the secrets every step falls back to ad hoc, as today. To turn it on, add these repository secrets:

| Secret | What |
|---|---|
| `BEACON_DEVELOPER_ID_P12` | The "Developer ID Application" certificate with its private key, exported from Keychain Access as a .p12, base64 (`base64 -i id.p12 \| pbcopy`) |
| `BEACON_DEVELOPER_ID_PASSWORD` | The .p12's password |
| `APPLE_API_KEY` | An App Store Connect API key (Users and Access › Integrations › App Store Connect API, role Developer): the .p8's text, or it base64 |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys |

The first signed release changes the app's designated requirement (from its ad hoc hash to the Team ID), so macOS asks
for screen, camera and microphone once more; from then on updates keep the permissions.

## What leaves this Mac

Only when the user uses the feature, with their own key (Settings › AI and Settings › Transcripts):

| Service | Sent | When |
|---|---|---|
| OpenAI (`api.openai.com`) | Audio in chunks | Transcribing with Whisper through OpenAI |
| OpenAI | Transcript text | Planning B-roll, finding retakes (Best Take), suggesting music, writing motion graphics, with OpenAI as the planner |
| OpenAI | Frames of the video | Auto Tune (Film Look) |
| Anthropic | Transcript text, a motion graphic's brief and page | Writing or revising motion graphics with Claude |
| Replicate | Prompts and reference frames | Making B-roll footage and camera angles |
| Auphonic | The selected audio | Clean with Auphonic |
| Epidemic Sound | Searches (words, moods) | Music and sound effects |
| Firecrawl | A web address | A motion graphic that uses a web page |
| GitHub | Nothing but the request | Check for Updates |

## Fuzzing

Run before a release that touches a reader; each must refuse damaged input with an error, never crash or hang.

- `.trec` (Rust, the `moov`, `TSCR` and `TSCM` readers on a real recording's boxes, damaged in memory):
  `cd packages/engine && BEACON_FUZZ_TREC=<file.trec> cargo test -p beacon-media --release -- --ignored fuzz`.
  2026-11-05: 5.1 million damaged boxes in a minute, no panic, the slowest 17 ms.
- `project.json`, a take's `recording.json` and `cursor.jsonl` (TypeScript, read, migrated and validated as opening
  does): `bun scripts/fuzz-readers.ts [seconds]`. 2026-11-05: 35,100 damaged projects and 177,090 damaged takes in
  30 s each, every one read or refused with an error, the slowest 32 ms.
