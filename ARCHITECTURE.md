# Architecture

The design is in `PLAN.md` (§2 principles, §3 process model, §4 layout, §5–§7
model and commands). This file tracks what exists.

## Packages

```
packages/
├── model/     @beacon/model - pure TypeScript, no platform calls
│   ticks.ts       705,600,000 ticks/s, frame and sample maths
│   schema.ts      Zod schemas + types for Project, Track, Clip, Animation, Asset
│   feature.ts     the feature contract: clip types, prop groups, effects,
│                  render passes, evaluate hooks, .cmproj mappers, commands
│   registry.ts    FeatureRegistry: registers features, validates whole documents
│   migrations.ts  migrateProject: core then per-feature migrations
│   store.ts       ProjectStore: commands → Immer patches, transactions, undo/redo, dry run
│   commands.ts    built-in commands over the document's structure (settings,
│                  tracks, assets, clip.add) that every registry has
│   scene.ts       Scene primitives (mirrors beacon-render's scene.rs)
│   evaluate.ts    evaluate(project, t) → Scene; animation blocks
│   session.ts     editor state (playhead, selection, range, timeline view,
│                  panels, canvas zoom, snapping, clipboard) and its commands;
│                  not undoable
│   edit.ts        timeline editing maths shared by commands and the editor's
│                  drags: move plans, snapping, copying and pasting clips
├── features/  @beacon/features - one folder per feature, in evaluation order:
│              media, callouts, regions, groups, stitching, cursor, transform,
│              round-corners, crt-monitor, drop-shadow, motion-blur; then
│              editing-only: timeline (clip editing, ripple rules, magnetic
│              tracks, editing actions, animation blocks, effects,
│              markers, project queries), volume (audio points, fades,
│              silence), zoom, transcript
├── media/     @beacon/media - bun:ffi wrapper over beacon-ffi (.trec, in-process
│              renderer, live preview, audio output); probeMedia; cursor data;
│              whisper.cpp transcription; proxies; window capture
├── camtasia/  @beacon/camtasia - .cmproj import driven by the features' mappers
├── render/    @beacon/render - streams evaluated scenes to beacon-worker; audio mix;
│              FrameRenderer for stills and contact sheets through beacon-ffi;
│              LiveView, the app's preview and 1x playback;
│              DerivedData, the derived-data cache shared by core and scripts
├── core/      @beacon/core - the API (BeaconCore) and LocalCore: .beproj
│              folders, import through feature importers, derived-data cache,
│              background jobs (export, transcripts, proxies), frames, the
│              editor session and live view; the app socket and RemoteCore
├── mcp/       @beacon/mcp - the `beacon-mcp` stdio server
├── ui/        @beacon/ui - the React webview: the editor layout, a
│              canvas-drawn timeline, the keymap, a replica of the document
├── desktop/   @beacon/desktop - the Electrobun 2 app (Bun main process)
└── engine/    Rust Cargo workspace (not a Bun workspace)
    beacon-media   .trec reader: MP4 streams, TSCR, every TSCM chunk
    beacon-ffi     C ABI cdylib: opaque handles, JSON metadata, typed-array copies;
               a renderer handle (scene JSON in, PNG out) for frame.at; the
               preview handle (render thread into a CAMetalLayer); audio
               output (cpal)
    beacon-decode  in-process video decoding: a C shim over FFmpeg's libraries
               (Beacon's own build in `third-party/out`, or
               `BEACON_FFMPEG_INCLUDE`/`BEACON_FFMPEG_LIB`); `tool()` finds
               Beacon's own ffmpeg and ffprobe, never PATH's
    beacon-render  wgpu 30 compositor: sources (in-process video with frame indexes,
               stills, .trec cursors, Core Text text, stroked sketches),
               layers, groups, backdrops, runtime-loaded WGSL passes
    beacon-worker  export sidecar: job + scene lines in, video/PNG/raw out
    beacon-record  the recorder (Phase 6): `beacon-recorder serve` records
               `.brec` takes (JSON commands in, events out) through
               ScreenCaptureKit and AVFoundation over objc2
```

