# Beacon — plan

Beacon by Orva: a macOS-only screen-recording editor that owns its project
format and renderer, so it can be fully automated and never breaks on someone
else's update. Beacon is the **editor + renderer + automation surface**, and
then the recorder too (Phase 6).

This document is architecture-first. The goal is that adding a feature later is
"add one folder", not "touch ten layers".

**Status (2026-10-18):** Phases 1–6 are done (Phase 3: headless Claude Code
rough-cut a recording from its transcript, laid it out, zoomed and exported
it; Phase 5 closed after the user's runs in the app, cut as v0.1.0; Phase 5.5,
the new look, closed 2026-10-13 with more to add later; Phase 6, the
recorder, passed its gate 2026-10-15: the user recorded screen, Cam Link,
Yeti and system audio, edited (Remove Silences) and exported in Beacon
alone). Video is decoded in process (`beacon-decode` over FFmpeg's
libraries), with frames kept for steps back (`docs/performance.md`). Phase
6.5 made Beacon one self-contained app with fast export, released as v0.2.1
and v0.3.0, passed its gate 2026-10-19. Phase 7, transcript tools, is built and
merged, released as v0.5.0 (2026-10-16; v0.4.0 was cut partway through it),
and passed its gate 2026-10-19. Phase 8, faster editing (voice
narration, favourites, shortcuts, the command palette, colour labels,
settings and dialogs for agents), is built and merged, released as v0.6.0
(2026-10-18), passed its gate 2026-10-19 but for the agent half (MCP
with the app open, below). The review's three branches were merged
2026-10-19 (#18, #19, #20). Phases 8.5, 9, 10 and 10.5 are merged
(v0.7.0-v0.10.0; v0.10.1 fixed ⌥-dragging a clip's start, 2026-10-22).
Phase 11's first half shipped as v0.11.0 and v0.11.1 (2026-10-22: track
keys, Clean with Auphonic, the Record dialog's permissions). Next (order set
2026-10-22): **Phase 11's AI B-roll and animations** (on `feat/ai-broll`), 12 (device frames, and a spike on AI camera angles), 13 (security
audit), 14 (Camtasia export) and 15 (Beacon learns how you edit).
Phase 5 was split into four parts, each with its own gate (§13). Format notes
are in `docs/formats/`, versions in `docs/dependencies.md`. What exists is
summarised in `ARCHITECTURE.md`.

**Working rules for every session**
- When unsure how something should behave, ask.
- Never edit the user's real `.cmproj` files; use copies.
- The user dictates with speech-to-text: "Open Taser" means Beacon.
- Only start a phase when the user says go; keep this plan updated when a
  decision changes.

---

## 1. Scope

**In**
- A native recorder (Phase 6): screen, camera, microphone and system audio,
  with a cursor and click log.
- Native desktop app (Electrobun, WKWebView UI, Bun main process). Not a web
  app — no browser support, no localhost UI server.
- macOS only (arm64). Assume macOS 26+ (WebGPU in WKWebView, VideoToolbox).
- Inputs: `.trec` recordings (screen + camera + audio + cursor data),
  mp4/mov, images, audio files.
- The features the user's 38 existing projects actually use:
  clips on tracks, groups, callouts, round corners, drop shadow, CRT monitor,
  cursor effects (size, shadow, motion blur, physics, click scaling), clip
  motion blur, animations (zoom/pan, position/scale/opacity),
  copy/paste visual properties.
- Animations are **animation blocks on clips**, end state edited on the
  canvas, with easing; no library of preset animations.
- A default keymap of familiar editing shortcuts.
- Automation as a first-class client: an MCP server drives the same commands as the
  UI.
- Import of existing Camtasia `.cmproj` projects (best effort).

**Out (for now)**
- Recording before Phase 6: we read existing `.trec` files.
- Windows/Linux, browser builds.
- Features without real usage.
- Writing `.cmproj` back out.

---

## 2. Architectural principles

1. **One document, one mutation path.** All state lives in a single typed
   `Project` document. The only way to change it is to dispatch a **command**.
   The UI, keyboard shortcuts, menus and agents (via MCP) all dispatch the same
   commands. Undo/redo, autosave and automation fall out of this for free.
2. **Features are modules.** Every feature (callouts, cursor, CRT, …) is a
   folder that registers its schema, commands, shortcuts, inspector, render
   nodes, importers and migrations with a central registry. Core code never
   mentions a specific feature.
3. **Evaluation is pure.** `evaluate(project, time) → Scene` is a pure function
   in TypeScript. It turns the edit (clips, animations, effects, cursor data)
   into a flat list of render primitives. Preview and export both consume the
   same `Scene`.
4. **One renderer.** The same Rust/wgpu renderer (`beacon-render`) draws
   the live preview (into a native GPU view in the window) and the
   export, from the same WGSL. Preview and export match by construction;
   parity tests still guard it.
5. **The renderer is dumb and generic.** It knows a small fixed set of
   primitives and runs effect passes by name from a manifest. New effects are
   WGSL + a param schema — no Rust or renderer code change.
6. **Schema-driven UI.** Inspector controls are generated from param schemas
   (as hance does with `EFFECT_SCHEMA`). A new property gets UI, undo,
   copy/paste-properties, persistence and automation without extra wiring.
7. **Versioned everything.** The project file has a schema version; every
   feature ships migrations. Old projects always open.
8. **Main process is authoritative.** The Bun process owns the document. The
   webview holds a replica updated by patches. This is what lets MCP clients
   edit a project while the UI is open and have the timeline update live.
9. **Agents can do everything.** Every action, setting and piece of app state
   is a command or query, available to agents through the MCP server and a
   skill built into the binary (§7). A feature isn't done until an agent can
   drive and see it.
10. **When unsure, ask.** Behaviour, UI, shortcuts, easing curves, defaults
   and edge cases follow established editor conventions; if it still isn't
   clear, ask rather than guess.

---

## 3. Process model

```
┌──────────────────────────── Beacon.app ─────────────────────────────┐
│                                                                        │
│  Bun main process (authoritative)                                      │
│  ├─ ProjectStore     document + command dispatcher + undo history      │
│  ├─ FeatureRegistry  all feature modules                               │
│  ├─ MediaService     importers, .trec reader, proxies, thumbnails,     │
│  │                   waveforms (ffmpeg / ffprobe child processes)      │
│  ├─ ExportService    evaluate() per frame → render sidecar → encoder   │
│  ├─ AutomationServer unix socket: MCP server(s) connect here           │
│  └─ Persistence      atomic save, autosave, crash recovery             │
│          ▲  typed Electrobun RPC (commands up, patches down)           │
│          ▼                                                             │
│  WKWebView (UI only)                                                   │
│  ├─ React shell: panels, timeline, canvas, inspector                   │
│  ├─ Document replica (applies patches, never mutates directly)         │
│  ├─ Lays out around the native preview view; draws handles over it    │
│  └─ Keymap → command ids                                               │
│                                                                        │
│  beacon-render (Rust, wgpu sidecar)                                 │
│  └─ Scene JSON in, frames out → ffmpeg/VideoToolbox encode             │
└────────────────────────────────────────────────────────────────────────┘

  Beacon MCP server ──unix socket──▶ AutomationServer (app open)
                             └─ or headless: load project file, run the same
                                commands in-process, save (app closed)
```

**Why the document lives in Bun, not the webview:** automation must work with
the app open or closed, and the UI must not be the only thing that can edit.
Commands are small JSON messages; patches are small too. The webview stays a
view.

**Preview: one renderer.** A Phase 0 spike showed the Rust renderer can draw
straight into an Electrobun native GPU view (a `CAMetalLayer` embedded in the
window) from inside the Bun process. So the preview uses **the same
`beacon-render` code as export**, built as a dylib and loaded with
`bun:ffi`; video never has to enter the webview. The HTML UI lays out around
the native view and draws handles over it. WebGPU-in-the-webview (a Phase 0 spike,
option A) stays as a fallback.

---

## 3.1 The Rust engine boundary

Beacon is a desktop app, not a web app, so all heavy work runs in native
Rust; TypeScript orchestrates.

| Work | Lives in | Why |
|---|---|---|
| Decode, `.trec` parsing, proxies, thumbnails, waveforms, probing | Rust | throughput, native codecs (ffmpeg/VideoToolbox) |
| Compositing, effects, cursor drawing (preview **and** export) | Rust (wgpu) | one renderer, GPU access (S3, S7) |
| Audio mix, volume envelopes, loudness | Rust | sample-level work |
| Silence detection, analysis, transcription (whisper binary) | Rust / native binary | CPU-heavy |
| Project model, commands, undo, feature registry, `evaluate()`, MCP server, UI | TypeScript | light, and where features plug in |

**How they talk**
- **In-process library (`bun:ffi`)** for anything interactive: preview,
  playback, scrubbing, "frame at t", quick queries. C ABI, opaque handles,
  no per-call serialisation of large data. Proven in S7.
- **Separate binary (sidecar)** for long jobs: export, proxy generation,
  transcription, batch scans. Crash-isolated, can run at lower priority;
  commands in, JSON-lines progress out.
- **Never** move pixels or samples through JSON/RPC. Frames stay in Rust (GPU
  textures or shared memory). TypeScript sends commands and the per-frame
  Scene (a small JSON description).
- **No WASM**: it only helps in a browser; natively it is slower and makes
  threads, GPU and native codecs harder.
- Rust → TypeScript events (job progress, decode ready) go through a queue
  that TypeScript polls, avoiding cross-thread callbacks into JavaScript.

`evaluate()` stays in TypeScript because features plug in there and the
Scene is small. If profiling ever shows it is a bottleneck, it can move to
Rust behind the same Scene format without changing features.

## 4. Repository layout

Same workspaces architecture as hance: one Bun workspaces monorepo, coarse
packages named `@beacon/<name>`, each consumed as TypeScript source
(`"main": "src/index.ts"`, no per-package build step), internal dependencies
as `workspace:*`, the Rust renderer as a Cargo crate inside `packages/`, root
scripts for builds, one MCP server binary built with `bun build --compile`.

```
beacon/
├── package.json             "workspaces": [explicit list], root scripts:
│                            build, build:wgpu, build:ui, gen-skills, test
├── tsconfig.json            shared compiler options (strict, bundler, react-jsx)
├── bunfig.toml              [test] root = "packages"
├── PLAN.md  ARCHITECTURE.md  CLAUDE.md
├── scripts/                 gen-skills.ts, gen-pass-manifest.ts, build-ui.ts,
│                            release scripts
├── skills/                  agent instructions + workflow docs, compiled into
│                            the MCP server (instructions, prompts, resources)
├── keymaps/                 default.json (like hance's presets/ at the root)
├── docs/                    formats/, performance and dependency notes
└── packages/
    ├── model/               @beacon/model — project types, ticks, schema
    │                        validation, migrations, command bus + undo,
    │                        feature registry, evaluate(), Scene types.
    │                        Pure: no platform calls, no engine.
    ├── core/                @beacon/core — **the API**. One interface
    │                        (BeaconCore) used by the MCP server
    │                        and the desktop app; local and remote
    │                        implementations (§7.1)
    ├── features/            @beacon/features — one folder per feature
    │   └── src/             (clips-basic, transform, animations, motion-blur,
    │                        groups, callouts, round-corners, drop-shadow,
    │                        crt-monitor, cursor, copy-properties, audio,
    │                        stitching, regions, still-frames, transcript)
    ├── media/               @beacon/media — .trec reader, ffprobe, proxies,
    │                        analyzers, caches
    ├── camtasia/            @beacon/camtasia — .cmproj import
    ├── render/              @beacon/render — TS side of export: spawns and
    │                        talks to the Rust sidecar (like @hance/gpu)
    ├── engine/              Rust (Cargo workspace, not a Bun workspace; like
    │                        hance's packages/wgpu):
    │                        beacon-media (decode, .trec, proxies, waveforms),
    │                        beacon-render (wgpu compositor), beacon-audio (mix,
    │                        envelopes), beacon-ffi (cdylib for bun:ffi: preview,
    │                        playback, queries), beacon-worker (sidecar binary:
    │                        export, proxies, analysis)
    ├── ui/                  @beacon/ui — React app for the webview:
    │                        shell, panels, timeline, canvas overlays,
    │                        inspector (preview pixels come from the native view)
    ├── mcp/                 @beacon/mcp — the `beacon-mcp` binary: a
    │                        stdio MCP server (tools, prompts, resources)
    └── desktop/             @beacon/desktop (private) — Electrobun main
                             process: services, RPC, menus, socket server
```

### Dependency graph
```
media     → model
features  → model + media    (text layout, cursor data and media probing; tests also read Camtasia projects)
camtasia  → model + media
render    → model + media    (TS wrapper over beacon-ffi / beacon-worker; derived-data cache)
core      → model + features + media + camtasia + render   (the API)
ui        → model            (renders the replica; talks to core via RPC; types only from core, media and features)
mcp       → core             (the `beacon-mcp` server)
desktop   → core + ui (bundled dist)
```
- `model` depends on nothing internal, so it can be tested in isolation.
- **`mcp` and `desktop` only ever import `core`** (and the desktop, the ui it
  bundles); core re-exports the model helpers they need. Nothing else talks to
  the engine, the media layer or project files directly.
- `ui` can't import `features` at runtime: it loads the engine when imported.
  What the editor needs of features comes in `Init` (effects, panel items,
  prop-group defaults); their types are imported with `import type`.
- The MCP server is its own small binary; a CLI can be added later as another
  thin client of `core` (backlog).
- Unlike hance's desktop app, `desktop` does **not** serve the UI from a local
  HTTP server; it loads the bundled UI as Electrobun views and talks to it over
  typed RPC.
- Features are folders inside one package rather than one package each, to
  match hance's coarse packages; a feature only becomes its own package if it
  grows heavy dependencies.

### 4.1 Sharing code with hance

**Rule:** when Beacon and hance need the same thing, consider moving it to
a **shared repo** that both depend on, instead of copying it. Share when all
three hold:
1. both projects use it **now** (not "might later"),
2. it has a stable interface,
3. a fix should reach both.
Otherwise copy it and record it in `docs/shared-candidates.md`, revisiting at
each phase gate.

**The shared repo** (working name `orva-kit`) uses the same workspaces
architecture: `packages/<name>` published as `@orva-studio/<name>`. Because
hance is a shipped product built in CI, shared packages are **published to
npm** (versioned, pinned by both apps); local development uses `bun link`.
Extraction order for each piece: move it to `orva-kit` → publish → switch hance
to the package and pass hance's tests → then Beacon adopts it.

**Candidates**

| Shared piece | In hance today | Beacon needs it for | Decision |
|---|---|---|---|
| WGSL shaders, param schemas, pass-manifest format | `core/shaders`, `core/schema.ts`, `wgpu/passes.rs` | all effects | **Share — Phase 2** (`@orva-studio/shaders`) |
| Agent skill tooling | `scripts/gen-skills.ts`, `cli/commands/skills.ts` | MCP instructions/prompts | **Share — Phase 3** (`@orva-studio/agent-skills`) |
| ffprobe / ffmpeg helpers, export presets, output quality | `core/probe.ts`, `core/export-presets.ts`, `gpu/export.ts` | media + export | **Likely share — Phase 3**, after comparing needs |
| Schema-driven controls and layout (RangeSlider, Toggle, SelectControl, EffectGroup, ResizeDivider) | `ui/app/components` | inspector, panels | **Share — Phase 4** (`@orva-studio/ui-kit`) |
| Rust sidecar protocol + generic pass runner | `gpu/wgpu-renderer.ts`, `wgpu/src` | export renderer | **After the Phase 2 gate, optional**: extract once `beacon-render` is proven |
| Electrobun shell (menus, config, signing, WebKit cache cleanup) | `desktop/` | desktop | **Revisit at Phase 4**; probably a template, not a package |
| Docs site (Starlight + llms.txt), release scripts | `docs/`, `scripts/` | later | **Copy** |
| Colour grading, LUTs, looks | `core` | — | **Stays in hance** (Beacon uses looks through the shared shaders) |

Beacon never depends on hance's app packages directly (`@hance/ui`,
`@hance/cli`, `@hance/desktop`); it only uses what has been moved to
`orva-kit`. Until a piece is extracted, Beacon may link hance's folder by
path for spikes only.


---

## 5. Core model

### Time
All times are integer **ticks** at **705,600,000 per second** — the same rate as
the `.cmproj` `editRate`. It divides every common frame rate (24, 25, 30, 60, 120,
30000/1001) and sample rate (44.1k, 48k) exactly, so frame snapping and
`.cmproj` import are lossless. JS numbers stay exact for ~147 days of timeline.

### Document
```ts
interface Project {
  schemaVersion: number;
  features: Record<string, number>;   // feature id → data version
  settings: { width; height; fps: Rational; sampleRate; background };
  assets: Record<AssetId, Asset>;     // media references + derived data
  tracks: Track[];                    // ordered bottom → top
  markers: Marker[];
}

interface Clip {
  id: ClipId;
  type: string;                       // registered by a feature, e.g. "video"
  start: Ticks; duration: Ticks;      // timeline
  mediaStart?: Ticks; speed?: Rational;
  assetId?: AssetId;
  props: Record<string, unknown>;     // validated by the clip type's schema
  effects: EffectInstance[];          // { id, type, enabled, params }
  animations: Animation[];             // blocks, see below
}

interface Animation {
  id: AnimationId;
  end: Ticks;                         // in media time (source position), so
                                      // split pieces share blocks
  duration: Ticks;                    // block spans [end - duration, end]
  easing: Easing;                     // linear, ease-in/out
  to: Record<PropPath, unknown>;      // property values at the block's end
}
```

**Animations are blocks on clips**: a clip
has a base state, and each animation block is an arrow on the clip that
transitions any animatable property to a new value over its duration with an
easing. Values hold between blocks. This maps 1:1 to `.cmproj`
`animationTracks.visual[] { endTime, duration, interp }` plus parameter
keyframes, so imports are exact. Any schema property marked `animatable` can
be a target, so new features get animation support for free.
- `type`, `props`, `effects[].type` and `params` are **open**: defined by
  feature schemas, validated by the registry. Core never hard-codes them.
- Groups are clips with their own canvas size (`props.canvas`) and nested
  tracks (`props.tracks`), shown through a time window (`mediaStart` /
  `duration`), as `.cmproj` stores them too.
  They render to an offscreen texture so effects like Round Corners apply to
  the group as a whole. Nesting is
  generic.
- Stitched clips hold an ordered list of source segments on their own inner
  timeline, shown through a window, with transform/animations/effects on the
  outer clip.
- **Recordings import as separate clips**: screen, camera and audio each on
  their own track; the camera and audio linked (the screen and audio when
  there is no camera) so cuts and moves keep them in sync, unlinkable when
  needed. The screen and camera are never linked (the user, 2026-10-13).
- Assets carry derived data by key (`proxy`, `waveform`, `thumbnails`,
  `cursor`, `transcript`), each produced by a registered **analyzer**.

### On disk
An `.beproj` folder bundle:
```
foo.beproj/
└── project.json        the document (pretty-printed, diffable)
```
Derived data (proxies, waveforms, thumbnails, transcripts) is cached
globally in `~/Library/Caches/Beacon/derived`, not in the bundle
(decided in Phase 3). Autosave snapshots (`history/`) aren't built: every
change is saved as it is made.
Media is referenced by path plus a content fingerprint so moved files can be
relinked: files inside the project folder (`recordings/`, `media/`) relative to
it, others absolute (schema 2). Standalone projects copy imports into `media/`. Saves are atomic (write temp → fsync → rename). A lock file
prevents two writers; the MCP server talks to the app instead when it is open.

