# Shared-code candidates (PLAN §4.1)

Pieces Beacon copied or wrote instead of sharing through `orva-kit`,
reviewed at each phase gate.

| Piece | Beacon | hance | Why not shared yet | Revisit |
|---|---|---|---|---|
| Fullscreen-pass WGSL prelude, separable Gaussian | `engine/crates/beacon-render/src/prelude.wgsl` | `core/shaders/fullscreen.vert.wgsl`, `blur.frag.wgsl` | Different binding layouts; Beacon uses none of hance's film-look shaders, so the "both use it now" rule fails (decided 2026-10-07; unchanged at the Phase 3 gate). | Phase 4 gate |
| Pass manifest (named WGSL passes + steps, loaded at runtime) | `RenderPassDef` in `@beacon/model`, `PassDef` in beacon-render | `wgpu/passes.rs` (compiled in) | hance compiles its passes in; would need hance to adopt runtime loading first. | After Phase 2 gate |
| ffmpeg/ffprobe helpers | `@beacon/media` `probeMedia`, beacon-render `sources.rs` | `core/probe.ts` | Small; needs differ (frame indexes, tscc2; Phase 3 added whisper audio extraction, which hance doesn't need). | Phase 4 gate |
| Agent skill tooling (skill docs → instructions, prompts, resources) | `skills/`, `packages/mcp/src/docs.ts` | `scripts/gen-skills.ts`, `cli/commands/skills.ts` | hance compiles skills into CLI subcommands, Beacon into MCP instructions/prompts/resources; the shared part is ~20 lines of markdown loading (decided 2026-10-08). | Phase 4 gate |
| Film look: colour settings, halation (threshold, per-channel scatter, ring recombine), grain, vignette, the sRGB↔linear bracket; hance's 41 looks as data | `features/src/film-look/` (`film-look.wgsl`, `looks.json`, `hlook.ts`) | `core/shaders/{color-settings,threshold,scatter-blur,halation-combine,grain,vignette,colorspace}.frag.wgsl`, `core/constants/render.json`, `presets/*.hlook` | Ported, not shared (the user, 2026-10-20): Beacon's passes share one prelude and a params array, hance's each have their own uniforms, so the shared part is the maths as WGSL functions; `orva-kit` doesn't exist yet. A fix to either side's look should be copied to the other until it does. Checked against hance 0e5f844 on one frame with CineStill 800T (hance's extras off): 49.5 dB. | When `orva-kit` is made |