Dependency graph: `media → model`; `features → model + media`; `media` loads `beacon-ffi`;
`camtasia → model + media` (+ features at runtime through the registry);
`render → model + media` (+ features at runtime through the registry);
`core → model + features + media + camtasia + render`; `mcp → core`;
`ui → model`; `desktop → core + ui`;
`beacon-worker → beacon-render → beacon-media + beacon-decode`; `beacon-ffi → beacon-media`.

## Evaluation
`evaluate()` walks the visible tracks bottom → top and, for each active
clip, resolves its prop groups (defaults, values, animation blocks at the
clip's media time), then runs every feature's `evaluate.clip` hook in
registration order. Clip types draw their content in content space and set
`main`; the cursor adds its sprite in the same space; `transform` maps
everything onto the canvas (centre origin, y up, scale in
source pixels, crop that keeps content in place); effects then add passes,
radii or motion samples to `main`. Groups evaluate their nested tracks on
their own canvas. Motion blur re-evaluates a clip at earlier times with
`sample: true`. Derived asset data (the cursor track) comes from feature
analyzers, read through `data(assetId, key)`.

`evaluateAudio()` collects the mix the same way: each clip on an unmuted
track contributes segments through `evaluate.audio` hooks (media position,
speed, and a gain envelope in media time); groups map their nested
segments through their window. The exporter turns segments into ffmpeg
`volume`/`atempo`/`adelay` chains.

## Rendering
The Scene is generic: visual layers (source, solid or group content, with
an affine transform, crop, rounded-rect mask, opacity, motion transforms
and passes) and backdrops (process what is under a masked rect). Each
visual layer is drawn into a canvas-size texture, its passes run there, and
it is composited premultiplied. Passes are WGSL fragment entry points over a
shared prelude, loaded from the job at runtime, so a new effect needs no
Rust. Video is decoded in process (`beacon-decode`: libavformat/libavcodec
through a small C shim, VideoToolbox for H.264/HEVC/ProRes), one thread per
decoder kept open across seeks, at the smallest power-of-two size that
covers the drawn size, with frame times
from a cached ffprobe index (decoded frames for tscc2, whose 1-byte
"unchanged" packets yield no frame).

## Preview and playback
The app's canvas is an `<electrobun-wgpu>` element: Electrobun places a
native view with a `CAMetalLayer` where the element is laid out. The main
process hands the layer to `beacon_preview_new`, whose render thread owns an
beacon-render `Preview`: the export's `Renderer` draws the canvas at full size,
then a fit pass scales it into the layer (box filter, dark grey
surround). Only the latest submitted scene is drawn; the layer's bounds are
read each frame, so resizing needs no messages; a frame macOS refuses
(occluded window) is retried. At the canvas size preview pixels are export
pixels (`core/__tests__/parity.test.ts`).

Playback (`LiveView` in render) uses the audio device as the clock: cpal
plays the export's ffmpeg mix (`audioMix`) from the playhead, and each new
frame of audio time evaluates and submits a scene. Two seconds ahead, scenes
at upcoming cuts are sent as `preroll`, starting their decoders so a cut
never waits for ffmpeg (~0.5 s). While scrubbing or playing, video comes
from proxies (job analyzer `proxy`: short-GOP HEVC, screens 8 Mb/s and
cameras 5 Mb/s, half size above 1920 wide; one ffmpeg per file, H.264/HEVC/
ProRes decoded and scaled on the GPU; one at a time at background priority
unless Settings say Fast; started when the app shows a project); 250 ms
after movement stops the frame is redrawn from the originals.

## Editor session and the app
`SessionStore` (model) holds what the editor shows; its commands
(`playhead.*`, `playback.*`, `selection.*`, `range.*`, `timeline.*`,
`panel.show`, `inspector.tab`, `canvas.zoom`) run through `core.run` like
document commands and appear as MCP tools, but aren't undone or saved.
`ui.state` reads it, `ui.snapshot` adds a window screenshot with the canvas
pasted in at the playhead and what the webview reports it has drawn.

The desktop app owns a `LocalCore` and serves it on a unix socket
(`~/Library/Application Support/Beacon/app-<pid>.sock`, one per app process, mode 0600):
newline-delimited JSON-RPC 2.0, one request per `BeaconCore` method,
`event` notifications for open projects, bytes as `{ "$bytes": base64 }`.
The project lock records the socket, so `beacon-mcp` opens a project the
app holds through `RemoteCore` (edits show live, one undo history) and
everything else locally. The webview keeps a replica of the document and
session, updated by patches and session events over Electrobun RPC; it only
sends commands. Keys resolve through `keymaps/default.json`'s `command`
fields.

## Engine boundary
TypeScript calls `libbeacon_ffi.dylib` through `bun:ffi` for interactive
queries, and spawns `beacon-worker` for exports. Metadata crosses as JSON;
bulk tracks as typed arrays; pixels never leave Rust.

## Commands
A `CommandDef` has an id, description, Zod args schema and `apply(draft, args,
ctx)`, which mutates an Immer draft. `ProjectStore.transaction` runs one or
more commands on a single draft, validates the result with the registry
(nothing applies if anything throws), stores patches and inverse patches as
one undo step and notifies subscribers with the patches.

Commands take times in seconds, snapped to frames (`snapSeconds`), and read
derived data (`ctx.data`, e.g. transcripts, which may come from the disk
cache), but never write anything or spawn processes. Features also contribute
**queries** (read-only, exposed like commands; a query can also declare itself an MCP
resource or the project summary), **importers** (which clips a
file type becomes) and **job analyzers** (slow derived data run as
background jobs, cached on disk by file path, fingerprint and analyzer
version in `~/Library/Caches/Beacon/derived`).

## Editing on the timeline
Every edit the editor makes is a command, and a drag is one: the timeline
canvas draws a ghost while dragging (where the clips would land, red where
the drop is refused) and sends one command, with an undo label
("Move Media", "Trim Media"), when the pointer is released. The ghost and the
command use the same maths from `model/edit.ts` (`planMove`, `snapOffset`,
`snapTargets`, `pasteBase`), so they agree. Snapping is 12 points to clip
edges, the playhead, markers and the range; Control turns it off. The
rules: a recording's
linked clips (its camera and audio, or screen and audio without a camera;
never screen and camera) select, move, trim and delete together, in the
editor as in agents' commands (as DaVinci Resolve; Unlink to edit them
apart), drops over other media are refused,
ripple delete closes the removed time on each affected track by the same
amount, magnetic tracks pack their clips (a feature `normalize` hook that
runs at the end of each transaction).