### Migrations
`schemaVersion` covers core shape; `features[id]` covers each feature's data.
On open: core migrations run first, then each feature's migrations for its
own data. Migrations are pure `(doc) → doc` functions with fixture tests.

---

## 6. The feature contract

Everything user-visible is a feature. A feature is a folder exporting:

```ts
export interface Feature {
  id: string;                     // "cursor"
  version: number;                // data version, drives migrations

  clipTypes?: ClipTypeDef[];      // schema for props, default values,
                                  // which effects/animations apply
  effects?: EffectDef[];          // param schema + render pass reference
  analyzers?: AnalyzerDef[];      // derive asset data (e.g. cursor track)
  importers?: MediaImporterDef[]; // file types this feature can ingest

  commands?: CommandDef[];        // id, args schema, apply(doc, args) → patch
  keymap?: KeyBinding[];          // defaults; keymaps/*.json can override
  menus?: MenuItemDef[];

  inspector?: InspectorDef[];     // optional: custom sections; default is
                                  // generated from the schema
  panels?: PanelDef[];            // optional: whole UI panels

  evaluate?: EvaluateHook;        // contribute primitives to the Scene; gets
                                  // timeline context (neighbouring clips,
                                  // source times) for cross-clip behaviour
                                  // like cursor smoothing across edits
  passes?: RenderPassDef[];       // WGSL file + uniform layout from params

  camtasia?: CamtasiaMapper[];    // map .cmproj _types / effectNames in
  migrations?: Migration[];
}
```

**Adding a feature checklist**
1. Create `packages/features/src/<name>/` with an `index.ts` exporting a `Feature`.
2. Declare schemas; inspector UI, copy/paste-properties, persistence and
   agent exposure (commands, MCP tools, skill docs) come from them.
3. Add commands if it needs operations beyond setting params.
4. If it renders: add a WGSL pass + `passes` entry, or an `evaluate` hook that
   emits existing primitives.
5. Add a `.cmproj` mapper if imported projects use it.
6. Add a golden-frame test, a migration fixture, and an agent test: drive the
   feature only through MCP tools and verify it with `frame.at`.
7. Register it in `packages/features/src/index.ts`.

No changes to `model`, `commands`, `evaluate`, `render`, `ui` or `automation`
should be needed. If they are, the contract is missing something; extend the
contract, not the core.

---

## 7. Commands, undo and agent control

An agent can do **everything** a person can, and see everything a person
sees. This follows hance's model (one agent surface, instructions baked into
the binary, render → look → iterate loops) and goes further, because the
command bus covers the whole app, not just export.

### Commands
- A **command** = `{ id, args }`. `CommandDef` has an args schema, a
  description (used for agent docs, MCP tool docs and the command palette) and
  `apply(draft, args, ctx)`, which mutates an Immer draft of the document;
  patches and inverse patches are derived from it.
- The dispatcher runs `apply` inside a **transaction**, validates the result
  against schemas, records inverse patches for undo, persists, and broadcasts
  patches to the webview.
- **Transactions group commands**: a drag is one undo step; an agent edit of 40
  cuts is one undo step labelled "Agent: rough cut".
- **Every command supports `dryRun`**: it returns the patch, a readable diff and
  optionally before/after frames, without applying anything.

### Agent parity — nothing is UI-only
- **Document edits** go through commands (always true, §2.1).
- **App state is commands too**: selection, playhead, in/out range, timeline
  zoom and scroll, open panel and inspector tab, canvas zoom, play/pause,
  open/close/save project, preferences, keymap. Session state is not undoable,
  but it is fully drivable and readable.
- **Parity is enforced by tests**: every menu item, shortcut and inspector
  control must resolve to a registered command id; a lint fails any UI code
  that mutates state without dispatching.

### What the agent can see
| Query | Returns |
|---|---|
| `project.describe` | Plain-text summary: tracks, clips, animations, effects, durations |
| `project.get` / `query` | The document, or a JSONPath slice of it |
| `frame.at` | Rendered still at a time (preview or full quality) |
| `frames.sheet` | Contact sheet across a range, for judging pacing and cuts |
| `clip.preview` | Short low-res render of a range, for judging motion |
| `ui.snapshot` | Screenshot of the app window, plus a structured description of what is on screen (selection, playhead, visible range, open panels) |
| `transcript.get`, `audio.levels`, `cursor.track` | Analyzer data |
| `commands.list` / `commands.describe` | Every command with schema and docs |

### 7.1 The core API (`@beacon/core`)
Everything an agent or the app can do goes through one interface:

```ts
interface BeaconCore {
  open(path: string): Promise<ProjectHandle>;
  create(opts: NewProjectOptions): Promise<ProjectHandle>;
  save(h: ProjectHandle): Promise<void>;
  run(h: ProjectHandle, command: string, args: unknown, opts?: { dryRun?: boolean; label?: string }): Promise<CommandResult>;
  transaction(h: ProjectHandle, label: string, fn: (tx: Tx) => Promise<void>): Promise<CommandResult>;
  undo(h: ProjectHandle): Promise<void>;
  redo(h: ProjectHandle): Promise<void>;
  query(h: ProjectHandle, name: string, args?: unknown): Promise<unknown>;   // project.describe, timeline.clips…
  frame(h: ProjectHandle, time: Ticks, opts?: FrameOptions): Promise<Image>;
  export(h: ProjectHandle, opts: ExportOptions): Job;
  import(h: ProjectHandle, files: string[], opts?: ImportOptions): Job;
  commands(): CommandInfo[];                     // name, description, JSON schema
  watch(h: ProjectHandle, fn: (e: CoreEvent) => void): Unsubscribe;
}
```

- **Local implementation:** runs in-process, loads the Rust engine (`beacon-ffi`,
  `beacon-worker`), reads and writes the project file. Used by the MCP server
  when the app is closed, and by the desktop app itself.
- **Remote implementation:** a thin client speaking the same interface over
  the app's unix socket to the app's own local core. Used by the MCP server
  when the app is open, so edits appear live and share one undo history.
- **Selection is automatic:** the MCP server connects to the socket if the app owns
  the project's lock, otherwise run locally.
- The interface is versioned; the MCP tools and agent docs are generated
  from `commands()` and the query list.

