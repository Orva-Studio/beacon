# Beacon — plan

Beacon by Orva: a macOS-only screen-recording editor that owns its project
format and renderer, so it can be fully automated and never breaks on someone
else's update. Beacon is the **editor + renderer + automation surface**, and
then the recorder too (Phase 6).

This document is architecture-first. The goal is that adding a feature later is
"add one folder", not "touch ten layers".

**Status (2026-10-13):** Phases 1–5.5 are done (Phase 3: headless Claude Code
rough-cut a recording from its transcript, laid it out, zoomed and exported
it; Phase 5 closed after the user's runs in the app, cut as v0.1.0; Phase 5.5,
the new look, closed 2026-10-13 with more to add later). Video is decoded in
process (`beacon-decode` over FFmpeg's libraries), with frames kept for steps
back (`docs/performance.md`). **Phase 6** (the recorder) is under way: after
its spike, the recorder process records `.brec` takes (§13 Phase 6). Packaging
as one self-contained app is Phase 6.5.
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
features  → model
media     → model
camtasia  → model + features + media
render    → model + media    (TS wrapper over beacon-ffi / beacon-worker; derived-data cache)
core      → model + features + media + camtasia + render   (the API)
ui        → model + features (renders the replica; talks to core via RPC)
mcp       → core             (the `beacon-mcp` server)
desktop   → core + ui (bundled dist)
```
- `model` depends on nothing internal, so it can be tested in isolation.
- **`mcp` and `desktop` only ever import `core`.** Nothing else talks to the
  engine, the media layer or project files directly.
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
Media is referenced by absolute path plus a content fingerprint so moved files
can be relinked. Saves are atomic (write temp → fsync → rename). A lock file
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
- **Command palette** (planned, Phase 7) lists every registered command, so
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
(`accent-color`), not WebKit's blue. Still to come: a camera preview and a
microphone level in the dialog, the sync check in Settings, and checking the
whole flow in the app with the user.

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
from ordinary speech, with no test (check whether the user's Elgato offers an
audio device). Camtasia has neither: its only fix is moving the clip by hand.
A clap test is the fallback when the speakers can't be used; estimating sync from lip movement is for the AI features after Phase 6.
To check with the user's setup (Blue Yeti, Elgato): the offset, and a long
take's `driftPpm` (a USB microphone keeps its own clock).

**Gate:** record a video with screen, camera, mic and system audio, then edit
and export it in Beacon alone.

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
Performance research (2026-10-12, `docs/performance.md`): the user wants
fast playback and scrubbing, done in Rust and
Apple's frameworks. Its order: a benchmark first, then all-intra scrub
proxies, item 2's in-process decoders kept open (a small pool per source),
zero-copy VideoToolbox frames into wgpu, prefetch ahead with a small frame
cache, and audio start. When it starts is the user's call.
**Gate:** the app, copied to a Mac without Homebrew or FFmpeg, opens a
`.cmproj` and a `.trec`, edits, plays, transcribes and exports MP4 and GIF.

### Phase 7 — Growth
New features, each as a folder in `packages/features`.
- **Command palette** (the user, 2026-10-12; Phase 7 or later): a key (⇧⌘P
  or ⌘K, to pick then) opens a search over every action, command and menu
  item by its name and description, showing its shortcut, and runs it through
  the same path as keys and menus (`host.run`). The registry already holds
  everything it lists (ids, descriptions, keymap), so it is mostly UI built
  from `ui/src/controls/` (a Modal with a filtered list); later AI features
  can add entries to it.
- **A window per project** (the user, 2026-10-12): several projects open at
  once, each in its own window (macOS's Merge All Windows then
  gives tabs). Core already holds several projects and shares one clipboard
  between them (copying clips across projects works); the desktop main
  process keeps one `current` project and view, so its state (project, live
  view, thumbnails, proxy progress, RPC) moves to a per-window record, and
  menus and keys go to the focused window. Playing in one window pauses the
  others. Mostly `packages/desktop`; the UI and core are unchanged.
- **Filmstrip thumbnails** (the user, 2026-10-12): video and screen clips
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
- **App settings as commands, then dialogs an agent can open** (the user,
  2026-10-12; found driving the app over MCP to check Phase 5.5). §7 says
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
- **Film look from hance** (the user, 2026-10-13; small, not hance's full
  grading): a "Film Look" feature folder, one WGSL pass and a few of hance's
  sliders (strength, grain, halation, fade, warmth, or whichever few hance
  treats as its core), so the inspector, undo, copy properties and agent
  commands come from the schema; hance's `.hlook` files import onto those
  sliders, with what doesn't map listed in an import report rather than
  dropped. The shader comes through `orva-kit` (§4.1) rather than a copy, so
  fixes reach both; preview/export parity as for every pass. Open: what a
  `.hlook` holds (values, a LUT, or both) decides whether the renderer
  needs LUTs.
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
  detection for the head guide is later, if wanted.
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

### Background audio cleaning (tuneup / Auphonic)
Clean each source recording's audio in the background while editing and swap
it in when ready, using `~/tuneup` (Auphonic + local ffmpeg de-click/de-clip/
de-ess). Parked because Auphonic is billed by audio length, and cleaning whole
raw recordings (bad takes included) costs more than cleaning the final cut.

Notes for when it is picked up:
- Fits as an `audio-clean` feature + background job in the media service,
  stored as a derived asset in `cache/`, with an original/cleaned toggle per
  source and agent commands (`audio.clean`, `audio.useCleaned`).
- tuneup needs a library entry point (returns/throws/progress instead of
  `process.exit` and console output).
- Alignment is the main risk: the Auphonic preset must not cut silence or
  filler words, output must be WAV/FLAC (no MP3/AAC padding), and the result
  must be checked against the original for offset.
- Cheaper variants to compare:
  - **Clean only the kept segments at export**, so you pay only for minutes
    in the final video; you wait at the end and it's tied to one edit.
  - **Local-only cleaning**, free and offline: tuneup's ffmpeg pass, and/or a
    local noise-reduction model (e.g. DeepFilterNet). Could run in the
    background on whole sources at no cost, with Auphonic kept for final
    export.

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