Editing keys and menu items are **editor actions** (`ActionDef` in the
feature contract): `edit.rippleDelete`, `edit.cut`, `edit.paste`,
`edit.split`... read the selection, range and playhead and resolve to
editor commands before and after, and document commands run as one undo
step. `LocalCore.run` runs them like commands, so keys, menus and agents (an
MCP tool each) do the same thing. ⌘X/⌘C/⌘V reach the webview as clipboard
events, from the keys or the Edit menu's roles alike. The clipboard (and
Copy Properties) is session state, shared by the projects one core has
open and passed to those opened later; a copy carries every asset its clips
use, nested ones too. If an action's document change fails, its editor
steps are undone with it.

The properties panel and the canvas overlay (`ui/src/canvas.tsx`) edit
with `clip.set` at the playhead (`at`: animated fields change the block in
effect there). Drags send changes as they go with a `coalesce` key, which
`ProjectStore` merges into one undo entry and `LocalCore` saves once
settled. The overlay sits over the native preview, which passes clicks
through to it: the overlay keeps invisible grab areas and computes the
selection outline, handles, rotate control, canvas border and snap guides as
marks (lines and circles) that the preview draws in the same frame as the
picture (`beacon_preview_marks`), so they never lag it; the UI harness draws them
as SVG. It mirrors the preview's placement (centred, fit or zoom percent, in
the `<electrobun-wgpu>` element's measured box, inset 12 pt). Electrobun's
preload styles the tag 800×300, so the element sets its own size; masks
(holes in the native view, re-sent with `syncMasks` since Electrobun sends
them only when the element moves) are left for the dragged panel item.
Tool panel items drag onto
clips on the timeline or canvas (`ui/src/drop.ts`: drop targets register
hit tests) and run their action with the clip as `clip`.

Animation blocks show as arrows on their clips; Custom (⇧A) adds one from
the playhead and moves there, so property and canvas edits at that point set
its end state. Audio points are the `volume` feature's view of the
`audio.volume` envelope (a base value and linear blocks in media time):
`volume.setPoints` replaces them, and the timeline draws and drags them.