### Surfaces: MCP first
- **MCP server (`beacon-mcp`)** is the agent surface. A stdio server any
  MCP client (Claude Code, Claude desktop, others) can launch.
  - **Tools:** every command and query becomes a tool automatically (name,
    description and JSON schema from the `CommandDef`), plus `frame.at`,
    `frames.sheet`, `ui.snapshot`, `export`, job status.
  - **Resources:** the project summary, timeline, transcript and command
    reference, so an agent can read state without calling tools.
  - **Notifications:** patches and session events ("the user selected this
    clip") stream to the client, replacing a `watch` command.
- **Live or headless:** with the app open, the MCP server connects over the
  unix socket and edits appear live on the timeline; with it closed, it loads
  the project headlessly and runs the same code (§7.1).
- **CLI: backlog.** A CLI would be another thin client of `core`; nothing in
  the design depends on it.

### Agent instructions, baked into the server (as hance does with its skill)
- The MCP server's **instructions** field carries the version-matched entry
  doc; workflow guides are exposed as **MCP prompts** and reference docs as
  **resources**. One binary, nothing to install separately.
- The command reference is **generated from the registry**, so a new feature's
  tools are documented for agents automatically.
- Workflows are written by hand: `rough-cut`, `zoom-pass`, `cursor-polish`,
  `captions`, `review`, `export`. Each follows hance's `refine` loop: act with
  `dryRun` → render frames → judge against intent → apply → repeat.

### In-app agent (later)
An agent panel in the app (like hance's AI adjustments tab) uses the same
commands and queries, so anything it does is visible on the timeline and
undoable in one step.

Decided with the user (2026-10-17), for a preview on its own branch:
- **Not a chat panel**: a prompt tied to what is selected ("zoom on each
  click", "cut the false starts"), from the command palette or the
  selection, whose run is shown as it goes and is one undo step ("Agent:
  <prompt>"), with Undo the Agent's Changes.
- **A real harness, not a hand-written tool loop**: Codex through its app
  server (JSON-RPC), connected to Beacon's own MCP server for the open
  project, so it has every command and query already. Behind a small
  adapter, so Claude Code can be added later (with an API key: Anthropic
  doesn't allow third-party apps to sign in with Pro or Max plans).
- **Sign in with ChatGPT**, which Codex's app server does itself (it keeps
  and refreshes the tokens; Beacon never holds a key). Fine for local use;
  a paid or hosted Beacon needs OpenAI's separate access process.
- **Codex pinned and bundled**, fetched and checksummed by the build like
  FFmpeg and Whisper, never run from PATH.
- Settings › General gets an Agent section: sign in, and the model.

---

## 8. Evaluation and rendering

### Scene primitives
`evaluate(project, t)` flattens the timeline at time `t` into:

```ts
type Primitive =
  | { kind: "video"; asset; mediaTime; transform; crop; opacity; passes }
  | { kind: "image"; asset; transform; crop; opacity; passes }
  | { kind: "solid"; color; rect; passes }
  | { kind: "sprite"; image; transform; opacity; passes }  // cursor
  | { kind: "backdrop"; rect; cornerRadius; invert; passes } // blur, pixelate,
                                     // spotlight: processes what's below it
  | { kind: "group"; children; transform; opacity; passes };
interface Scene { width; height; background; layers: Primitive[] }
```

- Animation blocks, groups, speed, ripple results and cursor smoothing are
  all resolved **here**, in TypeScript, once. Renderers never see clips.
- **Callouts and other text** are rasterized by the app (Canvas2D/Core Text)
  into cached images keyed by a hash of their params. Both renderers treat them
  as `image` primitives, which keeps text identical in preview and export.
- **Cursor:** the cursor feature's analyzer extracts the `.trec` cursor track,
  clicks and cursor images into `cache/`. Its evaluate hook applies
  smoothing/physics and click scaling and emits a `sprite` at the user-chosen
  size. Its passes add shadow and motion blur.
- **Motion blur (clips):** evaluate also emits each layer's transform at
  `t - shutter` (from the animation blocks), so the `motion-blur` pass can
  blur along the real motion path. Cursor motion blur uses the same pass with
  the cursor's velocity. One pass, two features.

### Passes
A `RenderPassDef` = WGSL file + entry point + uniform layout generated from the
effect's param schema. Preview and export are the same Rust renderer
(`beacon-render`, §3): the preview draws into the window's native view from
proxies while scrubbing and playing, decoded in process (`beacon-decode`,
natively through VideoToolbox for H.264/HEVC); export reads the originals
and encodes to ProRes/H.264/HEVC.

The Rust renderer has no per-effect code: adding a pass to the manifest is
enough.

### Export
`ExportService` walks frames, calls `evaluate`, streams Scene JSON to
`beacon-render` over stdin, and the sidecar pipes frames to the encoder.
Audio is mixed separately from the evaluated audio clips, then muxed.
Volume envelopes (fades, ducking) apply in both the
preview (Web Audio gain automation) and the export mix.

### Parity
A golden test renders the same frames through preview and export and fails if
they diverge beyond a small threshold.

---

## 9. Media pipeline

- **Importers** (registry) turn a file into an `Asset` with streams.
  - `.trec`: QuickTime container. Streams: `tscc2` screen (decodable by
    ffmpeg ≥ 7), H.264 camera, AAC audio. A custom `TSCM` box
    holds `DATA` chunks keyed by a 16-byte id. Verified on recorder 2026.2:
    - `…af2`: cursor positions, 16-byte records `<f64 seconds, i32 x, i32 y>`
      in screen points (~30 Hz).
    - `…af0`: mouse events, `<f64 seconds, u32 type>` (1 = down, 2 = up).
    - `…af1`: cursor images (PNG).
    - keyboard shortcuts, scroll wheel, focused app and window-title
      timelines, focused-window rects, devices — full reference in
      `docs/formats/trec.md`.
  - mp4/mov/png/jpg/mp3/m4a/wav via ffprobe.
- **Analyzers** produce derived data into `cache/`: proxy (HEVC through
  VideoToolbox, half size above 1920 px wide, 8 Mb/s screens and 5 Mb/s
  cameras; built Quietly or Fast, `docs/performance.md`), thumbnails, waveform peaks, cursor track, transcript.
  Analyzers are versioned so cache entries are rebuilt when they change.
- The `.trec` reader is fixture-tested against several real recordings and
  fails loudly on unknown layouts rather than guessing.

---

## 10. UI architecture

- React 19 + Tailwind, an editor layout: media bin / library / effects
  (left), canvas (centre), properties (right), timeline (bottom).
- **Panels are registered** (`PanelDef`), so features can add tabs.
- **Timeline** is drawn on a canvas (not DOM per clip) for performance, with a
  DOM overlay for handles and text editing. It reads the replica and emits
  commands only.
- **Canvas**: the selection, handles and snap guides are drawn by the native
  preview itself (no flicker); dragging emits `clip.set` commands coalesced
  into one undo step.
- **Inspector** is generated from schemas, with optional feature-provided
  sections.
- **Keymap:** `keymaps/default.json` maps key chords to command ids. A user
  override file is merged on top. Menus show the bound shortcut.
- **Copy/paste properties** is generic: copies a selected set of schema groups
  (transform, cursor, effects) from one clip and applies them to others as one
  transaction.
- **Command palette** (planned, Phase 8) lists every registered command, so
  nothing is reachable only by mouse.

---

## 11. Camtasia `.cmproj` import

`@beacon/camtasia` parses `project.tscproj` (ticks map 1:1) and builds tracks and
clips from core types. Each feature's `CamtasiaMapper` claims the
`_type`s and `effectName`s it understands (e.g. `cursor` claims
`CursorShadow`, `CursorMotionBlur`, `CursorPhysics`, `LeftClickScaling`).
`animations` claims `animationTracks`, `motion-blur` claims `MotionBlur`.
Unclaimed items are listed in an import report rather than dropped silently.

Known gaps to handle: animation tracks inside clips,
speed changes (`mediaDuration ≠ duration`), `StitchedMedia`, nested groups,
scenes beyond the first.

---

## 12. Testing

**End-to-end first; few unit tests.** Tests exercise the real product path on
real data rather than isolated functions.

1. **MCP-driven end-to-end tests (main harness, from Phase 3).** A test is a
   scenario run through the MCP server against real projects: run commands,
   then check results with queries (`project.describe`, `timeline.clips`) and
   rendered frames (`frame.at`) compared against reference images. With the
   app open, `ui.snapshot` checks UI state without touching the mouse. These
   run in the background and double as proof that agents can drive
   everything.
2. **Real-data checks per phase.** Phase 1: every `.trec` in `client-videos`
   reads with zero errors. Phase 2: re-render a real project headless and
   check its frames. Preview/export parity compares the same frames from both
   paths.
3. **A small set of unit tests**, only where bugs are silent and damage
   projects: command apply + undo returns the original document exactly,
   project migrations, ticks/frame maths.
4. **The UI harness** (`scripts/ui-harness/`, `bun run test:ui`): the
   editor UI in headless Chromium against a `LocalCore`, clicking, dragging
   and typing with no window; a flow is added when a UI feature lands. It
   doesn't show the native preview or WebKit's behaviour, so the app itself
   is still checked over MCP (`ui_snapshot`) and by the user.
5. **Computer-use visual tests (evenings).** Occasional "does it look and
   behave right" checks that drive the real app window with screenshots,
   clicks and keystrokes. They take over the screen, so they run in the
   evening when the user isn't working, with the display kept awake and the
   Mac unlocked. Never during work hours.

Chrome CDP doesn't reach the app: Electrobun uses the system WebKit view, so
the harness serves the same UI to headless Chromium instead.

---

## 13. Phases

Work is split into phases. Each phase ends at a **gate**: a decision point
with a concrete test. A phase only starts when the previous gate passes.
Headless automation (the #1 use case) lands **before** the UI, so the project
pays off even if the editor UI takes longer than planned.

### Phases 0–5 — done
Detailed logs of these phases are in the archived repository; what exists is
in `ARCHITECTURE.md`.

- **Phase 0 — spikes.** The preview in the webview, render throughput, the
  `.trec` layout across every recording, and the native GPU preview view.
- **Phase 1 — foundations (2026-10-06).** Workspaces, `@beacon/model`
  (ticks, schemas, migrations, commands with exact undo, feature registry),
  the strict `.trec` reader in `beacon-media`. `bun run dump-trec` reads all
  338 recordings with no errors.
- **Phase 2 — render engine (2026-10-07).** `evaluate` → Scene, the
  `beacon-render` compositor, the visual features and `.cmproj` import; a
  real project re-rendered headless looks right. Shaders stay out of
  `orva-kit` for now (`docs/shared-candidates.md`); callout text is
  rasterized with Core Text.
- **Phase 3 — headless automation (2026-10-08).** The `beacon-mcp` server:
  Claude Code rough-cut a raw recording from its transcript, zoomed and
  exported it with no app open. Transcripts are local whisper.cpp
  (`ggml-large-v3-turbo-q5_0`); tool names use underscores, command ids dots;
  one project per MCP session, saved after every change; command times are
  seconds snapped to frames; derived data is cached globally
  (`~/Library/Caches/Beacon/derived`); import fits each stream to the canvas.
- **Phase 4 — editor shell (2026-10-08).** Electrobun 2.0.2 with a Bun main
  process; the native preview and the HTML share one window through
  `<electrobun-wgpu>`; newline-delimited JSON-RPC over a unix socket so the
  MCP server drives the open app (`RemoteCore`); app state (selection,
  playhead, panels) lives in the model so agents can drive it.
- **Phase 5 — editing (closed 2026-10-12, v0.1.0).** In four parts, each
  gated by the user's own run in the app:
  - *5a timeline editing:* select, move, trim, split, ripple delete,
    cut/copy/paste; a recording's clips select one by one in the editor
    while agents' commands include linked clips (changed 2026-10-13, the
    user: linked clips select and edit together in the editor too, as in
    DaVinci, with Unlink to separate them; only a recording's camera and
    audio are linked, never its screen and camera); a drag is one command sent
    on release, drawn as a ghost from the same maths (`model/edit.ts`);
    drops over other media are refused, magnetic tracks make room.
  - *5b properties and canvas:* edits apply at the playhead (the animation
    block in effect there, else the base value); drags coalesce into one undo
    step; canvas handles, ⌥-drag crops; Copy Properties copies everything;
    panel items drag onto media.
  - *5c animations and audio:* animation blocks drawn on clips, ⇧A custom
    animation and Restore; audio points, 1 s fades, silence and restore.
  - *5d groups and stitching:* grouping keeps the picture, an open group is
    an edit scope, stitched media is its own clip type.
  - *5e hardening:* an architecture review's bugs and structure fixes, then
    the Media Bin, Finder drops, J/K/L shuttle, the Export dialog and
    Settings, colour-accurate export tagging, crisp vector cursors, loudness
    levelling, Clip Speed, X/Y tilt, the Media Bin preview, text edited in
    place, and the headless UI suite (`bun run test:ui`).

### Phase 5.5 — Design overhaul
A new look for the editor, decided 2026-10-10: the overhaul comes after
Phase 5's behaviour is settled and before the recorder, whose screens are then
built in the new design. Mostly token values and the shared components
(5e's design tokens come first); layout changes are design work in the
components. Starts when the user says go.
**Started 2026-10-12.** The user's direction: modern and futuristic, green on
dark grey, like CapCut and the Dribbble concept "Online video editor concept
VisionX" (shots/23126679); tokens and shared controls, the layout
kept. First pass
(rehearsed offscreen, waiting for the user's look in the app): graphite
surfaces with one electric green accent (`#3ee68d`); Space Grotesk (Geist
from 2026-10-13, the user's choice); corner
tokens (`--radius-*`, `--radius-panel`) and panels as rounded cards with a
6 px gutter (`panel-card`); filled fields without outlines, pill rail
items, an accent-underlined tab, a `primary` button look (Export, Create,
Done); the canvas selection white. Timeline clips coloured by kind (the
user, 2026-10-12): screen recordings and imported video and images green,
a recording's camera blue (the user's change), audio orange, annotations purple, groups neutral; what is applied to a clip yellow (the fx badge and animations); a
stitched clip takes its pieces' colour. After the user's run (2026-10-12):
an icon-only left rail (names in tooltips); green snap lines (the canvas
guides, and a line at the snap point while dragging on the timeline); ⌘S
flashes "✓ Saved automatically" (no dialog); Elevation gone from the
cursor's properties; a trash icon instead of "•••" when Remove is the only
action; mute, lock and eye on every track; a track shows its name only when it has one (else a faint number), and the headers are 100 px wide until one does (156 px); Project Settings and New Project by shape (Landscape / Square / Portrait tabs, then that shape's sizes), Width × Height with a padlock between them, "Background Color"; dialogs centred both ways (only the panel masked out of the native canvas, so the canvas stays visible; the window pinned against WebKit scrolling it to a focused panel), with an 18 px title and a larger close button (`ModalHeader`, `BACKDROP`, `SHEET` in `controls/modal.tsx`), labels without colons; animations drawn as two keyframe diamonds joined by a solid yellow band (the user's sketch), the diamond clicked red; Phosphor icons everywhere (`Icon`, `drawIcon`, `scripts/icons.ts`), filled while active; properties tabs spread across the panel, names on hover; dials with a green pointer, no colons or bold labels left; the Media Bin titled "Media", ⌫ on a selected item deletes it; annotation clips labelled by what they are (a text callout's text, Shape, Blur…); colour values in effects get a colour swatch (Drop Shadow's colour); right-click on the canvas: the clip's menu (plus Project Settings… and Zoom to Fit) over a clip, else Project Settings…, Paste, Zoom to Fit, and the webview's Reload/Inspect menu suppressed outside text fields; a `.cmproj`'s unnamed tracks imported unnamed ("Track N" names already stored are shown as numbers); a shared `TrashButton`; moved or deleted media shows
Missing on its Media Bin tile, builds no proxy (the raw ffmpeg error the user
saw), and Locate Media… in its menu relinks it (`core.relink`, refused unless
it is the same media; MCP `media_missing`, `media_relink`).
2026-10-13 (the user): the playhead is one colour, a thin white line under a
small pin (as CapCut, Premiere and Resolve), without Camtasia's green/red
handles; an in/out range (I/O, ⌘-drag) is a band on the ruler whose edges
drag there. A proxy is a "P" badge at a Media Bin tile's top right. The
properties panel drops the clip's name; effects have their own fx tab
(selecting an effect opens it); the cursor tab has a macOS-style pointer
(a custom icon beside Phosphor's); Position has no Z; rotation is a gizmo,
three rings seen slightly from above (X red, Y green, Z blue) with a card
showing the clip's orientation, plus a number box per axis. The transport
is centred, the Media Bin says "Sort", and dragging an audio clip's volume
line shows its level as a percentage. Audio's waveform is drawn at the level
it plays (boost × the volume line, so fades taper); the Audio tab has Volume
(the line's level at the playhead) and Boost (the `gain` prop, up to 500%,
renamed in the UI only); the volume line stays a line. Clip Speed is its own
tab (not an effect: it is the clip's timing), shown once the speed is changed
or Clip Speed is chosen. A tilted (X/Y rotation) clip's effects run on the
flat clip, which is then drawn in perspective (the CRT was sheared and cut
off). The Media Bin (the user: less like Camtasia, never grouped by type)
has no title or type groups: a search field, All/Video/Audio/Images chips,
one sort menu (each sort with its direction), grid or list, an Import tile
first, and tiles showing the picture with its duration and kind, a P for a
proxy and a check for media on the timeline (`ui/src/media-bin.tsx`).
Snapshot saves to the project's media folder or a folder set in Settings >
General > Save Snapshots To (`captureFrame`'s `folder`, MCP `frame_capture`
too; checked as any write, never inside a project), and says so in a toast
with Show in Finder, as a finished export does (the shared `Toast`). A
muted track's audio is drawn silent (faded, waveform flat) and its header
speaker turns orange; muting is for quick listens (the user), so the Export
dialog warns when a muted track has audio, with Unmute.
Reviewed 2026-10-12 (PR #6): cancelling a job starts no more processes (a
cancelled proxy build used to restart in software); native decoding asks for
4:2:0 and reports decode errors; Settings and Export use `Modal`, with one
`SettingsRow` and `TextInput`; tokens alias the colour they repeat, one green,
type sizes as tokens (`text-caption`, `-label`, `-body`, `-title`); effect
colours marked in their schema (`RgbaSchema`). Checked in the app over MCP
(preview, timeline, effects, proxy cancel); the dialogs over the native
canvas are the user's to check.
**Closed 2026-10-13** (the user: finished for now, with things to add later).

### Phase 6 — Recorder
A native recorder: a small window
with four sources, each toggled and picked from its devices, and a rec
button with a countdown.
- **Screen:** ScreenCaptureKit, display choice and frame rate (up to 60),
  hardware encoding, recorded **without** the cursor (Beacon draws its
  own).
- **System audio:** ScreenCaptureKit (no virtual audio driver).
- **Camera and microphone:** AVFoundation.
- **Cursor log:** positions, button events and cursor images while
  recording, as `.trec` stores them (`docs/formats/trec.md`), so the
  cursor feature, smoothing and later auto-zoom work unchanged. Keystrokes
  later (they need the Input Monitoring permission).
- **Output:** a `.brec` folder per take (Beacon recording; named 2026-10-13, not `.trec`, which is TechSmith's), one file per stream plus a JSON
  data file, imported like a `.trec` (linked Screen, Camera and Audio
  clips). `.trec` is not written.
- Native capture lives in the engine (Rust over the macOS frameworks
  through objc2) as a recording sidecar, so a long take survives a UI
  crash; the UI and agents drive it through `recorder.*` commands. A short
  spike first proves ScreenCaptureKit and AVFoundation through objc2; if
  their callbacks prove too awkward there, the sidecar is written in Swift
  instead (same JSON-lines protocol, nothing else changes).
- Later, if used: region and window capture, pause/resume.
Risks: keeping four sources in sync over long takes; macOS permissions
(Screen Recording, Camera, Microphone).

**Spike (2026-10-13): objc2 works; no Swift fallback needed.** The
`beacon-record` crate (`beacon-recorder devices`, `beacon-recorder spike
<dir> [seconds]`) captures through objc2 0.6.5 and the 0.3.2 framework
crates: ScreenCaptureKit for the screen (3600×2338, no cursor, up to 60 fps)
and system audio (48 kHz stereo), AVFoundation for the camera and microphone,
each sample buffer appended to its own `AVAssetWriter` (HEVC in hardware)
as it arrives. The callbacks were not awkward: `define_class!` gives an
`SCStreamOutput` and an AVCapture sample-buffer delegate in ~20 lines each,
completion handlers are `RcBlock`s waited on with a channel, and buffers go
straight from the callback to the writer with no copy. Run with the Mac
locked (the user away), so the screen was the lock screen and the camera
was skipped (its permission was never asked; asking shows a prompt).
- **One clock.** Both frameworks stamp buffers with the host clock
  (`SCStream.synchronizationClock` and the capture session's read 2-4 µs
  from `CMClockGetHostTimeClock`, the time between the reads), so streams
  are aligned by their timestamps: each file starts at its first sample after
  the take began, and its start is kept in the data file.
- **Sync across the frameworks, measured:** a tone played every 20 s of a
  2-minute take, heard by ScreenCaptureKit's system audio and by
  AVFoundation's microphone through the speakers: the microphone is 25.0,
  25.0, 25.0, 25.2, 25.1 ms behind, constant (the speakers' output latency,
  not drift). No buffer dropped (224 screen frames, 6,000 + 11,254 audio
  buffers); buffers arrive 12 ms (microphone) and 55 ms (system audio) after
  their timestamps.
- **Audio as PCM, not AAC.** `AVAssetWriter`'s AAC is read by FFmpeg (our
  decoder and mixer) 44.0 ms late (its priming edit; same in every take), and
  a crash leaves an unreadable `.m4a`. PCM `.wav` is sample-exact and
  survives a crash; 16-bit 48 kHz stereo is ~0.7 GB an hour, small beside the
  screen. (`.wav` caps at 4 GB, ~6 h of stereo; `.caf` past that if needed.)
- **Video as fragmented MPEG-4.** Killed with `kill -9` 9 s into a take: a
  fragmented `.mp4` (`movieFragmentInterval` 2 s) still reads to 8.0 s; a
  QuickTime `.mov` is never fragmented by `AVAssetWriter` (asked, it writes a
  plain movie) and is unreadable after a crash, as is the AAC. Files decode
  with `beacon-decode` as recorded.
- **Sparse screen frames**, like tscc2: ScreenCaptureKit sends a frame only
  when the screen changes (439 of 481 callbacks idle on a still screen). A
  fragmented file ends at its last frame, not at the take's end, so the take's
  length goes in the data file (or the last frame is appended again at stop).
- **Permissions** are read without prompting (`CGPreflightScreenCaptureAccess`,
  `authorizationStatusForMediaType`); ScreenCaptureKit lists no displays while
  the display sleeps.
- Not yet checked (needs the Mac unlocked and the camera allowed): the screen
  against the audio with a visible flash, and the camera against the
  microphone. Both pairs share their framework's clock, as the two audio
  streams did.
**Steps (2026-10-13):** (1) the recorder process and `.brec` takes; (2) the
cursor log; (3) importing `.brec` as linked clips; (4) the recorder window and
`recorder.*` commands; (5) the gate.

**1. The recorder process (2026-10-13).** `beacon-recorder serve` takes one
JSON command per stdin line (`devices`, `access`, `start`, `status`, `stop`)
and answers with one JSON event per stdout line; `record <dir> [seconds]
[--tones]` does the same from the command line (it replaces `spike`). A take
is a `.brec` folder (`docs/formats/brec.md`): `screen.mp4` (HEVC, fragmented),
`camera.mp4`, `system-audio.wav`, `microphone.wav` and `recording.json`, the
data file, written when the take starts and again when it stops. Every file is
opened before capture starts, so a refused source leaves nothing running or
behind. Checked on this Mac: a take's streams start within 19 ms of it, no
buffer dropped, no audio drift; stdin closing mid-take (the app quit or
crashed) stops the take and finishes every file; `kill -9` mid-take leaves
the screen readable to its last 2 s fragment, the WAVs to the kill, and
`recording.json` saying `complete: false`. The camera (1920×1080 at
30 fps, HEVC) uses its own encoder settings: AVFoundation recommends none for
this Mac's camera. A camera's first frame comes about 0.5 s after it starts, so
a take begins once the camera and microphone deliver (up to 3 s), and every
stream starts within 35 ms of it. The app will need
`NSCameraUsageDescription` and `NSMicrophoneUsageDescription` in its
Info.plist for `access` (step 4). **Sync, measured (2026-10-13):** a video flashing white with a 1 kHz beep
every 2 s, played full screen by QuickTime through the Mac's speakers while
recording screen, system audio, camera and the built-in microphone; each
stream's events at its `start` plus the time in its file, the same at all five
flashes to 1 ms: system audio 9.064 s, screen 9.058 s (6 ms before it, under
one 60 fps frame), microphone 9.090 s (26 ms after the system audio: the
speakers and the air, as the spike's 25 ms), camera first lit at 9.089 s and
fully at 9.123 s (30 fps, so within one frame of the microphone). Lined up by
their timestamps the streams need no correction: the camera's picture is at
most a frame behind its sound, inside what viewers notice (sound leading by
over ~45 ms). The display's and camera's own delays can't be told apart this
way, nor any better than a camera frame.

**2. The cursor log (2026-10-13).** A take recording the screen writes
`cursor.jsonl` and a `cursor-N.png` per image (`docs/formats/brec.md`):
positions and buttons polled about 100 times a second through CoreGraphics
(no permission), images through `NSCursor.currentSystemCursor` (deprecated,
the only public way, working on macOS 26 without registering as an app),
`.trec`'s button codes. Checked against a probe reading every input API side
by side: the same 12 left clicks at the same times, 2 right clicks, and the
arrow, I-beam and hand. macOS's large-cursor setting enlarges the arrow and
I-beam images (28×40 points) but not the hand (32×32): step 3 draws them at
their own sizes.

**3. Importing a take (2026-10-13).** A `.brec` imports as one recording asset
(the folder), as a `.trec` does: one Media Bin item, its clips stacked and
linked the same way (`docs/formats/brec.md`). Everything that opens a stream
(the renderer's video and audio, proxies, waveforms, transcripts, loudness,
thumbnails) goes through `streamSource`, since a take keeps each stream in its
own file. Each clip starts into its file by how much later the latest stream
began, so all show the same moment (checked: the screen 4.0 ms in, the camera
12.4 ms, the system audio 2.2 ms); a stream's `offset` from the sync check
will move it the same way. The cursor is drawn from the take's PNGs at the
logged positions (checked in rendered frames: the arrow's tip and the I-beam's
middle on the logged point). Drag and drop takes a `.brec` folder.

**4. Recording from the app and agents (2026-10-13, under way).** Core
records (`recorderDevices`, `recorderAccess`, `recordStart`, `recordStatus`,
`recordStop`), over the app's socket too, through one `beacon-recorder serve`
sidecar (`Recorder` in `@beacon/media`); MCP has `recorder_*` tools. A take
goes in the project's `recordings/<date time>.brec`, and stopping imports it
into the project it was started for; closing that project stops and imports it
first. Checked headless: a 3 s take started (about 0.5 s while the sources
warm up), refused a second start, reported its status, stopped and imported as
linked clips with its cursor. Info.plist gets the camera and microphone usage
strings and declares `.brec` a package (`dev.beacon.recording`): Electrobun's
config can't, and Hutch's build doesn't run `postWrap`, so `bun run build`
patches the built bundle and a dev bundle patches itself at startup
(`src/bun/info-plist.ts`). File › Record… (⌘R; the user chose
2026-10-13: a dialog in the editor, Beacon hidden while recording, the take at
the end of the timeline) lists each source with a checkbox and its device
(display and frame rate, camera, microphone, system audio), the last ones used
remembered, and a refused permission's place in System Settings under it.
Record counts down 3-2-1, asks for the camera or microphone permission if
needed while the window is up, hides Beacon and starts; a menu-bar item shows
● and the time with Stop Recording, as ⌘⇧2 does anywhere; stopping imports the
take and brings Beacon back. Checkboxes and radio buttons are green
(`accent-color`), not WebKit's blue. Run in the app by the user (2026-10-13):
recording, hiding, the menu-bar item and ⌘⇧2 worked, and the camera prompt
came up with the new usage string. Editing the take, its camera vanished once
its proxy was deleted: AVFoundation's camera encoder writes open-GOP HEVC
(CRA keyframes with leading pictures that reference frames before them), and
the preview's native VideoToolbox decoding failed every seek on them where
FFmpeg drops them. After a seek it now starts at the keyframe and skips
what's shown before it (`shim.c`; `matches_ffmpeg.rs` seeks into a camera
take). The dialog previews every source
(2026-10-14, the user's choice after looking at Screen Studio, Loom and OBS):
the display (480 wide, 5 fps) beside the camera (320 wide, 30 fps) at the top,
the microphone's and system audio's levels as meters with a held peak on their
rows. `beacon-recorder serve`'s `preview` runs capture that writes nothing;
only sources Beacon may already use are previewed (asking waits for Record).
Under each preview, the size and rate a take records it at (as Camtasia shows
on its camera): the display's points by its backing scale, the camera's active
format, both reported by `devices`.
While a take records, a small panel floats top right over the screen (the
time, Stop, and both levels as rolling waveforms), left out of
the take: ScreenCaptureKit's filter excludes the window by its title. The take
feeds it (`start` with `monitor`): the microphone's level from its
connection, the system audio's from its buffers, so nothing opens the devices
a second time mid-take. It showed the camera too until 2026-10-14: at 15 fps
and 320 wide, JPEG-encoded in the camera's own callback, it looked choppy to
the user and cost the take, and the Record dialog already shows the camera
before it starts, so it went (the user's choice). The dialog's previews are
pulled, not pushed (`recordFrames` answers with the newest once there is
one): pushed, a busy page fell behind and showed the camera late. A chip per
source recorded sits under the time (2026-10-14, the user's choice, kept
minimal): its dot turns red once nothing has arrived from it for 2 s (an idle
screen's empty frames count) or its writer failed, from `live` in the take's
level events. The camera's turns amber while its picture is black (every sample of a
32×18 glance, four a second, under 24 of 255 for a second) or frozen (the same
glance for 1.5 s: a live camera's noise always changes some of it), as a card
that loses its camera sends (2026-10-14, after the 5 s of black below). After a take, Beacon offers to name it (the media
item and its clips; the folder keeps its date and time). The panel has a grip
to drag it by and – to hide it to the menu-bar item, whose menu shows it again.
Check Sync (2026-10-14): Settings ›
Recording (a camera and microphone, their delay typed or measured) and the
Record dialog's Sync row run it. A black window covers the display and
flashes white six times, 1.5 s apart, each with a 1 kHz beep played by
`afplay`, while a take of the screen, system audio, camera and microphone
records into the cache (`recordSyncCheck`); `measureSync` (`@beacon/media`)
finds each flash's brightening (halfway up, between camera frames by straight
line) and each beep's start (1 kHz energy in 2 ms steps), and takes the median
over flashes of (camera - microphone) - (screen - system audio): the second
term is how far apart Beacon fired the flash and the beep, so they needn't fire
together. Left over: the display's and speakers' own delays, a few ms. On a
made-up take with the camera 110 ms late it measured 121 ms (a 30 fps camera
sees a frame every 33 ms). The delay is saved per pair in the app's settings,
and a take recorded with the pair gets the camera's `offset` (minus it) in
`recording.json`. Its dialog says what to do first (sit where you record facing the
screen that flashes, stay still and quiet) and shows the camera being
measured, its microphone's level, a test beep (heard when the microphone's
peak passes -35 dBFS) and the display to flash; Beacon raises the Mac's
volume to at least 75% and unmutes it for the beeps, then puts it back. No
clap: the flash and beep are the clap, found to the millisecond. The beeps
play through speakers the room hears: the recorder lists the Mac's sound
outputs through CoreAudio (Bluetooth, wired headphones in the jack, a USB
microphone's own headphone jack and virtual devices don't count) and, when
the sound goes to headphones, the check switches the output to the Mac's
speakers for its beeps and back after. Run by the user (2026-10-14) with the
Elgato Cam Link 4K and the Blue Yeti: 244 ms (3 flashes within 140 ms), and a
take recorded with it lined up. The check is arithmetic on pixels and samples,
no AI. Drift (2026-10-14): a 10.5-minute take with the Cam Link and the Yeti
showed none to the user's eye and ear at its end; its `driftPpm` reads 0, but
that compares the Yeti's samples with timestamps macOS derives from the same
device, so only a look at a take's end can tell. The same take is black for 5 s
at 4:08: the Cam Link kept sending 30 fps, but each frame was black (16 KB a
second against 1.2 MB), so the card lost its picture (the camera's HDMI, or
Camera Hub, open at the time); the chips' amber camera now flags it.

**After the first in-app run (2026-10-13, the user).** Proxies are off by
default (Settings › General turns them on; the preview reads originals in
process). Corner Rounding's radius, Drop Shadow's offset and blur and Motion
Blur's intensity have sliders. An effect's on/off is a tick box in its
header, as its other options are, not Camtasia's green pill switch. Drop
Shadow's angle shows in degrees and its opacity as a percentage (stored as
radians and a fraction, as before). A linked clip's chain is drawn in its top-left
corner on a dark badge (it sat after a video's thumbnail, out of line with its
audio's). Hovering a Media Bin tile scrubs it (2026-10-14), as other editors
do: a line and the time under the pointer, and for video the frame there, from
30 frames across it fetched as it is hovered (under the pointer first) and
cached on disk with the bin's thumbnails.

**Device delays (decided 2026-10-13).** A camera through a capture card (the
user's Elgato) arrives late by the camera's and card's processing, often
50–150 ms, which no API reports and which differs per camera, so Beacon
measures it on the user's own setup rather than shipping a table: a sync check
in the recorder runs the flash-and-beep test above for a camera and microphone
pair (about 10 s; the speakers on, the camera seeing the screen's light),
saves the offset per pair, and writes it into each take's `recording.json`;
importing a take (step 3) moves the camera clip by it, so nothing is
re-encoded and it stays adjustable. Without a check, a manual offset per
device does the same. The check is run from Settings › Recording ("Check
Sync…", for the chosen camera and microphone, showing and saving the result)
and from the recorder window's menu. It replaces the user's `cuca` (a live
virtual microphone delaying the real one by a fixed 150 ms through VB-Cable so
Camtasia's takes line up): moving the camera earlier fixes lip sync and keeps
the voice in step with the screen, where delaying the microphone makes it late
against the screen; and nothing runs live while recording. When the capture card also carries the camera's own
audio (HDMI), matching that against the microphone's waveform gives the offset
from ordinary speech, with no test (the user's Cam Link 4K does offer one, as a
microphone named after it, seen 2026-10-14). Camtasia has neither: its only fix is moving the clip by hand.
A clap test is the fallback when the speakers can't be used; estimating sync from lip movement is for the AI features after Phase 6.
To check with the user's setup (Blue Yeti, Elgato): the offset, and a long
take's `driftPpm` (a USB microphone keeps its own clock).

**Gate:** record a video with screen, camera, mic and system audio, then edit
and export it in Beacon alone. **Passed 2026-10-15** (a 7:22 take, 6:49 after
Remove Silences, exported to 1080p H.264). The run turned up, all fixed:
screens recorded at 6K kept the encoder flat out (the 4K camera dropped 8% of
its frames, the Mac ran hot), so screens now record at 4K at most; the
recorder didn't see devices unplugged and plugged back (its run loop never
ran), and a take recorded without a chosen camera or microphone that sent
nothing; the Record dialog's lists didn't follow displays coming and going;
the title bar didn't drag the window; a trimmed clip's fx badge stayed at
the old end. macOS's Edge Light (a ring of light on the screen in dim rooms)
turns on for any app using the camera: Control Center › Video Effects.

### After the Phase 6 gate: projects you can move and share (decided 2026-10-15)
Today every asset is an absolute path, even a take in the project's own
`recordings/`, so a `.beproj` copied in Finder or to another Mac loses its
media until relinked (renaming from the title bar rewrites the paths).
1. **Paths inside the project are stored relative to it** (a migration for
   existing projects), so a copied or moved project keeps working.
2. **Standalone projects**, as Camtasia's "Create standalone project": a
   project setting, offered as a checkbox in New Project and in Save As.
   While it is on, every import is copied into the project's `media/` as it
   comes in, and turning it on (or Save As with it ticked) copies what is
   already outside. Off, imports are referenced where they are, as now.
   Proxies and transcripts stay in the cache and are rebuilt on another Mac.
3. **File › Save As…**: a copy under a new name, then opened; its recordings
   come with it, and outside media too when standalone.
4. **File › Show in Finder** for the project.
Agents get each as a command. Then Phase 6.5.
**Done 2026-10-15** (`phase-6.5`): schema 2 stores media inside the project
relative to it; standalone is `project.settings.set { standalone }` (it
copies, as clones on APFS, keeping file times so fingerprints match and
transcripts carry over); `project_saveAs` and `project_reveal` for agents.

### Phase 6.5 — A self-contained app (decided 2026-10-12)
One downloadable, signed `.app` that works on a Mac with nothing installed:
today Beacon runs `ffmpeg`, `ffprobe` and `whisper-cli` from the user's
PATH (decoding for preview and export, proxies, thumbnails, probing, the
audio mix, speed and loudness, muxing, transcription audio).
1. **Bundle a minimal FFmpeg** (and ffprobe) inside the app: only the
   decoders, encoders, formats and filters used (TSC2, H.264/HEVC/ProRes,
   AAC; VideoToolbox encoding; MP4/MOV/GIF/WebM; the audio filters in use),
   built **without GPL parts** (no x264: encoding is VideoToolbox), so LGPL,
   shipped as a separate executable. `runTool`/`spawn` and the engine's
   `Command::new` use the bundled path. `whisper-cli` bundled the same way;
   its model is not in the download (decided 2026-10-12): the first
   transcript opens a modal that says what it needs (`large-v3-turbo`, about
   550 MB, local and offline) and downloads it only when the user accepts,
   with progress; declined, everything but transcripts still works. Agents get
   the same as a command and a job. Apple's on-device transcriber (macOS 26) is
   worth a spike against it: no download at all, if accurate enough on
   technical words. Everything signed (hardened runtime) and notarized with
   the app.
2. **Decode in-process**: done for the preview on `perf` (2026-10-12):
   `beacon-decode` over FFmpeg's libraries, natively through VideoToolbox for
   H.264/HEVC, frames kept for steps back. Left for this phase: VideoToolbox for H.264/HEVC/ProRes and FFmpeg's TSC2 decoder
   linked into the engine (or a port; the `.trec` screen codec has no Apple
   decoder, so FFmpeg can't go entirely), instead of a process and a seek per
   source per jump, which is much of why jumps on the benchmark project take ~0.5 s.
   Export through AVAssetWriter for MP4/MOV; FFmpeg kept for GIF/WebM and
   the audio filters (not worth rewriting).
Export speed (measured 2026-10-15 on the gate project, M5 Pro): 20 s of a
6720×3780 screen and a 4K camera export in 13.7 s (about 1.5× real time; the
user finds Camtasia much quicker). Decoding (ffmpeg processes and CPU RGBA
conversion) is 55% of it, drawing and readback 18%, upload 10%; only the
H.264 encode is hardware. Camtasia links Metal, IOSurface, VideoToolbox and
AVFoundation, the usual pipeline with frames kept on the GPU throughout.
So export moves to the preview's in-process decoders (with a parity test
against today's frames), then zero copy both ways: VideoToolbox frames into
textures, and the composited texture straight to the encoder, no readback.
Performance research (2026-10-12, `docs/performance.md`): the user wants
fast playback and scrubbing, done in Rust and
Apple's frameworks. Its order: a benchmark first, then all-intra scrub
proxies, item 2's in-process decoders kept open (a small pool per source),
zero-copy VideoToolbox frames into wgpu, prefetch ahead with a small frame
cache, and audio start. When it starts is the user's call.
3. **Releases** (decided 2026-10-15): Apple silicon only, no Intel, Linux or
   `install.sh`. A `v0.x.y` tag builds `beacon-macos-arm64.dmg` and
   `checksums.txt` onto a GitHub release, as Hance does. The app carries
   `beacon-mcp`, so agents get the tools without the repo. The README's
   install steps end with a copyable prompt for an AI agent: download the DMG,
   copy the app to Applications, clear the quarantine flag (`xattr -dr
   com.apple.quarantine`, dropped once notarized), add the MCP server with
   `claude mcp add`, and open the app. Signing matters beyond Gatekeeper: an
   unsigned build is a new app to macOS each version, so screen, camera and
   microphone permissions would be asked again after every update.
**Progress (2026-10-15, `phase-6.5`, paused at the weekly usage limit):**
step 0 done; step 1 done (own LGPL FFmpeg 7.1.3 + whisper-cli 1.9.2 bundled,
model downloaded on consent, Apple transcriber spike in
`docs/transcription-spike.md`); step 2: export decodes natively and zero copy
into the GPU (20 s of the gate project: 13.9 s → 4.9 s, 1.44× → 4.1× real
time). Fast export finished 2026-10-15: the native encoder (`encode.rs`)
keeps three frames in flight, has a parity test against ffmpeg's output
(H.264, HEVC, ProRes, size, frame rate) and is the default
(`BEACON_ENCODE_FFMPEG=1` for the old path), and the audio is mixed while the
video renders: 20 s in 3.45 s (5.8× real time), now bound by decoding. Step 3
built 2026-10-15: `bun run --cwd packages/desktop package` makes the DMG (Electrobun's
stable build: a self-extracting wrapper that unpacks the app in place on first
launch), with beacon-mcp compiled into the app's engine folder; `build-hook.ts`
writes the Info.plist entries and signs both apps ad hoc (the packed app is
unpacked, signed and packed again, since Electrobun writes its version.json
after postBuild); `scripts/check-release.ts` checks a DMG as a bare Mac would
see it; `.github/workflows/release.yml` builds, checks and publishes on a tag
(and builds and checks on pull requests that change it); unsigned for now (see Signing
below). Released as v0.2.1 and v0.3.0 (in-app updates from 0.4.0). The gate
run passed 2026-10-19; the transcriber choice below moved to Phase 7 (2026-10-15).
**Transcriber choice (decided 2026-10-15):** Settings › General › Transcripts
picks the transcriber: Whisper on this Mac (default; the model download as
now), Apple's on-device transcriber (macOS 26 SpeechTranscriber: no download,
about 8× faster, weaker on technical words: `docs/transcription-spike.md`), or
Whisper through OpenAI's API with the user's own API key (stored in the macOS
Keychain, never in a project or settings file; the dialog says plainly that
the audio is uploaded to OpenAI). Word timings must be good enough for Remove
Silences in each (check Apple's and the API's against local Whisper's DTW
times on the fixtures; for the API, use a model that returns word
timestamps). Choosing Apple or the API never asks to download the model.
Agents get the same as a setting/command. The transcript cache key includes
the transcriber.
**Updates (the user, 2026-10-15, after installing v0.3.0):** in the app, not
only by reinstalling: Beacon › Check for Updates…, and a quiet check a little
after launch, through Electrobun's updater (`release.baseUrl` is the latest
GitHub release's download URL; each release carries
`stable-macos-arm64-update.json` and the signed packed app, checked by
`check-release.ts`); Update and Restart downloads, saves projects and swaps the
app in place, with no quarantine to clear. The README keeps an update prompt
for agents. No delta patches (they'd be made by downloading the previous
release). First visible from 0.4.0 to 0.4.1.
**Signing (decided 2026-10-15):** no Apple Developer ID yet. Releases are
ad-hoc signed and not notarized; the README's install prompt keeps the
`xattr -dr com.apple.quarantine` step and says macOS will ask again for
screen, camera and microphone permission after each update. Hardened runtime
and notarization are added once the user has a Developer ID.
**Gate:** the app, copied to a Mac without Homebrew or FFmpeg, opens a
`.cmproj` and a `.trec`, edits, plays, transcribes and exports MP4 and GIF.
**Passed 2026-10-19** (the user, by hand).

### Phases 7 and on (split 2026-10-15)
Phase 7 was one list of everything next ("Growth"); the user split it by
theme, each with a gate, as the earlier phases had. Each feature is a folder
in `packages/features` where it can be (§6: the checklist passes with no core
changes); each phase ends with a minor release.

### Phase 7 — Transcript tools
Making the transcript do the editing.
- **Transcriber choice** (carried over from Phase 6.5, where it is described:
  Whisper on this Mac, Apple's on-device transcriber, or OpenAI's API with the
  key in the Keychain; Settings, a command, the transcriber in the cache key,
  word timings checked against local Whisper). First, because which
  transcribers keep "um" decides how Remove Filler Words works.
- **Remove Silences, one click** (done; the user, 2026-10-14; the first AI feature;
  built the same day, before the Phase 6 gate, as below except the timeline
  marks): it was agents only (`transcript_removePauses`
  over MCP); the transcript itself is already made locally by whisper.cpp
  when speech is imported. A button and menu item (Edit › Remove Silences…)
  opens a small dialog: what it found (e.g. "42 silences, 3:12 shorter") and
  two settings (shortest silence to cut, pause to keep), the silences marked on
  the timeline while it is open, then Remove as one undo step through the same
  `transcript.removePauses` command. A silence can be screen action worth
  keeping (typing, clicking): Beacon's own takes log clicks, cursor movement
  and which screen frames changed, so silences with that activity are kept by
  default (a tick box), the cheap stand-in for an agent looking at frames.
  Waits for the transcript job if it is still running. Retakes and filler words
  stay with agents (MCP; retakes get their own review in Phase 9), where judgement is needed. As built: an **AI** panel
  in the left sidebar, not the Edit menu (the user's choice: it is the home for
  later AI features), nor Audio Effects (those are dragged onto one clip; this
  edits the whole timeline). Its tile opens a **review**, not a dialog (the
  user's choice, 2026-10-14: a dialog was one-shot and showed nothing on the
  timeline): the properties panel shows the settings and a summary, the
  timeline marks each silence red (cut) or grey (kept) live, a click on one
  flips it, and Apply cuts as one undo step (Cancel cuts nothing). The review
  is editor state (`session.features.transcript.silences`, through
  `silences.review`/`flip`/`close` and the `silences.apply` action), so an
  agent can prepare it for the user to look over; features got their own
  session state and session commands for it (`Feature.sessionCommands`). Not
  live after Apply (re-cutting under later edits would move them); the media is
  untouched, so a clip edge dragged back restores a pause. The
  `transcript.silences` query says what would be cut (the same ranges the
  command removes, to the frame); screen action is the recording's cursor
  moving over 24 points or clicking during the silence (typing alone isn't
  seen yet: screen frames changing would catch it); a missing transcript
  (an import whose app quit first) is started by the review. Checked on a
  3:37 recording: 35 silences, 11 kept for screen action, 1:10 shorter.
  It reads the timeline as edited, not the sources: each clip's speech
  through its window, placed where the clip now sits, so a silence that
  ends one clip and one that starts the next are one silence across the
  cut, judged by their total length. Opened again after editing, it finds
  the silences the edits made (the user asked, 2026-10-19).
- **Remove Filler Words** (the user, 2026-10-15, after trying v0.2.1's Remove
  Silences): "um", "uh" and the like, found in the transcript and cut, in the
  AI panel beside Remove Silences and reviewed the same way (each marked on the
  timeline, a click flips one, Apply cuts as one undo step; an agent can
  prepare it). The catch: Whisper tends to leave fillers out of its
  transcript, so first check, on the fixtures, whether priming it with a
  prompt full of fillers keeps them with good word times, and what Apple's
  transcriber and the API do (after the transcriber choice). Until then agents
  cut what the transcript has with `transcript_cut`.
- **Captions** (the user, 2026-10-14; next after Remove Silences, in the AI
  panel): phrase captions from the transcript's word timings (2-4 words, or a
  line at a time), on their own track as caption clips styled by one schema
  (font, size, box, position, highlight of the word being spoken), edited by
  editing the transcript's words; burned into the export, and an `.srt`
  beside it. The words are already timed, so most of the work is the
  caption clip and its style.
- **Border** (the user, 2026-10-15; small, not transcript work, but wanted
  in this phase): a visual effect for camera footage (any clip, in the
  Visual Effects panel like Round Corners and Drop Shadow) with two settings,
  thickness and colour, drawn just inside the clip's edge so it adds no size
  and follows Round Corners' rounded edge when both are on. A feature folder
  with one WGSL pass, so the inspector, undo, copy properties and agent
  commands come from its schema; preview/export parity as for every pass.
- **Start screen** (the user, 2026-10-15; not transcript work, but wanted in
  this phase): opened without a project, Beacon shows an empty window today.
  Instead, a start screen (a modal over the empty editor) with **New
  Project** (the New Project dialog, as File › New Project) and the **last
  four projects** from Open Recent, each with its name and when it was last
  opened, a click opening it; plus Open… for any other. Opening one, or
  creating one, closes it. Maybe later, a third choice: **Start Recording**
  (a new project, then the Record dialog), left out for now since the Record
  button (Phase 8) is one click away. A UI-harness flow covers it.
**Progress (2026-10-15, `phase-7`):** Border and the start screen are built.
Border moved from an effect to a property of video and images (2026-10-16,
the user: rectangles already have an outline, so the effect only ever went on
camera footage): Border and Color on the Visual tab, off at 0; `border` v2
converts Border effects. The title bar no longer says "Saved automatically";
⌘S still shows it, green, for a moment.
The transcriber choice is built: Settings › General › Transcripts and the
`transcriber` preference (`preference_list`/`preference_set` for agents; the
contract gained feature preferences, Keychain secrets and per-variant analyzer
caches). Apple's transcriber is `beacon-speech`, a Swift tool built with
Beacon's tools, so CI moved to macOS 26. Word timings were checked on the
fixtures (`docs/transcription-spike.md`): the API is close to local Whisper,
Apple's are looser, and Remove Silences is identical with all three.
The start screen shows each recent project's frame as it was last left.
**Captions** are built (`packages/features/src/captions`): `captions.create`
makes caption clips (up to 3 words by default, a new one at sentence ends and
pauses) on a Captions track from the timeline's transcript; each holds its
words in its own media time, so ripple cuts and trims keep them in step. One
style for all (`captions.style`: font, size, colours, box, position, margin,
width, capitals, the spoken word's highlight), set from the Caption tab;
`caption.setText` corrects a caption's words. Drawn by the feature, in canvas
pixels (not a visual clip: no transform or effects); burned into exports, and
the contract gained `exportFiles` so an `.srt` is written beside the video
(`captions.srt` for agents). The AI panel's Captions tile runs `captions.add`.
On the canvas (2026-10-16, the user, after Canva): a caption is selected with a
click, dragged to move every caption (snapping as clips do), narrowed or
widened by its side handles, and typed in place after a double-click; the
Caption tab has Align to page (top/middle/bottom, left/centre/right). Their
place is an anchor and an offset on each axis (`captions` v2), the box from
`captions.layout`; typed words keep their times (a word diff). Clicked before
the transcript exists, Captions starts it, shows its progress and makes them
when it's done; the app also starts missing transcripts when it shows a project.
Their style is kept once on the Captions track (prop groups can be `track`
groups now; `captions` v3), so a drag step is one change, not one per caption.
A caption can be placed on its own (`caption.place`: ⌥-drag, or ⌥⇧ for it and
those after it, e.g. clear of a face in a vertical short; Use shared puts it
back). Later, with the shorts work: "keep clear of the face", placing each
caption from face detection (Apple's Vision, on-device).
**Remove Filler Words, first check** (2026-10-15): priming local Whisper with a
filler-laden prompt is not reliable. Two prompts found different fillers (5
and 8 on four fixtures, vs 2 without), one with a 50 ms "um" squeezed against
the next word, and on near-silence Whisper wrote the prompt itself ("Uh, and
then, er, hmm, okay"); Apple's transcriber kept none. The fixtures may simply
have few fillers.
**Remove Filler Words, decided and built** (2026-10-16), on a 10½-minute take
full of real "um"s (Yeti microphone), three ways compared:
(a) the transcript's own fillers: local Whisper kept 21 ("Um", "uh", a
five-"uh" stutter; 16 places once runs are joined), Apple's transcriber 22
(19 places, none under 120 ms); about half the places differ between them.
(b) Whisper primed with a filler prompt: 50 fillers (32 places), but it
changed 17.5% of the *other* words (a line became "Only Um, I was like, I
don't know", most likely the prompt), squeezed 5 fillers under 120 ms, and on
the four fixtures added 1 filler to 2 while squeezing 2 of the 3 (no prompt
text written in, 0–4% of other words changed).
(c) the audio: of the 18 or so places only the prompted run found, 4 were
detected speech no word covered; the rest were inside the next word's times,
since a word after a pause starts where the sound does. Fillers were longer
and louder than other words (0.42 s vs 0.19 s median, −40 vs −44 dB) and
steadier, but singing and music on the take looked the same.
Chosen: (a), whatever the transcriber; the prompt was dropped. As built
(`transcript.fillers`, `transcript.removeFillers`, `fillers.review`/`flip`/
`close`, `fillers.apply`; the AI panel's tile): each run of fillers is cut
with the shorter of the pauses either side, so the pause left is the longer
one (cutting the pause after, as `transcript.cut` does, took up to 3 s that
can be screen action; a long pause stays for Remove Silences); an edge
touching a kept word goes to the nearest frame rather than outward. "Ah",
"oh", "mm-hmm" and "uh-huh" aren't fillers. One review is open at a time.
On the take: 15 fillers, 19.5 s cut; 10 of the 15 joins have silence either
side, 3 on one side, 2 quiet speech (−50 and −54 dB against −55);
`transcript.joins` flags 5 joins at 3 places, 4 within half a frame of a
word boundary (a cut can only fall on a frame) and 1 at a word Whisper
squeezed to 50 ms. Later: fillers a transcriber leaves out (about half here)
could come from a second, prompted Whisper pass used only to find them,
leaving the transcript alone.
**Release:** v0.4.0 was cut from `phase-7` on 2026-10-15, partway through;
the phase was merged into `main` (PR #15, after a review whose five findings
were fixed) and released as v0.5.0 on 2026-10-16, before two gate checks:
Remove Filler Words and captions with Apple's transcriber, and a rounded
border compared between preview and export (`docs/tested.md`).
**Asked after trying both reviews** (the user, 2026-10-16: "they both work
great"): going through silences or fillers one at a time, a click making
that one the only one marked, and applying them one by one to check each.
Built the same day, for v0.5.0, in both reviews: ‹ › step through them (or
⌥-click one on the timeline), outlining the one looked at and putting the
playhead a second before it; Skip moves on; Cut This One cuts only it, as
its own undo step (marked to keep or not), and the review stays open on the
next. Apply became Apply All. For agents: `silences.focus`/`fillers.focus`,
then `silences.apply`/`fillers.apply` with `one`; the review's flips and
place follow the cut (`reviews.shift`), and the queries answer `current`.
Later, maybe: dragging a silence's edges to change how much is cut.
**Gate:** on a real take, Remove Filler Words cuts the fillers cleanly and
captions export burned in with a matching `.srt`, with each transcriber; a
camera clip with a rounded border looks the same in preview and export; and
Beacon opened without a project offers New Project and its recent projects.
**Passed 2026-10-19** (the user, by hand, with Apple's transcriber too).

### Phase 8 — Faster editing
Getting to everything quicker, by hand or by agent.
- **Voice narration** (the user, 2026-10-16: as Camtasia has it; first in
  this phase): record the microphone while the timeline plays, talking over
  it. From the Record dialog (a Narration choice beside the screen and
  camera takes, which the Record button below opens too) or Tools ›
  Voice Narration: pick the microphone, choose whether the timeline's own
  audio is heard (off by default, so speakers don't bleed into the take;
  headphones make it safe), then Start. A countdown, the timeline plays
  from the playhead (or the in/out range) and the take records; Stop, or
  reaching the end of the range, ends it. The take lands on a new audio
  track at the time recording began, shifted by the microphone's measured
  latency (the recorder already logs it per take) so it lines up with what
  was playing, and is transcribed like any import, so Remove Silences,
  Remove Filler Words and Captions work on it straight away. A take is one
  undo step; cancelled, nothing is added. The recorder (Phase 6) already
  records a microphone alone with its timing: what is new is playing the
  timeline while it records, placing the take at the playhead, and the
  alignment. For agents, `recorder.start` with only a microphone and
  `narrate`. Plus a UI-harness flow (the recorder faked, as the Record
  dialog's flows do) and a check on a real take that a clap recorded over
  a click in the timeline lands within a frame of it.
- **Record button** (the user, 2026-10-15, after trying v0.2.1): a red-dot
  Record button at the top left of the window, as Camtasia has, opening the
  Record dialog; today only File › Record… (⌘R) does. Plus a UI-harness flow.
- **Keyboard shortcuts** (the user, 2026-10-14): Settings › Shortcuts lists
  every action with its shortcut (from the registry and
  `keymaps/default.json`), searchable, and rebinds one by pressing the new
  keys, warning on a clash; changes go in the user override file merged over
  the defaults (§7), and menus show them. Shares its list with the command
  palette below.
- **Command palette** (the user, 2026-10-12; Phase 7 or later): a key (⇧⌘P
  or ⌘K, to pick then) opens a search over every action, command and menu
  item by its name and description, showing its shortcut, and runs it through
  the same path as keys and menus (`host.run`). The registry already holds
  everything it lists (ids, descriptions, keymap), so it is mostly UI built
  from `ui/src/controls/` (a Modal with a filtered list); later AI features
  can add entries to it.
- **Favourites you choose** (the user, 2026-10-13): today the Favorites panel
  is a fixed list (`FAVORITES` in `ui/src/sidebar.tsx`: Text, Rectangle,
  Spotlight and four effects). Instead: a star on any annotation, visual
  or audio effect (on hover, and Add to Favorites in its menu) adds it;
  favourites are reordered by dragging and removed by un-starring; the
  current list is the default for new users. Stored app-wide with the other
  app settings, owned by core (`favorites.add`/`remove`/`move`, so agents
  and the command palette use them too; see "App settings as commands"
  above). Open: whether a configured item can be a favourite too (a drop
  shadow with your colour and blur, a text style), saved as a preset with
  its params, which is the larger and probably more useful half.
  Decided with the user (2026-10-16), Camtasia's way: a click on a tile in
  Annotations, Visual Effects or Audio Effects selects it (yellow outline)
  and shows a white star; clicking the star turns it gold and adds it;
  favourites always show the gold star, and clicking it un-stars. Dragging
  applies to media; a double-click applies to the selected clips (replacing
  click-to-apply). In the Favorites panel a tile dropped on another takes
  its place. Plain items first; presets with settings later.
- **App settings as commands, then dialogs an agent can open** (the user,
  2026-10-12; found driving the app over MCP to check Phase 5.5; built
  2026-10-17 as core's `settings`/`setSettings` with MCP `settings_get` /
  `settings_set`, and `uiOpen` / MCP `ui_open`, which the app's window
  registers for as it does for `ui_snapshot`). §7 says
  preferences are commands, but they aren't yet:
  1. **App settings through core.** Settings > General (export colour space,
     Make Proxies For, Build Proxies) lives only in the desktop process
     (`settings.json`, handed to core through `setJobMode`/`setAutomatic`),
     so agents can't read or change it. Core owns them, with `settings.get`
     and `settings.set` commands (MCP tools like any other); the desktop
     persists them and the Settings dialog runs the same command. Project
     settings (`project.settings.set`) and export (`export.start`) already
     work this way.
  2. **Opening the dialogs**, so an agent or test can see what a person sees
     (not for changing anything: item 1 does that). A session command
     (`ui.open` with `settings` and its tab, `export`, `newProject`; and
     closing them) that the desktop forwards as the `settingsSheet`,
     `exportSheet` and `newProjectSheet` messages the window already handles
     (the UI harness sends them today). Then
     `packages/desktop/__tests__/app.test.ts` can open each dialog over the
     native canvas and check it through `ui_snapshot`.
- **From the user's editing, 2026-10-17:**
  - **Snapping while resizing on the canvas** (built 2026-10-17). Dragging a corner or side
    handle doesn't snap today (only moving does, `snapMove` in
    `ui/src/canvas.tsx`): a clip enlarged to fill the screen should snap
    its edges to the canvas, to other clips' edges, and to the edges of a
    recording's picture (where it meets the black around it), drawing the
    same green guides; Ctrl turns it off, as for moving.
  - **The playhead's time readable** (done 2026-10-17): white and bolder, on
    the ruler's colour so the ruler's labels don't run into it, as
    Camtasia's.
  - **Telling clips apart** (built 2026-10-17 as a stripe along the clip's
    top, the user's choice of the options below; `edit.label`, the `label`
    prop group, the clip menu's Add Color Label): Camtasia's Add Color
    Label (Red, Purple, Blue, Green, Yellow, Orange, Default) marks a clip
    that differs from its neighbours of the same kind (formatting, place).
    Beacon colours clips by kind, so a label must not read as a kind.
    Options to choose from before building: a coloured stripe or tab along
    the clip's top edge (the kind's colour stays the body), a pattern over
    the body (stripes, dots, zigzag), or Camtasia's whole-clip colour. A
    clip property (`label`), so agents set and read it.
  - **AI features that need the internet** (built 2026-10-17: a preference
    option's `online`; the AI tools grey out only when media still needs a
    transcript from an online transcriber) say so: offline, they are greyed
    with why (today only the OpenAI transcriber needs it; Whisper on this
    Mac and Apple's work offline, and Remove Silences, Remove Filler Words
    and Captions follow the transcriber). The same for later cloud features
    (generated B-roll, Replicate's background removal).
**Progress (2026-10-17).** Favourites, Settings › Shortcuts and the
command palette are built, checked headless. The palette opens on ⌘K (the
user's choice) and lists what the panels have, to add or apply by name
(annotations, visual and audio effects, the AI tools; favourites first), not
every action (the user, 2026-10-17); every action with its keys is in
Settings › Shortcuts. One list names every action (`keymaps/actions.json`:
commands with their args, and the app's own, `app.export`…), its default
keys in `keymaps/default.json`; core merges the user's keys from
`keymap.json` in the config folder (`shortcuts`, `shortcutSet`,
`shortcutReset`, MCP `shortcuts_*`). Menu items show their keys: those with
⌘ or ⌃ as key equivalents, handed back to the window's keymap for commands
so text fields keep typing; others after the name, as "Delete  (⌫)", since a
plain key equivalent would take keys from text fields. Context menus don't
show keys yet.
**Progress (2026-10-16).** Voice narration and the Record button are built,
checked headless (`docs/tested.md`). Alignment is by the host clock, not by
the recorder's logged `latencyMs` (that is how late buffers *arrive*, not when
their sound happened): the audio output notes the host time its first sample
is heard (cpal's playback instant, the output latency included), the take
writes its own host start (`hostStart` in `recording.json`), and the
microphone's samples are stamped at capture, so the take's file is placed at
`heard.time - (heard.host - (hostStart + start))`. A pause, a seek or the end
of the range ends a narration; its sound off, silence still plays to the
device as the clock. There is no separate Narration choice (the user,
2026-10-16): ticking only the microphone in the Record dialog makes the take
a narration (Beacon stays open and plays the timeline); Tools › Voice
Narration… opens the dialog that way. With nothing after the playhead (an
empty timeline), it records there until Stop. Left: the clap-over-click
check on a real take.
**Gate:** an edit from record to export using only keys and the palette
(the palette for annotations, effects and the AI tools; keys for Record ⌘R,
Export ⌘E and the editing), with narration recorded over the timeline and
in step with it; an agent changes settings and opens each dialog.
**Passed 2026-10-19** by hand (the user, on web-hijack); the agent half
(`settings_set`, `ui_open`, `recorder_start` with `narrate`, `favorites_add`
over MCP with the app open) is left until the user has finished editing.

### Phase 8.5 — Everyday fixes (the user, 2026-10-19)
What the user hit while editing, ahead of Phase 9.
- **Export audio only** (the user, 2026-10-19): the Export dialog writes
  just the timeline's mix, for a podcast or a voiceover: `.wav` (PCM,
  sample-exact), `.m4a` (AAC, with the data rate already in the dialog)
  and `.mp3`, chosen as the video formats are, by the output's extension.
  No frames are rendered, so it is as fast as mixing the audio. The mix is
  the export's own (track mute, volume points, fades, audio effects and
  noise removal, the in/out range), and loudness normalization applies as
  it does to a video. Agents get it through `export_start` with an audio
  extension. **Built 2026-10-19**: the dialog's File format lists Export
  Audio Only (.wav / .m4a / .mp3) and hides the video options (and the
  data rate for .wav); MP3 needed LAME 3.100 (LGPL, static in libavcodec,
  its source attached to releases with FFmpeg's).
- **Remove background noise, with ffmpeg first** (the user, 2026-10-19):
  a "Noise Removal" audio effect, as Audacity's Noise Reduction works:
  select a stretch of the clip with only room noise on the timeline, the
  effect learns that noise there, and removes it from the whole clip, with
  a strength slider (and a "learn from" range it keeps, so it can be
  learned again). Built on Beacon's own FFmpeg (`afftdn`, which takes a
  noise sample; `arnndn` for comparison), free, offline and in the
  preview as well as the export. It is a trial: run on the user's own
  takes (the Yeti in this room, a camera's mic) against the original; if
  it is good enough it stays, if not the cleaning goes to Auphonic (see
  *Background audio cleaning* in the backlog), with this effect kept for
  the cases Auphonic doesn't cover. **Built 2026-10-19**: Audio Effects ›
  Noise Removal (or `edit.removeNoise`) learns from the in/out range when
  there is one, else from the clip's quietest half second (its waveform),
  else follows the noise as it goes; the fx tab has its Strength (dB). The
  effect contract gained `EffectDef.audio` (a filter chain, a `lead` it
  hears first and a `delay` it is padded and trimmed for), so the mix runs
  it for preview, playback and export alike. afftdn hands each block back
  two blocks late (25 ms) and drops the last two: compensated, so the
  cleaned sound is in step to the sample and whole. On `recording.trec`:
  the quietest half second -58.9 → -77.2 dB, speech unchanged.
- **Shift-drag on empty space moves what comes after** (the user,
  2026-10-19): today Shift-dragging the playhead line inserts space at the
  playhead (`timeline.insertSpace`), rightwards only. The same from any
  empty spot on a track: press Shift on a gap and drag, and everything
  after that point moves with the pointer, right to open space, left to
  close it (no further than the gap, so nothing overlaps), as one undoable
  edit. Locked tracks and an open group refuse it as they refuse the
  playhead's. The playhead's own Shift-drag goes both ways too (the user,
  2026-10-19: right to left did nothing): dragged left it removes the
  empty time before the playhead, as far as the nearest clip. Chosen (no
  answer yet, easy to flip): every unlocked track, ⌥ for only the track
  pressed on. **Built 2026-10-19**: `timeline.removeSpace` closes empty time
  (refused over media), and both it and `timeline.insertSpace` take an
  optional `track`. Shift on a track's gap now moves time instead of adding
  to the selection with a marquee; ⌘-drag still adds. Known, from the PR
  review (2026-10-19), older than this: a magnetic track packs its clips
  again at once, so space opened across tracks closes on it while linked
  clips on ordinary tracks move; decide whether space edits skip magnetic
  tracks or move their linked partners with them.
- **Drops carry their paths** (the user, 2026-10-19). The webview gives a
  file dropped from Finder its name, size and date but not its path, so
  `findDroppedFile` guesses: WebKit's URL when it sends one, the home
  folders, then Spotlight. A clip dragged off a camera card isn't found
  ("couldn't find P1078391.MP4 on disk"): cards aren't in Spotlight's
  index. Native apps (Camtasia) read the file URLs from the drag
  pasteboard and know the path; Electron hands it over with
  `webUtils.getPathForFile`. Electrobun has no drop hook, so the window's
  view registers for file URLs itself (through the engine's FFI, or
  upstream in Electrobun) and the paths go with the drop to the UI, for
  any drive and any depth. The guessing then goes. **Built 2026-10-19**,
  more simply than registering the view: macOS keeps a drag's file URLs on
  the drag pasteboard until the next drag, so on a drop the engine reads
  them there (`beacon_drag_files`) and the dropped files are matched to them
  by name, size and date; the home folders and Spotlight are no longer
  searched.
**Gate:** a project exported as `.wav`, `.m4a` and `.mp3` sounds as its
video export does; noise removal judged by the user on their own takes, and
Auphonic chosen or not; Shift-drag on a gap or the playhead opens and
closes space; a clip
dragged straight off a camera card imports.

### Phase 9 — Workspace and film look
Seeing more at once.
- **A window per project** (the user, 2026-10-12): several projects open at
  once, each in its own window (macOS's Merge All Windows then
  gives tabs). Core already holds several projects and shares one clipboard
  between them (copying clips across projects works); the desktop main
  process keeps one `current` project and view, so its state (project, live
  view, thumbnails, proxy progress, RPC) moves to a per-window record, and
  menus and keys go to the focused window. Playing in one window pauses the
  others. Mostly `packages/desktop`; the UI and core are unchanged.
  **Built 2026-10-20**: the main process keeps a record per window (its
  project, native canvas, Media Bin pictures, exports, messages and status
  line); a project opens in the focused window while it shows the start
  screen, else in a new one (cascaded), and one already open is brought
  forward; Save As and renaming keep their window; closing a window saves
  and releases its project (Window › Close Window, ⌘W); menus, keys and
  dialogs act on the focused window, agents' `ui_open` and `ui_snapshot` on
  the window showing their project; playing in one pauses the others; a take
  hides every window. Merge All Windows is macOS's own, not checked yet.
- **Project Settings apart from Settings, and a Settings window like
  System Settings** (the user, 2026-10-19). Project Settings (canvas size,
  frame rate, background, loudness, standalone) is the project's, with
  undo, so it leaves the app's Settings for a dialog of its own, opened as
  Camtasia does: Edit › Project Settings… (with a key) and the canvas's
  right-click (already there), plus New Project's form, which already
  reuses it. Agents keep their way in:
  `project_settings_set` changes it, and `ui_open` gains a `projectSettings`
  dialog in place of Settings' `project` tab, so `ui_snapshot` can show it.
  Settings becomes a fixed-size window with a sidebar (General, Recording,
  Transcripts, Shortcuts, later Appearance), each section scrolling inside
  it, so switching sections never changes its height; a search over every
  setting once there are enough to need it. Decided (the user, 2026-10-20):
  a fixed-size sheet in the editor's window, not a window of its own; ⌥⌘,
  for Project Settings. **Built 2026-10-20**: Project Settings is its own
  dialog (Edit › Project Settings…, ⌥⌘,, the canvas's right-click, `ui_open
  projectSettings`; Settings' `project` tab is gone and asking for it says
  so); Settings is 500 points tall with General, Recording, Transcripts (the
  transcriber and Best Take) and Shortcuts down a sidebar. No search yet.
- **Copying into a standalone project shows its progress** (the user,
  2026-10-19). Today an import into a standalone project (and turning
  standalone on) copies the media in before the clips appear, with nothing on
  screen meanwhile: instant as an APFS clone on the same disk, but a large
  file from another drive takes a while. Show it as proxies are shown: the
  copy is a job, its progress on the medium's Media Bin tile and in the status
  line ("Copying clip.mp4 into the project…"), and agents see it through
  `job_status`. The clips still appear only once the copy is complete, and a
  failed copy still leaves nothing behind. Save As standalone gets the same
  progress in place of its one status message.
- **Film look from hance** (the user, 2026-10-13; small, not hance's full
  grading): a "Film Look" feature folder, one WGSL pass and a few of hance's
  sliders (strength, grain, halation, fade, warmth, or whichever few hance
  treats as its core), so the inspector, undo, copy properties and agent
  commands come from the schema; hance's `.hlook` files import onto those
  sliders, with what doesn't map listed in an import report rather than
  dropped. The shader comes through `orva-kit` (§4.1) rather than a copy, so
  fixes reach both; preview/export parity as for every pass. Open: what a
  `.hlook` holds (values, a LUT, or both) decides whether the renderer
  needs LUTs. Answered: a `.hlook` is values only (and an optional input
  LUT by name), so no LUTs. Decided (the user, 2026-10-20): ported into
  Beacon rather than through `orva-kit`, which doesn't exist yet
  (`docs/shared-candidates.md`); about ten sliders; hance's 41 looks as a
  Look menu. **Built 2026-10-20**: a `film-look` feature: one pass of four
  steps (graded highlights, per-channel scatter across and down, then the
  grade, halation ring, grain and vignette in linear light as hance does
  them), eleven sliders (strength, exposure, warmth, fade, contrast,
  saturation, grain, grain size, halation, halation size, vignette); the
  inspector's Look menu and Import .hlook… (effects can now declare
  `presets` and an `importFile`), with what doesn't map listed under it;
  `filmLook.load` / `filmLook.read` / `filmLook.looks` for agents. Split tone and Tint added
  (the user, 2026-10-20): hance's split tone (shadow and highlight hues, a
  highlight strength; its pivot fixed at hance's 0.3) and tint, on hue
  sliders; 58.3 dB from hance's own render with just those on. On a frame
  with CineStill 800T it is 49.5 dB from hance's own render, and adds about 5 ms
  to a 1080p preview frame (the scatter takes at most 40 taps a side).
- **Remove Retakes** (the user, 2026-10-19; an AI feature, next to Remove
  Silences and Remove Filler Words): finds the same thing said more than
  once (a line restarted, a sentence said again after a stumble) and keeps
  the best take. Detection from the transcript: runs of words that repeat
  closely within a short span (aligned word by word, so "so the next step
  is… so the next step is to open" groups as two takes of one line),
  ending where the takes agree again. The best is the last complete one
  by default (people redo until it's right), scored too for fewer
  fillers, no cut-off ending and fluency; an LLM judging the takes is an
  option behind the AI setting, as the transcriber is. UI as the other
  reviews: its AI panel tile opens a review; each group is one mark on the
  timeline spanning its takes, the kept take green and the others red;
  ‹ › step through the groups (playhead on the group), clicking a take
  keeps that one instead, and the properties panel lists the group's
  takes as text with their lengths and a play button each; Apply All cuts
  the losing takes in one undo step, Cut This One one group at a time.
  Agents get `retakes.review`/`apply` (they already cut retakes by word
  ranges with `transcript_cut`). Decided (the user, 2026-10-20): the last
  complete take, scored; 3+ words within 30 s by default (the review's
  sliders); keeping an earlier take cuts only the later one's repeat, so
  what it goes on to say stays; and the OpenAI judge now, with the
  transcriber's key. **Built 2026-10-20**: `transcript.retakes` /
  `transcript.removeRetakes`, `retakes.review/keep/focus/apply/close`; a take
  restarts the one before when its first words repeat it and it says 70% of
  its words again in order. Best Take (Settings › Transcripts) is Beacon's own
  scoring or OpenAI (`gpt-5-mini`, the takes' words only): a `retakes`
  analysis per medium, run only when the review asks (a new `when: "asked"`
  in the contract, which also gave analyses the asset's other data and
  queries and actions the preferences), its picks matched to the timeline's
  groups by their words; until it answers, or if it can't, Beacon's picks
  show, with why. On the user's cached transcripts it finds 70 groups, the
  restarts and redone sentences.
- **Safe-area guides and layout checks** (the user, 2026-10-13): canvas
  overlays (drawn by the native preview like the snap guides, never
  exported), chosen per platform for the project's shape: 9:16 TikTok,
  Reels and Shorts; 16:9 YouTube. They show where the platform's own UI
  sits (caption band, profile picture, name and description, the
  like/comment column) and a headroom band and eye line for where a head
  should be. Platform layouts are data (a JSON file), since the apps move
  them. A query flags text, captions and callouts that overlap an unsafe
  zone anywhere on the timeline ("nothing under the TikTok buttons", one
  tool call for an agent); snapping to safe-area edges comes cheap. Face
  detection for the head guide is later, if wanted. Decided (the user,
  2026-10-20): the platforms' ads numbers (measured from their templates,
  `features/src/safe-areas/layouts.json` with their sources); for 16:9, the
  player's title bar and controls, the 90% title-safe frame and end screens
  over the last 20 s; View › Safe Areas and a picker by the canvas zoom,
  kept with the project. **Built 2026-10-20**: a `safe-areas` feature
  (`safeAreas.show`, `safeAreas.layouts`, `safeAreas.check`); the zones as
  bands and edges in the preview's marks, the headroom band and a dashed eye
  line; the top bar counts the captions and callouts under a zone and goes to
  the first; boxes snap to the zones' edges. The contract gained
  `Feature.sessionSaved` (editor state kept in the project's `editor.json`,
  never an undo step) and the session in queries.
**Gate:** two projects open side by side, the film look matches between
preview and export and a `.hlook` imports with a report of what didn't
map, and a 9:16 Short checks clean against its platform's safe areas.

### Phase 10 — Drops, backgrounds and filmstrips
- **First: drops that fail, and images with no file** (the user, 2026-10-20;
  first in the phase, at their ask): dragging from Finder's Recents bounces
  back with no message, whatever the file (⌘I always works: the Open dialog
  gives real paths); a screenshot already saved, dragged from Finder, bounced
  too; and dragging a macOS screenshot from its floating thumbnail
  onto the timeline does nothing (the drag offers a file promise, not a path,
  and drops are found by path), nor does ⌘V of an image copied elsewhere (⌘V
  pastes only Beacon's own clips). The window has the image's bytes either
  way: write them into the project's folder (a `media` folder, named by the
  screenshot or by date) and import them, at the drop point or the playhead.
  Found 2026-10-20: the thumbnail's drag is a file promise that also offers a
  `public.file-url` in `TemporaryItems/NSIRD_screencaptureui_*` and the PNG
  itself (`public.png`); the drop fails "couldn't find … among the dragged
  files" because that file's size or date isn't the webview's, and the folder
  is cleared once the drag ends, so it must be copied in, not used in place.
  Read the drag pasteboard (`beacon_drag_files`) of a Recents drag first: what
  it offers (file reference URLs, `/.file/id=`?) decides the fix.
  Later the same day the user found those bounced drops do arrive, only late:
  the clip appears on the timeline after a while. So the bounce is Finder's
  animation (the drop reported as not taken), and the time goes somewhere
  before the clip is placed: time each step (WebKit handing over the file,
  finding its path, reading it) and make the drop show at once (the import
  panel's placeholder, and the drop reported as taken).
- **Remove background** (the user, 2026-10-16): a camera or video clip's
  background removed, as Camtasia's Remove Color does for green screens
  but with no green screen. It is person segmentation (a matte per frame),
  not an LLM. Who makes the matte is the user's choice, as the transcriber
  is (Settings, a preference agents can read): Apple's Vision on this Mac
  (`VNGeneratePersonSegmentationRequest`: free, no download, fast; edges
  around hair are rougher), a local matting model (e.g. Robust Video
  Matting through Core ML, finer edges, a download like Whisper's model),
  or Replicate in the cloud with the user's own API key (BYOK, kept in the
  Keychain as the OpenAI key is; the video is uploaded, so the setting says
  so). The matte is a background job analyzer per asset (cached like
  proxies, so a take is segmented once), and a "Remove Background" effect
  on visual clips draws it in a pass: transparent (the clips below show
  through), blurred, a colour or an image, with a feather for the edge.
  Preview and export read the same matte. **Decided (the user,
  2026-10-20):** Vision only for now (a frame of `take.brec` came out clean
  at balanced and accurate quality: no hair to lose); a local model and
  Replicate wait until its edges disappoint. A new Remove Background is
  transparent; blur, a colour or an image are options in the effect.
- **LUT import** (the user, 2026-10-20): a LUT effect of its own, not part
  of Film Look (a LUT usually goes first, a look on top): a `.cube` file
  (what nearly every LUT is sold as) copied into the project so it travels
  with it, drawn by a 3D texture with an Intensity slider, preview equal to
  export. Effects can't yet load a table from a file into the renderer, so
  the feature contract grows for it. Mostly creative LUTs: the Cam Link's
  footage is Rec.709, not log.
- **An animation from end to end of a clip** (the user, 2026-10-20): a key
  (and the clip's menu) that adds an animation block spanning the whole
  selected clip, start to end, rather than from the playhead; or, simplest,
  double-clicking an animation stretches it to the clip's ends.
- **Right-click an effect to add it** (the user, 2026-10-20): the effect,
  annotation and audio tiles get a menu (Add to Selected Media, Add to
  Favorites), as double-click, dragging and ⌘K add them now; there never was
  one.
- **Instagram Reels' safe areas for ordinary posts** (the user, 2026-10-20):
  the Reels guide draws Meta's numbers for ads (14% top, 35% bottom, 6%
  sides), whose call-to-action makes the bottom band far deeper than a
  post's; guides measure ordinary Reels at about 13% top, 17% bottom, 8%
  left, 11% right, and disagree. Measure them from the user's own phone
  (screenshots of Reels with long captions; a 19.5:9 screen shows a 9:16
  Reel under its own bars), and offer Reels and Reels (ad) as two layouts.
  **Done 2026-10-20** from the user's Android (1080×2400; TikTok and Reels
  fill the height and crop the sides, about 4%): ordinary TikTok and Reels
  posts, their bottom bands 18% rather than 34-35%, widened to guides'
  iPhone measurements. The ad layouts were offered too, then removed at
  the user's ask (2026-10-21): Beacon is for ordinary posts. What looked
  like zones outside the canvas was the unlabelled grey headroom band: now
  blue with an edge, and a key beside the picker says what each colour is.
  Still to measure: the Reels tab's header, an iPhone, and YouTube Shorts
  (Google's numbers until then).
- **The recording panel follows you between desktops** (the user, 2026-10-20): the panel (camera, time, levels, Stop) stays on the desktop it
  opened on. The user switches with AeroSpace, which hides windows by moving
  them off-screen rather than using macOS's Spaces, so the panel joining all
  Spaces (`canJoinAllSpaces`) may not be enough: check what AeroSpace allows
  (a floating or sticky rule for the panel's window) as well.
  **Built, not working yet** (2026-10-21): the panel opens untitled, which
  AeroSpace ignores in a stand-in window, but the real panel is still left
  behind on a workspace switch. Set aside at the user's word; next step, if
  they raise it, is `aerospace debug-windows` during a recording.
- **Filmstrip thumbnails** (the user, 2026-10-12; **dropped** 2026-10-20: built,
  then removed at the user's ask, who didn't think it worked; not to be
  built again unless they ask): video and screen clips
  show frames along their length, not only the first. Measured on demo_1
  (626 s, one thumb a second, 48 px tall, keyframes only, one ffmpeg pass per
  stream into a JPEG sprite): from the proxies 1.1 s (screen) and 5.7 s
  (camera), ~3 s of CPU, about 4% of building the proxies; from the
  originals ~12 s of CPU (tscc2 can't skip to keyframes); decoding every
  frame would be 109 s. ~0.5-0.8 MB a stream on disk. A background job after
  the proxy, cached like waveforms; the timeline draws slices of the sprite
  (its clips layer is redrawn only on zoom, scroll and edits). Design for
  memory: one sprite is ~10 MB decoded, so load it in chunks (a minute each)
  for what is in view, or keep two densities (1 s, 10 s).
**Gate:** anything dragged in (Recents, a saved screenshot, a screenshot's
thumbnail) or pasted lands at once; a camera take's background removed by
each provider, with the same matte in preview and export.

### Phase 10.5 — Silence and filler-word fixes (the user, 2026-10-21)
Fixes to Remove Silences and Remove Filler Words (Phase 7), first in the
new order as Phase 10's drop fixes were. Started by running both on real
takes and fixing what turns up; the user adds issues as they spot them.
Each fix gets a test on real data that fails without it.
- **Found by running both on 29 of the user's takes** (2026-10-21; 44 takes
  in their Beacon projects and ai-slop, read in place, the ones with speech):
  - Remove Silences cut pictures put over or after the talk: an image after
    the last word went whole, one over a pause was cut down with it, as did
    another video, a group or a held frame where no audio clip played (time
    with no audio clip counted as silence). **Fixed:** time showing a picture
    that isn't the talk's own isn't silence; the recording's own screen and
    camera are cut with their silences as before. **Then (the user,
    2026-10-21):** on 3-shorts it found 3 silences where there were dozens:
    the camera was another file (the Lumix, synced to the mic's recording),
    so it counted as a picture put there. Narrowed: a picture where no
    audio plays, and an image, held frame or group wholly inside a pause,
    are kept; a video across the talk is cut with it (3-shorts: 58
    silences, 3:37 shorter).
  - **Apply and Cancel by keys** (the user, 2026-10-21): ↩ applies the open
    review (Silences, Filler Words, Retakes) and ⎋ cancels it, shown on the
    buttons ("Apply All (↩)"); ⎋ with no review open still deselects and
    clears the range. In Settings › Shortcuts as Apply Review and Cancel
    Review or Deselect. Escape is shown as "Esc" (the user didn't read "⎋").
  - **The timeline didn't scroll vertically** (the user, 2026-10-21): with
    more tracks than fit, the bottom ones were out of reach (the wheel only
    moved through time). Now up and down move through the tracks when they
    overflow, sideways through time.
  - **Fillers missing from the user's takes** (the user, 2026-10-21): on
    3-shorts Remove Filler Words finds none, as its transcript has none (0 in
    703 words of 11.50.02). Whisper primed with fillers (with `-mc 0` off, or
    the prompt is ignored) found none in its first 4 minutes either. Waiting
    on a time where the user hears one, to see whether it is in a pause or
    inside a word's time.
  - Remove Filler Words clipped 3–14 ms of the word next to a filler (8
    places in 3 takes: "uh," touching "padding?" lost its "p"): edges were
    rounded to the nearest or outward frame. **Fixed:** an edge goes to the
    frame on the filler's side when rounding out would reach a kept word.
  - Checked and fine: neither tool lost a word on any take, in either order.
  - Not a bug: the recent takes' transcripts have almost no fillers (0 in 75
    minutes of 3-shorts and ai-slop takes). The 9–29 stretches of sound per
    take that no word covers were each sent to Whisper alone: breaths and
    clicks ("Thank you.", its words for noise), not dropped "um"s.
  - Left for the user: Whisper writes sounds as words ("\*Sings\*" over 3.3 s,
    "\*laughs\*", "\*sniff\*"; 8 takes): kept as speech by both tools, shown
    by captions. A filler cut could take sound no word covers in the pause it
    takes; seen on no take, so not changed.
**Gate:** each issue fixed on the user's own takes, checked by hand.

### Phase 11 — Track shortcuts, AI B-roll and animations, and audio cleaning (the user, 2026-10-22; B-roll and cleaning were Phase 12)
Moved up from Phase 12 on 2026-10-22, with device frames moving to Phase 12.

#### Lock and mute a track by keys (the user, 2026-10-22)
Today a track is locked or muted only by its header's padlock and speaker.
- **Lock Track** and **Mute Track** actions, each a toggle: the tracks of the
  selected clips (else the track under the pointer's last click on a
  header); all of them locked (muted) if any isn't, else all unlocked
  (unmuted), one undo step each, named as the header's buttons name them.
- Default keys free in the keymap (chosen when built, checked against
  `shortcuts.list`), listed in the shortcuts settings to change, in the
  timeline menu and the command palette, and as MCP actions.
- Test: a UI flow (keys lock and unlock, mute and unmute the selected clip's
  track; a locked track's clips can't then be picked), and `tested.md`.
- **Done 2026-10-21:** `edit.lockTrack` ⌥⇧L, `edit.muteTrack` ⌥⇧M; the
  header clicked last is the session's `track` (`track.focus`), lit while
  nothing is selected; in Edit and the ⌄ track menu.

#### Linked clips move together while dragged (the user, 2026-10-22)
Dragging a linked clip (a recording's camera and audio), the clips linked to it
must follow the pointer in the same frame, not one after the other. Look first
at the timeline's move drag (`timeline.tsx`, the `clip.move` drag with its
coalesce key): whether the ghost/preview draws only the grabbed clip and the
linked ones jump when the command lands, or each clip is its own move. Test: a
UI flow sampling the clips' drawn positions mid-drag, every linked clip at the
same offset on every frame.
- **Done 2026-10-22:** the ghost drew only the dragged ids; the press selects
  the linked clips through the core, so a drag begun before that came back
  showed one clip and the others jumped on release. The ghost now adds the
  linked clips as `clip.move` does.

#### Status messages clear themselves (the user, 2026-10-22)
The top bar's grey line stayed until the next message. Now 5 s, a second more
per 12 characters past 60, at most 10 s; a newer message restarts the time.
"Can't move there" named an unnamed track `""`: now "Track N". **Done
2026-10-22.**

#### Remove Silences and Remove Retakes keep their last settings (the user, 2026-10-22)
As an animation's easing is kept. **Decided:** app-wide, and only the user's
slider changes count (an agent's review settings are its own). **Done
2026-10-22:** preferences can be a number in a `range` (no options); session
commands read preferences (`SessionContext.pref`); changing such a preference
restarts no analysis.

#### ⌘E exports the selected clips (the user, 2026-10-22)
**Decided:** only the selected clips, over their span, the rest left out (only
audio clips: an audio-only export; only the camera or screen: that alone);
⌘E is the selection, else the in/out range, else the whole project; framed as
on the canvas; an audio-only selection starts on the last audio format.
**Done 2026-10-22:** `ExportOptions.clips` (and `export_start`); the sheet
is built by `exportSheetFor` (ui), shared by the app and the UI harness.

#### The same Cancel and Apply in every panel (the user, 2026-10-22)
**Decided:** the same word everywhere: Cancel (⎋), Apply (↩), and Apply All
(⇧↩) where there is one (Remove Silences). **Done 2026-10-22:** features
declare their panels (`panels`), the `reviews.*` actions act on the open one;
Clean with Auphonic's settings live in the session (`auphonic.apply`), and its
summary is one line.

#### "open in another process" as a dialog (the user, 2026-10-22)
Today a status line ("… is open in another process (pid … on …)"). Decided:
no option to turn autosave off for it (two editors would still overwrite each
other). Instead a dialog naming who has it (the Beacon app, Beacon dev, an
agent's MCP server), with Open a Copy, Cancel, and for a process with no
window, ask it to let go (it closes the project; the agent's tools then join
the app, as `project_open` does). A lock left by a process that is gone is
cleared without asking (check it already is). Test: a UI flow with the lock
held by another LocalCore.
- **Decided (the user, 2026-10-22):** an app holder (it has a window) gets
  Show It, which brings its window forward; Open a Copy copies the project
  beside it as "Name copy.beproj" ("copy 2"…) with no save panel; an agent busy
  with a job refuses to let go, the dialog saying what is running.
- **Done 2026-10-22:** the lock records who holds it (`name`; the app as Beacon
  or Beacon dev by its channel) and, for an MCP server, its control socket
  (`mcp-<pid>.sock`, `letGo`). A native dialog (as Move to Trash): Show It or
  Ask It to Let Go, Open a Copy, Cancel. Let go, the agent's next tool call
  joins the app and says so. A dead process's lock was already taken over.
  Tested in `desktop/__tests__/windows.test.ts` against a real MCP server (the
  dialog is native, so not in the UI harness).

#### The user's notes after trying the leader key (2026-10-22)
The user likes the leader key. Asked for, in this order after the two above:
1. **Groups look like groups.** In the `:` popup, Color Label… didn't read as
   opening more keys: mark a group plainly (a chevron › and a different tone,
   or a count, "6 colours"), so it is clear more choices follow.
2. **Properties tabs by the leader.** Leader keys to move the properties
   panel's tab left and right, `: [` and `: ]` (decided 2026-10-22), and one
   to jump to the fx (Effects) tab.
3. **The command palette lists the Media Bin.** Every medium in the bin as a
   palette entry (by name, with its kind); choosing one adds it to the
   timeline at the playhead (decided 2026-10-22).
4. **Remove Silences: every silence red, the selected ones with a green
   border** (decided 2026-10-22): no grey; all found silences take the red
   fill, and selection is shown only by the green (accent) outline.

**Decided (the user, 2026-10-22, before building):** a group shows its name in
the accent tone with a › at the right, no count; `: E` jumps to the fx tab, or
on a clip with no effects opens the Visual Effects panel; `: [` / `: ]` wrap
around; the palette lists media only once something is typed, under a "Media
Bin" group.
**Done 2026-10-22**, all four, each its own commit (`inspector.step`,
`inspector.effects`; palette media show their kind's icon until the bin has
made their picture).

#### A leader key (the user, 2026-10-22; a trial in its own commit)
`:` (as in vi) then a key, with a popup of what can follow: : P palette, : A / : V
Delete Audio / Video, : U Unlink, : L / : M Lock / Mute Track, : S / : F Remove
Silences / Filler Words, : C + colour letter a label. Existing keys kept. Shortcuts can be
sequences everywhere (Keys.then). **Done 2026-10-22**; the user decides after
using it whether it stays. Unanswered: whether Copy Properties should carry
volume points.

#### Remove Silences cuts only what is picked (the user, 2026-10-22)
No cut/keep marking: the silences found are shown, the user selects them
(click, ⇧-click) and cuts them (Cut Selected, ↩, ⌫), or Cut All. Refused while
two clips with speech play at once. **Done 2026-10-22.**

#### A shorter clip menu (the user, 2026-10-21)
Gone through item by item with the user: Add Color Label first; Cut, Copy,
Delete, Unlink, Copy/Paste Properties kept; Ripple Cut, Ripple Delete, Add
Animation Across Clip and Group/Stitch under More; Hide Properties, Select in
Media Bin, Add Clip Speed and Split at Playhead removed. Clip Speed became a
Visual Effects tile. **Done 2026-10-21.** Later (Phase 15): order menus by
what the user actually uses, counted locally.

#### Film Look: a look previewed on hover (the user, 2026-10-21; Phase 11 since 2026-10-22)
Moving over the Look menu's looks shows each on the canvas at the playhead,
back as it was when the pointer leaves or the menu closes; nothing is
applied, saved or put in the undo history until a look is clicked (then one
undo step, as now). The note of what a chosen look can't reproduce ("Not in
Film Look, from…") is gone (done 2026-10-22, the user's ask); an imported
`.hlook`'s still shows.

**Spike (2026-10-22, read through the code, nothing built):**
- **The menu has to be Beacon's own.** The Look menu is a `<select>`
  (`properties.tsx`, `data-effect-preset`), whose list WebKit draws natively:
  no hover reaches the page. It becomes a button opening a list of Beacon's
  own (in `controls/`, reusable: any effect with `presets`, so LUTs or
  other preset effects get hover previews too), keyboard-driven as a menu is
  (↑↓ move and preview, ↩ applies, Esc closes and restores), checked against
  the Look menu's 41 looks plus Custom.
- **A preview that isn't an edit.** The canvas renders `LiveView`'s
  `project()`, today `p.store.doc` (`core/src/local.ts` `attachView`). A
  preview is an overlay there: core keeps `p.preview = { clip, effect,
  params }`, `project()` returns the document with those params laid over that
  one effect (a structural copy of the path, the rest shared), and
  `view.refresh()` redraws. The store, history, autosave, agents and the
  timeline never see it; closing the menu clears it and redraws. An RPC
  `effect.preview` / `effect.previewEnd` (session-like, not a command), also
  for agents as a tool if useful. Export reads the store, so it can't leak.
- **Speed:** a redraw at the same frame is the slider path ("an edit redrawn
  at the settled frame keeps the originals", `playback.ts` `show`), which
  already feels live when dragging Film Look's sliders; Film Look's passes
  are GPU work on one frame. A hover is throttled to the newest look (a frame
  in flight is replaced, not queued), so sweeping down the list stays smooth.
  To measure when built: hover-to-frame time on 4K originals (`BEACON_PROFILE`).
- **Edge cases:** the preview ends if the clip or effect is removed, the
  playhead moves (the preview follows it: it is an overlay on whatever frame
  is shown), playback starts (ends the preview), or an edit arrives
  (the overlay is laid on the new document). Several clips selected: the
  effect's own clip only, as the menu edits one effect.
- **Tests:** a UI flow (hovering looks changes the canvas's pixels, leaving
  restores them exactly, no undo step or save; a click applies in one step;
  ↑↓/↩/Esc), and a core test that the overlay never reaches the document or
  an export.
- **Done 2026-10-21:** as the spike says: `ListSelect` in `controls/`,
  `LocalCore.previewEffect` (an overlay through `withEffectParams`, the view
  only), the `previewEffect` RPC coalesced like a drag. Not an MCP tool (agents
  see edits, not hovers). Hover to frame about 7 ms on a 4K original.

#### AI B-roll and animations
Generated footage or animation over a stretch of the talk, made from what is
said there, through the user's own API keys, reviewed in the AI panel before
it is placed (as Remove Silences is: agents prepare, the user applies).
**Draft spec (2026-10-21), from the user's flow; the open decisions below
come first.**

**The flow.**
1. **How long:** drag the in/out range on the ruler over the words it should
   cover (the range Beacon already has). The range's length is the footage's
   length; a range longer than one shot (models make 4-10 s) becomes several
   shots, cut on the transcript's sentence ends.
2. **Open it:** the AI panel's B-roll tile (or the range's right-click menu,
   or an agent) opens a review in the right sidebar: the range and the words
   said in it, a **Guide** box (optional: "show a city at night", "keep it
   abstract"), a **Kind** (Footage, or Animation), **Research the topic**
   (on or off), and **Where** (Full canvas, or Draw on canvas).
3. **Where (optional):** Draw on canvas drags a rectangle over the canvas
   with handles, snapping to the canvas's halves and thirds and to the safe
   areas (a vertical Short: the face in the bottom half, B-roll in the top).
   The footage is made at that shape (the nearest aspect the model offers,
   then cropped to fill) and placed there.
4. **Plan:** an LLM reads the range's words (and a little before and after,
   for context), researches the topic on the web when asked (names, products,
   places in what is said, so the shots show the right thing), and writes a
   shot list: each shot's span on the timeline, its prompt and why. Shown as
   marks over the range on the timeline, each prompt editable, with the
   cost estimate (model × seconds) before anything is generated.
5. **Generate:** a job per shot (progress in the top bar, as Remove
   Background's), each a candidate with its prompt, model and cost; re-roll
   one shot, or edit its prompt and make it again.
6. **Apply:** one undo step places the picked candidates on a B-roll track
   above the talk, over their spans, fitted to the region; the talk's audio
   kept (footage is generated silent). The files are copied into the project's
   `media` folder, each asset remembering its prompt, model and cost.

**Kinds.**
- **Footage** (first): text-to-video with audio off, through Replicate
  (below): a 20 s range is about $3 a try with Veo 3.1 Fast. Good for generic shots; weak on real UIs, logos and
  text, which is where research and the Guide help least.
- **Animation** (second): motion graphics made from the words (a title, a
  number, a list, a diagram) with HyperFrames (the user's pick, to be
  looked at), drawn locally rather than generated: sharp text, no per-second
  cost, editable afterwards. Later: the user's own skills as presets.

**Agents.** MCP tools follow the same path: `broll.plan` (the range, guide,
kind, research, region) prepares the review, `broll.generate` runs it,
`broll.apply` only when the user asks.

**Decided (the user, 2026-10-21).**
- **Footage through Replicate**, the user's own API token (kept in the
  Keychain as the OpenAI key is; Settings says the prompts and region shape
  are sent to Replicate and it charges the user's account). Default model
  Veo 3.1 Fast, with Seedance 2.0 and Kling v3 Pro to choose from in
  Settings. Prices seen in Aug-Sep 2026 comparisons, to check on
  replicate.com/pricing before relying on them: Veo 3.1 Fast about $0.15/s,
  Seedance 2.0 about $0.18/s (720p), Kling v3 Pro about $0.22/s, Veo 3.1
  $0.40/s. Remove Background's Replicate option (Phase 10) would share the
  token.
- **Planning and research by OpenAI**, with the key Beacon already keeps
  (its web search for research); the range's words and the Guide are sent,
  not the audio.
- **First slice: footage with the drawn region**; animation (HyperFrames)
  after it.
- **One candidate per shot**, re-rolled on request.
- **Spending limit:** not a worry this phase (the user, 2026-10-22). The
  cost estimate is shown before anything runs; a limit per generation the
  user can set in Settings (off by default) is enough.

**Decided (the user, 2026-10-23).**
- **Settings › AI**, a new tab: the Replicate token, the B-roll model,
  its resolution and the limit per generation, and the OpenAI key (the same
  Keychain item Transcripts' OpenAI options use: the Transcripts tab only
  shows it once an OpenAI option is picked).
- **Planning and research by `gpt-6.1-sol`** (OpenAI's Responses API, its
  `web_search` tool when Research is on).
- **Candidates previewed on the canvas, in place:** with the review open, the
  playhead over a shot shows its candidate in its region as it would look
  applied; nothing is in the document until Apply.
- **Paid footage is kept:** each candidate is saved in the project's
  `media/B-roll` folder as it arrives, with its prompt, model and cost;
  Apply places only the picked ones.
- **Medium reasoning effort for every OpenAI model Beacon calls** (the user,
  2026-10-23): the B-roll planner and Remove Retakes' judge.
- Known from the model (2026-10-23): Veo 3.1 Fast makes 16:9 or 9:16, 4, 6
  or 8 s; a drawn region is made at the nearer shape and cropped to fill, a
  shot at the next length up and trimmed to its span.

**Decided (the user, 2026-10-23, later).**
- **More models:** FLUX 3 (Black Forest Labs) and Seedance 2.5 join Veo
  3.1 Fast, Seedance 2.0 and Kling 3.0 Pro in Settings › AI.
- **The default is settled by a side-by-side run** on the user's footage:
  one shot made with every model, each previewed in place, then the user
  picks; Veo 3.1 Fast stays the default until then.
- **Every API key in Settings › AI** (OpenAI, Replicate, Auphonic), each
  with what it is for and who charges; Transcripts and Audio say where to
  set the key their choice needs.

**Decided (the user, 2026-10-24): B-roll is a clip, not a review.** The AI
panel's B-roll tile adds a **B-roll placeholder clip** at the playhead (over
the range when one is set) on a B-roll track above the talk; it is dragged
and trimmed on the timeline for its span and moved and resized on the canvas
with the usual handles for its region (the range and Draw on Canvas go). Its
properties tab holds its prompt (typed, or written by Plan from the words
under it: no OpenAI key needed to type one), guide and research, the cost,
Generate, Make Again and Try N Models; the footage made goes into the clip
in place, one undo step, its region kept, every take kept on the clip (and
in the Media Bin) to pick again. A placeholder without footage is a box in
the editor and nothing in an export. Plan on a placeholder longer than the
model makes splits it into shots. The review panel and its preview go.

**Decided (the user, 2026-10-24, after trying it).**
- **Styles** replace the Guide box: a Style menu on the clip (None; Film looks:
  Documentary, Vintage film, Black and white, Timelapse; Product and tech: Tech
  abstract, Studio product shot, Macro close-up) and the user's own, app-wide in
  **Settings › AI › B-roll Styles**: typed (a name and its wording) or imported
  from a text file (a `.md` skill or `.txt`), edited and deleted there.
- **Prompt from: Auto or Transcript**, per clip, Auto by default: Auto writes
  the prompt from the words under the clip in its style (as soon as the clip is
  added); Transcript uses the words as said, with the style.
  **Changed (the user, 2026-10-24): Auto or Manual.** Auto's prompt is read
  only, written once (Write Again writes it anew); Manual is a box to type in,
  starting from the words said under the clip, with the style's wording added.
  Each keeps its own prompt, so switching back and forth rewrites nothing. The
  planner's "why" line isn't shown. B-roll data v4 turns Transcript into Manual.
- **The planner is Apple's on-device model by default** (macOS 26's Foundation
  Models: free, offline, no key), OpenAI (`gpt-6.1-sol`, with web research) the
  other choice in Settings › AI. Research shows only with OpenAI.

**Progress (2026-10-23, `feat/ai-broll`).** Footage with a drawn region is
built: the `broll` feature (review, `broll.plan`, `broll.generate`,
`broll.apply`, `broll.estimate`), Settings › AI, the AI panel's B-roll tile,
the shots on the timeline, the region drawn on the canvas, and the footage
previewed in place (the contract's `sessionPreview`; a task's `failed` steps
clear what it marked busy). Checked headless against stand-ins
(`docs/tested.md`); the preview in place and the gate are for the user's
hand, with their keys. Later the same day: FLUX 3 and Seedance 2.5 added,
`broll.compare` (one shot with every model, each take kept and picked in
place) for the side-by-side run, and every API key in Settings › AI (the
Audio tab, which held only Auphonic's key, is gone). 2026-10-24: rebuilt as
a clip (the decision above): `broll.add`, `broll.plan`, `broll.generate`,
`broll.compare`, the `broll.use` command and the clip's B-roll tab; the
review, its timeline marks, the drawn region and the canvas preview are gone.
Later: an empty prompt shows the words said under the clip and, left empty,
Generate uses them (the user, 2026-10-24), so a first try needs no OpenAI key.
Animation (HyperFrames) next.

**Motion graphics: Beacon's own, learning from HyperFrames (the user,
2026-10-26; branch `phase-11-motion-graphics`).** HyperFrames (HeyGen, Apache
2.0) renders HTML in headless Chrome; Beacon doesn't embed it (no Chrome, no
render step, nothing opaque). It borrows the ideas: a catalog of blocks with
fields to fill, text animated word by word with a stagger, wipes and
draw-ons, counters, good easing curves, and later brand tokens (their
`frame.md`). Drawn live by the wgpu renderer, so a graphic scrubs, exports
as previewed and stays sharp. This is a deliberate exception to "no library
of preset animations" (§1): blocks are presets that expand into ordinary
clips.
- **A block is a group (the user, 2026-10-26).** Adding one places a plain
  group of callouts with animation blocks, one undo step; afterwards it is
  edited as any group (no fields to re-fill).
- **First blocks (the user, 2026-10-26):** Title, Lower third, Number, List.
- **The planner picks and fills (the user, 2026-10-26):** as B-roll's Auto,
  it reads the words under the range (or around the playhead) and picks the
  block and its fields (Apple's on-device model by default, OpenAI the other
  choice); fields can be typed instead.
- **What is already there:** callouts (text, rectangle, sketch draw-on),
  animation blocks on transform (position, scale, rotation, opacity) and crop
  (a wipe is an animated crop), groups.
- **What is new:** (1) easings beyond linear and ease in/out: ease out, ease
  in, and an overshoot (back out), in the schema, the easing menu and MCP;
  (2) a counter: a text callout whose number counts from one value to another
  over a span; (3) word-by-word text: a block lays its text out with
  `textLayout` and places one callout per word, each with its own delay
  (no renderer change); (4) the `motion` feature: the catalog, `motion.blocks`,
  `motion.add` (block, fields, at, length), `motion.plan` (words → block and
  fields), and an AI panel tile.
- **Order:** easings, counter, the catalog with Title, then Lower third,
  Number, List, then the planner and the tile; a UI flow and `tested.md`
  for each.

**Gate:** a range of one of the user's takes planned (with research),
generated, reviewed and placed in one undo step, in a drawn region, with
its cost shown before it runs.

#### Audio cleaning: Auphonic and the local polish, built in (the user, 2026-10-21; in Phase 11 beside B-roll since 2026-10-22)
Noise Removal (Phase 8.5) is good, but the user wants Auphonic's cleaning too:
what their `tuneup` CLI does (`~/tuneup`, v0.3.0, MIT, theirs: an Auphonic
preset in the cloud, then a local de-click, de-clip and de-ess pass), built
into Beacon, so audio is never edited outside it and nobody installs tuneup
(the user, 2026-10-21). They do it by hand today (3-shorts'
`coffee.cleaned.m4a`). **Plan only; nothing built.**

**The flow.**
1. **Pick it:** an **Auphonic** tile in Audio Effects, dragged onto an audio
   clip or double-clicked with audio clips selected (as Noise Removal is),
   or a clip's right-click (Clean with Auphonic…), or the command palette.
   It works on clips, not an effect drawn live: it makes new audio.
2. **Set it, in the properties panel** (a review, as Remove Silences opens:
   settings in the sidebar, Start and Cancel at the foot, ↩ and Esc):
   - **Preset:** the user's Auphonic presets (as `--list-presets` gives them),
     their tuneup default first.
   - **Polish:** de-click, de-clip and de-ess on or off (`--post-process`),
     with **De-esser** 0-1 (`--deesser`, 0.2).
   - **What is cleaned:** **Only the selected part** (default, the user's
     choice: the clips' audio as heard, bounced to WAV: fewer Auphonic
     minutes, one baked file) or **Whole recording** (the clips' source
     cleaned once, every clip of it switched over, edits kept and still
     re-cuttable).
   - **Before it runs:** the minutes to upload (Auphonic bills by length) and
     that the audio is sent to Auphonic on the user's account.
3. **Start:** a background job, its stage in the top bar and the import
   panel (Uploading, Auphonic: its status line, Downloading, Polishing, %);
   Esc or Cancel stops it. Editing carries on meanwhile.
4. **Done:** the cleaned file goes into the project's `media` folder as a new
   asset (named `<source>.cleaned.wav`, remembering preset and settings) and
   onto the timeline in one undo step:
   - Selected part (default): the cleaned audio on a new track under the
     range, the original clips muted (not deleted), so it can be undone or
     compared.
   - Whole recording: the source's clips switch to the cleaned medium (as
     Replace Media does, same length, every cut and fade kept); the original
     stays in the Media Bin, and a clip's **Original / Cleaned** switch in
     the audio tab flips back for a listen (A/B).

**How it runs.**
- **Beacon talks to Auphonic itself**, as tuneup does (its code ported, not
  depended on; no tuneup, no CLI): `GET /presets.json` for the preset list,
  `POST /simple/productions.json` with the WAV and the preset's uuid, `POST
  /production/<uuid>/start.json`, `GET /production/<uuid>/status.json` until
  done (status 3) or failed (2, with its message), then the output files
  from `/production/<uuid>.json`, downloaded into the project's `media`
  folder. A job in core (as the OpenAI transcriber's requests are), with
  progress and cancel; the upload streamed, not read into memory.
- **The polish pass with Beacon's own FFmpeg** (`adeclick,adeclip,deesser=
  i=<de-esser>`, as tuneup runs it), which needs `adeclick`, `adeclip` and
  `deesser` enabled in `scripts/build-tools.ts` (all LGPL; today it has only
  `afftdn`). It can also run alone, with no Auphonic, free and offline: a
  **Polish only** choice beside the presets.
- **The Auphonic key** in the Keychain as the OpenAI key is (Settings ›
  Audio), handed to tuneup, never written to logs or the project; offline,
  the tile greys out with why (as the online AI tools do).
- **Alignment is the main risk:** a swapped medium must line up to the
  sample. The preset must not cut silences or fillers or change speed
  (checked before starting: refused with which option to turn off), the
  output must be WAV or FLAC (no MP3/AAC padding), and the result is checked
  against the original (length within a frame, offset by cross-correlation)
  before it is used; a mismatch is refused with why, the file kept.
- **Agents:** `audio.clean` prepares it (clips, preset, polish, scope),
  `audio.cleanStart` runs it (the user's money: only when asked; Polish
  only costs nothing),
  `job_status` follows it, `audio.useCleaned` flips a clip back and forth.

**Selected-part cleaning done 2026-10-21 (first slice):** Audio Effects ›
Auphonic opens its settings in the properties panel (preset, Polish,
Sibilance, the minutes it costs); Clean runs `audio.clean` as a job (toast
with stages and Cancel); the result goes on a free track over the originals,
which get a new clip-level Mute (media v2). Key in Settings › Audio. Tested
against a stand-in server; a first real run waits on the user. Still to do:
Whole recording (swap the source, Original/Cleaned A/B), checking the preset
before upload, reusing a cleaned file when the same audio is sent again.

**Polish done 2026-10-21, as a live effect instead of a baked file:** an
Audio Effects tile, Polish (`adeclick`, `adeclip`, `deesser` added to
build-tools.ts), drawn like Noise Removal: free, offline, undoable, nothing
written. The Auphonic job's Polish choice puts this effect on the cleaned clip
rather than running a pass. Gotcha: these filters lose a seeked input's
timestamps, so the chain ends in `asetpts=N/SR/TB`.

**Decided (the user, 2026-10-21; Phase 11 since 2026-10-22):** built beside B-roll (both
are paid cloud jobs reviewed in the sidebar); the selected part by default.
**Open:** whether audio already cleaned is reused when exactly the same
audio is sent again (asked). Later: clean only what is kept, at export.

### Phase 12 — Device frames, and AI camera angles (a spike) (the user, 2026-10-22; device frames were Phase 11)
The user will bring a lot of information before any work starts: which
devices, how each frame looks and where its screen sits, what it's for.
Research and agree the design with them first; nothing is built before.
- **Device frame** (the user, 2026-10-17; moved here 2026-10-20): footage
  superimposed on a device (a phone, a laptop, a monitor), fitted into its
  screen.

#### AI camera angles: a spike, then a plan (the user, 2026-10-22; was in the backlog since 2026-10-15)
Not built in this phase until the spike says how: a new angle of the presenter
(a close-up, a side profile, a wide) from one take, made with AI and placed as
a cut to it, the take's own sound kept. The user's lead: **Seedance 2.5**.
Spending limit: as Phase 11's (a Settings value), not a worry for now.

**What is known (desk research, 2026-10-22).**
- Seedance 2.5 re-angles an existing clip in its **editing** task:
  `bytedance/seedance-2.5/reference-to-video` with `task: "editing"` on fal,
  the take as `@Video1` (MP4/MOV, 1.8-30.2 s, up to 200 MB, 300-6,000 px a
  side, 24-60 fps), an optional still for wardrobe and set; duration and
  aspect follow the source ("auto"), 4-30 s out, the length kept to within
  about 0.4 s. Prompts that work name the camera and lens and lock the rest:
  "Medium close-up straight in front of him at seated eye level, 50mm feel,
  locked", "a true 90-degree side profile at eye level", plus "camera
  placement and lens are the only things you are allowed to change", "real-
  time playback: no speed change, no retiming", no captions, text or logos.
  ([fal guide](https://fal.ai/learn/tools/how-to-create-multi-angle-video-seedance-2-5),
  [Kapwing](https://www.kapwing.com/resources/how-to-turn-one-clip-into-4-camera-angles-with-ai-seedance-2-5/),
  [Morphic](https://morphic.com/resources/how-to/seedance-2-5-guide))
- **Cost:** fal bills tokens (height × width × (input + output seconds) × 24
  ÷ 1024, ×0.6 with a video input; $0.0214 per 1,000 at 480p/720p, about
  $0.0234 at 1080p): a 20 s take was $5.18 at 480p, $9.24 at 720p, about
  $27.40 at 1080p (≈$0.26/s, $0.46/s, $1.36/s). A 480p draft can be finished
  at 1080p later from its `draft_id` (within seven days).
- **Sync is not guaranteed:** "An edit cannot guarantee frame-by-frame
  overlap with the source" (Morphic); Kapwing found speech and timing kept
  but says to check the lips. So the take's own audio stays the master and
  the generated picture is muted, checked for drift before it is placed.
- **Weak points:** the farther the camera moves, the more AI invents (faces
  drift, "inconsistent facial features"); exact text (a screen, a sign) is
  for post, so screen recordings never go through it, only the camera; 8-10 s
  pieces are the practical start.
- **Replicate** has `bytedance/seedance-2.5` ("provide a reference video and
  describe changes... preserves the original motion and camera work"), but its
  page doesn't say whether it has the editing task, its field names or its
  price ([Replicate](https://replicate.com/bytedance/seedance-2.5)). Phase 11
  uses the user's Replicate token, so this decides the provider.
- Earlier research (2026-10-15) still holds: no generation first (a punch-in
  crop of the 4K source with a small ±5° depth-parallax move) costs nothing
  and may cover close-ups; other routes are Runway Aleph 2.0 and an image
  model turning one frame then lip-sync (sync.so); no monocular 4D method
  holds beyond 10-15° yet.

**The spike (each answered with a real take, the user's go-ahead before any
paid call, a few dollars at 480p):**
1. Does Replicate's Seedance 2.5 do the editing task (one call with the
   schema read from its API), or is fal needed (a second key)?
2. On a 10 s camera take: a close-up, a side profile and a wide, at 480p:
   lips against the original audio (offset by cross-correlation of mouth
   movement, or by eye frame by frame), face and set drift, length kept.
3. The same against the free punch-in crop: is a close-up worth generating?
4. Longer takes: 8-10 s pieces cut at pauses (the transcript's), stitched;
   do the seams show?
5. Write the result into this plan as a spec in the B-roll review's shape
   (pick a range, the angle and lens, a draft at 480p with its cost, then
   1080p; applied as a cut on a camera track, one undo step), or park it.

### Phase 13 — Security audit (the user, 2026-10-16; was Phase 11 until 2026-10-21)
A review of what an attacker could reach, before Beacon is shared more widely,
with each finding fixed or written down as an accepted risk in
`docs/security.md`. What to look at:
- **The automation socket.** Any local process that can open the unix socket
  can drive the app (open, export, record the screen, camera and microphone).
  Who may connect (file permissions, a per-launch token for MCP clients), and
  whether recording over MCP needs the user's confirmation in the app.
- **Untrusted files.** `.trec`, `.cmproj`, `.beproj` and media are parsed by
  Beacon and its own FFmpeg: fuzz the `.trec` and project readers, keep
  FFmpeg's demuxers and protocols to what Beacon needs (`file` only, as
  today), and check paths read from projects (`..`, symlinks) never write
  outside where they should (`checkOutput`).
- **The webview.** What the window's RPC lets page script do (it runs
  commands, opens files and dialogs); no remote content or inline HTML from
  documents; the CSP.
- **Secrets and uploads.** The OpenAI key stays in the Keychain and never in
  logs, crash reports or project files; what is uploaded to OpenAI is only
  the audio chunks, and the UI says so.
- **Updates and the build.** In-app updates are signed and checked before
  they run; the app is signed (hardened runtime) and notarized; pinned
  dependencies with `bun run audit` (bun audit + cargo deny) in CI;
  third-party binaries built from pinned, hashed sources.
- **Permissions.** Screen recording, camera and microphone are asked for only
  when used, and the recorder can't run without the window knowing.
**Gate:** the audit's findings are fixed or accepted in `docs/security.md`,
and a fuzzing run of the file readers finds no crash.

### Phase 14 — Camtasia export (the user, 2026-10-16)
Handing a Beacon project to someone who keeps editing in Camtasia: File ›
Export › Camtasia Project… writes a `.cmproj` (its `project.tscproj` and the
media beside it), one way and best effort, as import is (§11). Not for
finished videos: MP4 and `.srt` export already covers those.
- **The mappers, reversed.** Each feature's `CamtasiaMapper` gains an
  export half for what it claims on import (clips, trims, speed, transform,
  opacity, animation blocks, cursor effects, motion blur, the effects both
  have); ticks map 1:1. What has no Camtasia equivalent (Beacon's captions
  as drawn, Border, CRT...) is listed in an export report, as import lists
  what it skips, never dropped silently. Core never names a feature: a
  feature that can't export says so through the contract.
- **The cursor.** Beacon's own recordings (`.brec`) have no cursor in the
  screen video (Beacon draws it from the click log), and Camtasia draws one
  only from `.trec` data. So a `.brec` screen is exported with Beacon's
  cursor rendered into an MP4 (Camtasia's cursor effects can't apply); an
  imported `.trec` goes as it is. Worth checking first whether Camtasia
  accepts a `.trec` Beacon writes, which would keep its cursor editable.
- **Versions.** Camtasia's format isn't documented and changes between
  releases: write the version the user's projects use, check the result
  opens in the Camtasia releases they have, and note findings in
  `docs/formats/`.
- Round trip as the test: a `.cmproj` imported then exported opens in
  Camtasia looking the same, on copies (never the user's projects).
**Gate:** a Beacon project with a `.brec` take, a `.trec`, animations and
captions opens in Camtasia with its edit intact, and the report lists what
didn't carry over.

### Phase 15 — Beacon learns how you edit (the user, 2026-10-19)
The AI tools start from what the user tends to do, not fixed settings: if
they always keep short silences but cut long ones, or keep "so" and "like"
but always cut "um", the next review opens that way. A preference changes
only after the user has made the same choice several times, never from one
edit.
- **Built for talking heads, long and short** (the user, 2026-10-19:
  Beacon is an editor for talking-head videos, long-form and Shorts). So
  what it learns is how this person tightens their own speech: pauses,
  fillers, retakes, the breath before a sentence, how hard a cut lands on
  the next word. And it learns it **per format**, because the same person
  edits a long video and a Short differently: a Short is cut tighter
  (shorter pauses kept, more fillers gone, no slow start) where a long
  video keeps pauses that let a point land. The format comes from the
  project's shape (9:16 is a Short, 16:9 long-form) and length, so
  nothing has to be set; each format has its own tallies, and a format
  with too few decisions yet falls back to the user's overall habits,
  then Beacon's defaults. Later, the same per-format memory can hold the
  rest of a talking-head edit the user repeats: caption style and
  position, punch-in zooms on emphasis, the camera's crop and layout.
- **What others do** (looked at 2026-10-19). Aftershoot's culling learns
  from the user changing its picks and weighs what they favour (emotion
  over sharpness, say); Imagen builds a Personal AI Profile from finished
  edits, fine-tunes it as more come in, and lets the user see and adjust
  what it learned (Profile Adjustments). Both need many examples: Imagen
  asks for 2,000–3,000 edited photos. Descript's Remove Filler Words sets
  each instance to Delete or Ignore but, as far as found, doesn't remember
  the choices. Beacon has far fewer decisions than a photographer has
  photos, so it should learn simple, readable rules rather than train a
  model.
- **What it learns from.** Every decision in a review (Remove Silences,
  Remove Filler Words, Remove Retakes): each item cut or kept, flipped from
  what Beacon proposed or not, with what describes it (a silence's length,
  screen action, where it falls in a take; a filler's word, the words
  around it, sentence start or middle). Later, edits made by hand after
  Apply (undoing an AI cut, cutting a filler the review kept) count too.
  Stored in the config folder, app-wide and local, never uploaded.
- **How it decides.** Counts per rule, not a black box: per filler word a
  keep/cut tally; for silences, where the user's keeps and cuts divide by
  length (the "shortest silence to cut" and "pause to keep" settings move
  to that point). A rule changes a default only with enough evidence: at
  least 5 decisions over at least 2 projects, about 80% one way (a Beta
  prior over the tally, so one or two choices never tip it), recent ones
  counting more than old ones. Adaptive thresholds from accept/reject
  feedback are well studied (Robertson and Walker on adaptive filtering;
  BPR for preferences from implicit signals), but simple tallies are
  enough to start.
- **What the user sees.** A review opens with the learned defaults and
  says so where they apply ("Kept: you usually keep 'so' (9 of 11)"), so a
  surprise can be traced and flipped; Settings gets a Learned section
  listing every learned preference with its evidence, each resettable, a
  Reset All, and a switch to turn learning off (as Imagen lets its profile
  be adjusted). Agents read the same list through the preferences, so they
  prepare reviews the user's way.
- **Memory: sentences the user can read and write** (the user, 2026-10-23).
  Settings gets a **Memory** tab: a list of single sentences, each one habit
  ("I cut silences over 0.8 s but keep the breath before a sentence", "the
  camera goes bottom-right at 30%, cropped to the face", "B-roll over every
  product name, abstract footage, never people"). The user adds, edits and
  deletes them; Beacon proposes new ones from repeated edits (the tallies
  above, and repeated crops, positions and B-roll placements), added only
  when the user accepts. The point: an agent asked for "a rough cut" over
  MCP reads the memory first and edits the user's way (removes only the
  silences they would, keeps the retakes they would, suggests B-roll where
  they usually put it, of the kind they use). Agents read it through a query
  (`memory.list`) and the MCP instructions say to; the reviews use the
  tallies for their defaults, and the sentences explain them.
  Open: whether a sentence is enforced as a rule (a number the review reads)
  or only read by agents as text; per format (Short/long) as the tallies are;
  whether agents may add sentences themselves (proposed, never saved
  without the user).
- Fits as its own feature folder with session state and a preference
  store; the reviews ask it for defaults rather than knowing about it.
  Open: per speaker as well as per format (a guest in an interview);
  whether a long video and its Shorts cut from it share decisions; how
  fast old habits fade; whether hand edits outside the reviews are a clear
  enough signal.
**Gate:** after the user cuts or keeps the same kind of item the same way
across a few projects, the next review opens that way and says why; a
Short and a long video each open with their own learned settings; one
choice alone changes nothing; Settings shows and resets what was learned,
per format.

**Gate (per feature):** the §6 checklist passes with no core changes.
At every gate: review `docs/shared-candidates.md` and decide what moves to
`orva-kit` (§4.1).

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Timeline UI eats the schedule | Automation ships first (Phase 3); canvas-drawn timeline; view-only first (Phase 4); build only actions with real usage |
| `.trec` format changes in a recorder update | `dump-trec` corpus test; reader fails loudly; Beacon's own recorder (Phase 6) |
| Preview/export mismatch | One WGSL source, generated pass manifest, parity golden tests |
| Preview performance on 120 fps / 4K sources | Proxies only in the UI; originals only in export |
| Scope creep | Section 1 is the scope; new work must be a feature folder |
| hance changes break Beacon | Shared `orva-kit` packages are versioned and pinned; parity tests run against them |
| Time spent on the tool instead of videos | Phase 2 go/no-go |

---

## 15. Open questions

- ~~Recording: keep using an existing recorder, or build a native one?~~
  Build one: Phase 6 (decided 2026-10-08).

- ~~Proxy codec and resolution: HEVC 1440p vs. ProRes Proxy?~~ HEVC, half
  size above 1920 px (2026-10-12, `docs/performance.md`).
- ~~Should the transcript feature reuse the `short` skill's word-timing
  pipeline or another transcription engine?~~ Neither: local whisper.cpp
  (Phase 3 decisions, §13).

---

## 16. Backlog (ideas parked, not scheduled)

### Film Look: looks as favourites (the user, 2026-10-21; not yet)
- **A custom look as a favourite:** sliders moved into a look of one's own
  (Custom in the Look menu) saved under a name, starred into Favorites like
  the effect tiles, and applied from there in one undo step. App-wide, as
  favourites are, and readable by agents (`favorites_list`).
- Hovering a look to preview it: Phase 11 (spiked 2026-10-22).

### Recording metadata features
`.trec` files also log clicks, keyboard shortcuts, scrolling, the focused app
and window titles (`docs/formats/trec.md`). Candidates: auto-zoom on
clicks/focused window, chapters or cut suggestions at app switches, keystroke
overlays, and richer agent context. This data is private and must stay local.

### CLI
A command-line client (`beacon run/query/export …`) as another thin client
of `@beacon/core`, like hance's CLI. Moved here on 2026-10-06 to focus on
MCP first; the core API is designed so adding it later needs no changes
elsewhere.

### From the 2026-10-09 review (5e Tier 2 leftovers, moved when Phase 5 closed)
- Split `ui/src/timeline.tsx` further: paint, and one file per drag kind.
- The canvas overlay should take the frame Electrobun applied as its truth
  instead of re-placing after resizes.
- `beacon_preview_free` joins the render thread on the main thread (a quit or
  remount waits up to a frame or a settle).

### From the 2026-10-09 review (5e Tier 3)
- Render engine: GPU objects created per draw (uniform buffers and bind
  groups per pass/mip level, full mip regeneration per frame), a texture
  pool that never shrinks; per-frame `Vec` per decoded frame; frame
  indexes (ffprobe) built on the render thread at first use and preroll
  errors aborting the rest of a scene's prerolls.
- Scrubbing: decoders thrown away on every proxy↔original switch (key by
  proxy too; cache `FrameIndex` in memory). (Stepping back a frame no
  longer restarts ffmpeg: frames are kept, `perf` 2026-10-12.)
- Locks: `flock` instead of pid checks (pid reuse after reboot, takeover
  race, two cores in one process); store a per-core id.
- RemoteCore: reconnect / fall back to local after the app quits; tell
  watchers the connection dropped.
- Audio points drift by sub-frame amounts when any point is edited
  (`volume` converts every point through snapped timeline seconds); work
  in media time and snap only new points.
- Features import each other (`volume` → `timeline`, stitching → cursor,
  groups, media) and name clip types (`"still"`, `"audio"`,
  `"transform"`); move shared helpers to model / `ActionContext`, use traits.
- Validation: unique animation and marker ids, `mediaStart ≥ 0`, `linkId`
  consistency; one `timelineTimeAt(clip, media)` (written four times).
- The UI harness and desktop build the init payload and forward events
  separately (the harness misses job/status/media); share one module.
  Parent directory not fsynced after the project rename; every edit
  pretty-prints and fsyncs the whole project on the main thread.
- Pan/wheel from Fit rounds the zoom to 0.1 %, nudging the picture.