Groups and stitched clips hold nested tracks behind a window. An open group
is an **edit scope** (`editScope`/`scopedProject` in `model/edit.ts`): its
tracks shifted to main-timeline times, which the session, the actions
(`ActionContext.scope`) and the timeline use, so editing inside works like
editing the timeline. Commands always take main-timeline seconds: each
clip's location carries its group offset (`ClipLocation.offset`, from
`walkClips`) and commands convert once (`onTrack`). Track commands find
tracks inside groups too.

The UI's look is in two places: `ui/src/styles.css` holds the design
tokens (every colour by role, the font) as Tailwind `@theme` variables, which
classes use by name; `ui/src/controls/` holds the shared controls (buttons,
fields and value boxes, fold sections, the colour picker, `Modal`, `PlayBar`
and `Timecode`, `NativeView`), which every panel and dialog is built from. What
CSS can't style (the canvas-drawn timeline, the overlay's marks drawn by the
native preview, the preview's surround) reads the same variables through
`ui/src/theme.ts`.

`scripts/ui-harness` serves the UI to Playwright's headless Chromium, with a
`LocalCore` behind the same host interface the app uses, and drives it over
the DevTools protocol (mouse, keys, screenshots): the editor can be tested
with no window on screen.

## Core and automation
`LocalCore` (`@beacon/core`) owns open projects: a `ProjectStore` per
`.beproj` folder (`project.json`, written atomically after every change; a
`lock` file created exclusively, holding the owner's pid; stale locks are
taken over), its derived data, a warm `FrameRenderer`,
and background jobs (export through `beacon-worker`, transcripts) and
`captureFrame` (Snapshot: a PNG of the canvas in the project's
`media` folder, added as an asset). Import probes
the file, asks the feature importer for clips, and adds the asset and its
clips in one transaction, linked by the importer's keys; a `.trec` becomes
Screen, Camera and Audio clips fitted to the canvas, the camera and audio
linked. Every write an agent asks for (`export`, saved
frames) passes `checkOutput`: never a project's media, never inside a
`.cmproj` or `.beproj`, never an existing file without `overwrite`. Asset
paths must be absolute in memory and every ffmpeg/ffprobe input is limited to the
`file` protocol, so a shared project can't point ffmpeg at a URL. On disk,
files inside the project folder are stored relative to it (`persist.ts`), so
a copied project keeps its takes and snapshots. A standalone project
(`settings.standalone`) copies imports into `media/` (`media-copy.ts`: clones,
file times kept so fingerprints match; `DerivedData.carry` gives the copy the
original's transcript); turning it on copies in what is outside as one undo
step. `saveAs` writes a copy of the folder with the document as it is, and
`reveal` shows the folder in Finder.

`beacon-mcp` (`packages/mcp`) is a stdio MCP server over `LocalCore`:
every command and query is a tool (dots become underscores; JSON Schema from
the Zod args; commands also take `dryRun`/`label`), plus project, import,
transaction, `frame_at`, `frames_sheet`, export and job tools. Resources: the
project summary, timeline, transcript, a command reference generated from
the registry, the workflows and house style. Prompts: the workflows in
`skills/workflows/`. `skills/SKILL.md` is the server's instructions, built
in. `bun run build:mcp` compiles it to `dist/beacon-mcp` beside the
engine library and worker; `.mcp.json` runs it from source for Claude Code.

## Transcripts
`transcribe()` extracts 16 kHz mono, finds speech with an RMS envelope
(threshold between the recording's noise floor and speech level), splits it
at pauses of 0.3 s or more into chunks of up to 25 s and decodes them in one `whisper-cli`
run (large-v3-turbo q5, `-mc 0`, DTW word timing with flash attention off).
Decoding chunks independently and without context is what keeps retakes:
over long audio whisper skips repeated phrases. Words are fitted to the
speech regions and dropped if they fall in silence (whisper invents words in
silence). Pauses come from the speech regions, not word gaps, so speech
whisper missed is never cut as silence.

## Where shared code goes
`core` is the top of the graph, so nothing below it can import from it.
Pure helpers (ticks and frame snapping, clip speed, ids, schema and error
formatting) live in `model`; helpers that touch files or processes
(`runTool`, `fileFingerprint`, the engine) live in `media`.
