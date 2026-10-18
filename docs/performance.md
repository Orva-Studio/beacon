# Performance: playback, scrubbing and jumps

Research of 2026-10-12: where Beacon's time goes, what other editors do,
and what to change.

The benchmark project is the test fixtures' `project.cmproj` (`BEACON_FIXTURES`):
a 578 s edit with 304 clips over 22 video streams, among them a 3600×2336
tscc2 screen and a 4K camera. The small project is `small.cmproj`.

## Where Beacon is today
Measured in earlier sessions (PLAN §13 5e) and in the user's recordings:
- Every video source is an `ffmpeg` process piping RGBA (`beacon-render`
  `sources.rs`). A jump outside the pipe's read-ahead kills it and starts a
  new one with an accurate `-ss`, then waits for it to decode up to the frame.
- Proxy jumps ~50-65 ms per source, ~76 ms for a quick jump; settling on
  the originals 0.2-2 s per frame, and it blocks the render thread; jumps on
  the benchmark project's originals ~0.5 s. Playing costs 6.5 ms a frame.
- Every decoded frame crosses as RGBA: ffmpeg converts YUV on the CPU, writes
  it to a pipe, `beacon-render` copies it into a `Vec` and then `write_texture`s it.
  A 4K frame is 33 MB, so 30 fps is ~1 GB/s of copies per source.
- Keyframe spacing in the user's `.trec` files (`demo_1_opus55.trec`): the
  TechSmith screen stream (tscc2, 3600×2336) has a keyframe every ~98 frames,
  with 20% of its packets 1-byte "unchanged" ones; the 4K H.264 camera every
  ~29. Proxies are H.264 with a keyframe every 10 frames, at half size above
  1920 px.
- The timeline is a 2D canvas with a cached layer and only the playhead
  redrawn. It isn't where the time goes; leave it in the webview.

## What others do
- **Cap** (open source, Rust and wgpu, a screen-recording editor like ours;
  `crates/editor/PLAYBACK-FINDINGS.md` and its PRs #1447, #1598, #2014):
  - macOS decodes in process through AVAssetReader/VideoToolbox, with
    FFmpeg as the fallback. It keeps a pool of 3-5 decoders at different
    positions: it reuses one only when it is at most 0.5 s behind the wanted
    frame, otherwise it resets the nearest untouched decoder. Scrub decodes
    went from 139 to 42 ms on average, and p95 from 231 to 48 ms.
  - Frames stay on the GPU as IOSurfaces. Median playback CPU went from 86%
    to 18% and memory from 848 to 440 MB.
  - Prefetch is ahead only, as one cancellable sequential task started
    after the wanted frame is drawn. Prefetching behind the playhead cost
    decodes and broke scrubbing. Requests far apart are decoded as separate
    runs.
  - The first frame is rendered before the clock starts, assets are
    preloaded, and audio uses a persistent output stream and a progressive
    mix. Press-to-play went from seconds to 40-60 ms.
  - With in-process VideoToolbox decoding, its p95 decode is 1.4 ms (QHD)
    and 4.3 ms (4K); opening a decoder costs 6-123 ms.
- **Kdenlive/Shotcut (MLT)**: small proxies (640 px by default) and
  timeline preview rendering, which renders heavy stretches to a cache so
  they play and scrub at full speed.
- **Olive**: a disk cache of rendered frames, which keeps playback smooth
  after the first pass.
- **Scrub-friendly encodes** (mediamonks fast-image-sequence, ExoPlayer
  #10972): a random seek costs a decode from the last keyframe, and the only
  cure is more keyframes. All-intra (`-g 1`) is ~2× the size of GOP 5, and
  any frame is then one decode.
- **Zero copy on macOS**: VideoToolbox decodes into IOSurface-backed
  CVPixelBuffers, which `CVMetalTextureCache` turns into `MTLTexture`s.
  wgpu 30.0.1 (our pin) has the hooks: `wgpu_hal::metal::Device::texture_from_raw`
  and `wgpu::Device::create_texture_from_hal` (checked in the crate sources).
  Cap and rayplay use this path.

## Backlog: proxy builds run the fans (the user, 2026-10-12; done, see "Quieter proxy building")
Each proxy is an ffmpeg process decoding at full speed on every core (tscc2
has no hardware decoder; H.264 sources decode in software too), scaling,
then encoding with VideoToolbox; two run at once. To try, measured with
`powermetrics` / CPU time per minute of media and the build time:
- run them at macOS background QoS (`taskpolicy -b`, or `setpriority`
  PRIO_DARWIN_BG): efficiency cores and throttled I/O, slower but quiet;
- one at a time instead of two, and `-threads` capped;
- decode H.264/HEVC sources with VideoToolbox (`-hwaccel videotoolbox`),
  as exports do (a quarter of the CPU for the 4K camera);
- or build proxies with `beacon-decode` in process, decoding once for every
  stream of a recording instead of one ffmpeg per stream.

## Proxy format: HEVC measured, and what others do (2026-10-12)
30 s of opus-55 at proxy size (screen 1800×1168, camera 1920×1080), GOP 10,
VideoToolbox encoding; quality as PSNR against a near-lossless encode of the
same frames; seeks with `beacon-decode` in process (VideoToolbox decoding,
`seekbench <file> 0 1 4 960 30`):

| proxy | size | build | PSNR | jump p50/p95 | step back p50 |
|-|-|-|-|-|-|
| screen H.264 10 Mb/s (today) | 34.7 MB | 9.5 s | 40.4 dB | 30 / 41 ms | 31 ms |
| screen HEVC 8 Mb/s | 28.2 MB | 9.6 s | 40.2 dB | 19 / 35 ms | 22 ms |
| screen HEVC 5 Mb/s | 18.3 MB | 9.6 s | 37.9 dB | | |
| camera H.264 10 Mb/s (today) | 38.1 MB | 3.8 s | 44.3 dB | 32 / 52 ms | 34 ms |
| camera HEVC 5 Mb/s | 19.3 MB | 3.9 s | 44.1 dB | 15 / 22 ms | 16 ms |

- HEVC seeks faster through VideoToolbox (about a third to half off a jump)
  and is smaller: half for the camera at the same quality; the screen needs
  8 Mb/s to keep its text as sharp as today's (20% smaller). Below that,
  text softens (5 Mb/s: −2.5 dB).
- Build time doesn't change with the codec or size: reading the original is
  the cost (tscc2 on one core: 9.5 s per 30 s of screen; camera 3.8 s).
- Only with in-process decoding (branch `perf`); through an ffmpeg process
  with software decoding (main) HEVC would seek slower.
- **Others:** Final Cut Pro makes proxies as ProRes 422 Proxy or HEVC, at
  12.5-100% of the original size, on import or on demand, stored in the
  library or a chosen folder; the viewer chooses proxy or original. Resolve
  and Premiere offer ProRes/DNxHR/CineForm (intra, large files) or H.264/H.265
  (small, need a hardware decoder, which every Mac has).
- **To do after v0.1.0, with the other proxy changes (the user's call,
  2026-10-12):** ~~proxies as HEVC~~ (done, below); ~~Settings > General >
  Delete All Proxy Videos, with the space they use~~ (done
  2026-10-12); ~~the fans backlog above~~ (done,
  "Quieter proxy building" below).

### HEVC proxies (done 2026-10-12, branch `perf`)
Proxy version 3: HEVC through VideoToolbox (`hvc1`), 8 Mb/s for TechSmith
screen streams (`tsc2`), 5 Mb/s for every other video stream, GOP 10 and half
size above 1920 px as before. Version 2's H.264 files are deleted as each
asset's new proxy is built. `bun scripts/perf.ts` on a copy of the benchmark project
(after: the median of two runs with the proxies cached):

| | H.264 (v2) | HEVC (v3) |
|-|-|-|
| jump p50 / p95 | 50 / 211 ms | 34 / 117 ms |
| settle p50 / p95 | 173 / 291 ms | 163 / 237 ms |
| scrub forward, step p50 / p95 | 6 / 10 ms | 6 / 14 ms |
| scrub backward, step p50 / p95 | 10 / 50 ms | 13 / 34 ms |
| play 10 s | 0 skipped | 0 skipped |
| the benchmark project's proxies on disk | ~4.8 GB | 2.8 GB |

Building the benchmark project's 22 video streams took 459 s (1784 s of CPU), two jobs at
once as before; the quieter building below is the next change.

### Quieter proxy building (done 2026-10-12, branch `perf`)
One ffmpeg per file builds all its video streams side by side; H.264/HEVC/
ProRes are decoded with VideoToolbox and scaled on the GPU (`scale_vt`),
straight into the HEVC encoder (if VideoToolbox refuses a source, it is
built again in software); tscc2 has no hardware decoder and stays in
software. Settings > General > Build Proxies: **Quietly** (default) runs one
proxy at a time under `taskpolicy -b` (macOS background priority: efficiency
cores, throttled I/O); **Fast** runs two at once at normal priority.
`bun scripts/proxy-bench.ts <file> --mode quiet|fast` times one file;
`bun scripts/perf.ts <project> --cache <empty dir> --mode quiet|fast` times
a whole project's build. Measured with `/usr/bin/time` (CPU is user + sys,
ffmpeg included):

| | wall | CPU |
|-|-|-|
| demo_2.trec's 4K camera alone: software decode, CPU scale | 18 s | 81 s |
| the same, VideoToolbox decode, CPU scale | 33 s | 39 s |
| the same, VideoToolbox decode and `scale_vt` | 23 s | 3.5 s |
| the same, software decode at background priority | 47 s | 223 s |
| demo_2.trec (157 s, screen + camera), before | 20 s | 121 s |
| demo_2.trec, now (Quietly / Fast; the import's own probing included) | 26 / 25 s | 24 / 21 s |
| all of the benchmark project (22 video streams), before (two at once) | 459 s | 1784 s |
| all of the benchmark project, Quietly | 624 s | 585 s |
| all of the benchmark project, Fast | 460 s | 388 s |

- `scale_vt` is softer than the CPU's area scaling (camera PSNR 42.3 against
  46.8 dB, against an area or a bicubic reference alike); no difference is
  visible at 2x, and the originals replace the proxy 250 ms after scrubbing
  stops.
- Background priority costs more CPU seconds (efficiency cores run slower)
  but draws less power; what's left is mostly the single-threaded tscc2
  decode of busy screens.
- Preview timings on the new proxies are unchanged (jump 34 / 126 ms,
  settle 167 ms, warm cache). With an empty cache the first settles take
  seconds while the originals' frame indexes are built.
- Not measured: power (`powermetrics` needs root) and fan speed.

## Fast without proxies (investigated 2026-10-12, branch `perf`)
The user asked whether the originals could be fast enough on their own.

**tscc2 (the `.trec` screen codec), from FFmpeg 7.1's `tscc2.c`:**
- A frame is one slice per row of 16×8 macroblocks (292 rows at 3600×2336),
  each with its byte length up front and its own bit reader; a slice writes
  only its own rows. So a frame's rows can be decoded on separate cores.
- Coded macroblocks are intra (no motion compensation; DC prediction stays
  inside the block); skipped ones keep the previous frame's pixels. So the
  frame at a seek target is, per macroblock, its latest coded version since
  the keyframe; earlier versions needn't be decoded.
- The benchmark project's `demo_1.trec` (626 s): 121 keyframes (~150 frames apart), but
  only 3,357 of its 18,209 packets are coded; the rest are 1-byte "unchanged".
  A seek decodes 7 coded frames p50 (49 p95), and the keyframe (778 KB, every
  row) is most of it. Taking each macroblock only from its latest frame cuts
  the bytes decoded 8% p50, 49% p95: small, as the keyframe dominates.
- Measured with `seekbench`: demo_1's screen seeks in **16 ms p50, 85 ms p95**
  already (1.2 ms a frame). The 262/725 ms above was opus-55, a much busier
  screen. Row-parallel decoding would help those busy recordings most.

**The 4K H.264 camera is the bottleneck** (keyframes every 29 frames):

| demo_1 camera, `seekbench` | jump p50 / p95 | a frame straight through |
|-|-|-|
| VideoToolbox (today) | 141 / 212 ms | 5.9 ms |
| software, 4 threads | 97 / 165 ms | 4.6 ms |
| software, 8 threads | 67 / 108 ms | 2.5 ms |
| software, all cores (`threads 0`) | **57 / 83 ms** | 1.5 ms |

VideoToolbox through FFmpeg decodes one frame at a time (5.4 ms a frame even
with frames left on the GPU), while FFmpeg's frame-threaded software decoder
uses every core: ~14 ms of CPU a frame, so seeks cost a burst of CPU, and
playing a 4K camera this way would take about 0.4 of a core.

**The whole preview without proxies** (`bun scripts/perf.ts <project>
--no-proxies`: frame indexes kept, no proxies; `BEACON_DECODE_SOFTWARE=1` decodes
every source in software on all cores), the benchmark project at 1280×720:

| | jump p50 / p95 | settle | scrub fwd / back (fps) |
|-|-|-|-|
| proxies (HEVC, today) | 34 / 126 ms, then settle 163 / 237 ms | | 185 / 129 |
| no proxies, VideoToolbox | 171 / 286 ms (final) | ~3 ms | 62 / 63 |
| no proxies, software all cores | **99 / 227 ms (final)** | ~3 ms | 148 / 80 |

**Conclusions:**
- Without proxies, software decoding shows the final picture in 99 ms p50,
  about twice as fast as today's proxy-then-settle (≈200 ms to full quality),
  but the first picture comes later (99 against 34 ms) and p95 is 227 ms.
- Cheapest win either way: **settle on the originals in software on all
  cores** instead of VideoToolbox (camera seeks 141 → 57 ms p50).
- To drop proxies entirely and meet the target (≤ 100 ms p95, full quality):
  1. software decoding on all cores for seeks and settles, VideoToolbox (or
     the proxy) for playing, where its low CPU matters;
  2. a pool of decoders parked at different positions per source (Cap's),
     so scrubs near the last position decode a few frames;
  3. a row-parallel tscc2 decoder for busy screens (a port of `tscc2.c` and
     its tables, so LGPL like the rest of FFmpeg we link; keep it a separate
     crate);
  4. measure the CPU and fans of seeking and playing that way before
     deciding.

## Native VideoToolbox for the preview (done 2026-10-12, branch `perf`)
FFmpeg's VideoToolbox decoding waits for each frame before sending the next;
VideoToolbox itself can decode a seek's frames in parallel on the media
engine. A Swift test on demo_1's 4K camera (`VTDecompressionSession` fed
AVFoundation's samples): one at a time 61/96 ms a jump, asynchronous
33/48 ms, both ~0.15 ms of CPU a frame (software on all cores: ~14 ms).

`beacon-decode`'s `Decoder::open_native` (the preview's decoders; export keeps
FFmpeg's path): H.264/HEVC packets from libavformat go to an asynchronous
`VTDecompressionSession` described by the stream's avcC/hvcC, up to 8 at
once, frames put back in display order (4 held back for B-frames). Frames
are converted with the same swscale call as FFmpeg's path, so they are
byte-identical to the ffmpeg command line's (`matches_ffmpeg` checks both
paths on tagged, untagged, screen and camera sources; a GPU conversion,
`VTPixelTransferSession`, was 33 dB off at 960 wide as its scaler differs).

| | jump p50 / p95 | CPU a frame |
|-|-|-|
| demo_1 camera, FFmpeg's VideoToolbox | 141 / 212 ms | small |
| demo_1 camera, native (`seekbench <file> 1 native`) | **43 / 65 ms** | ~0.2 ms |

The benchmark project, `bun scripts/perf.ts`, CPU from `/usr/bin/time` (the whole run):

| | jump p50 / p95 | settle p50 / p95 | CPU |
|-|-|-|-|
| proxies, before | 34 / 126 ms | 163 / 237 ms | |
| proxies, native | **20 / 68 ms** | **100 / 142 ms** | 9.8 s |
| no proxies, native | 98 / 226 ms (final) | 4 ms | 17.0 s |
| no proxies, software all cores | 102 / 237 ms (final) | 4 ms | 72.0 s |

Proxy building's CPU, demo_1 (626 s, screen and camera, one ffmpeg, Quiet):
the screen is most of it. Decoding tscc2 is 6.5 s of CPU; its area scaling
to 4:2:0 12 s more; FFmpeg's 4:4:4 → NV12 conversion is very slow (72 s at
full size, 363 s scaling straight to NV12), so the scale goes to yuv420p and
FFmpeg converts that small frame for the encoder. More scaling threads only
add CPU: `-filter_threads 1` takes the build from 78.5 to 69.6 s of CPU at the
same 106 s (0.65 of an efficiency core on average); the camera, decoded and
scaled by VideoToolbox, is ~25 s of it, mostly system time.

Without proxies the native path is as fast as software on every core at a
quarter of the CPU; what is left is the tscc2 screen (no hardware decoder):
its decode on one core and its 4:4:4 → RGBA conversion (~4 ms a shown frame
at 960 wide). Next for quiet and fast without proxies: the row-parallel
tscc2 decoder for seeks, and frames kept on the GPU (step 3) so conversion
leaves the CPU.

## Re-run, and stills in process (2026-10-13)
The user felt playback and scrubbing get slower, and Space moved the playhead
without the canvas playing. The engine hadn't regressed: renaming the cache
folder (`~/Library/Caches/opentasia` → `Beacon`) had left every proxy record
pointing at the old folder, so each proxy failed to open, scenes weren't
drawn while moving or playing, and only the settle (from the originals)
showed. Now a job result is checked before use (`JobAnalyzerDef.revive`: the
proxy's files are looked up in the current cache folder, else it is
rebuilt), playback's audio skips a missing proxy copy, and the renderer reads
the original when a proxy can't be opened (`core/__tests__/playback.test.ts`).

`BEACON_PROFILE` showed the jumps' tail was images: each still was an
`ffprobe` and an `ffmpeg` process (50-125 ms for the project's screenshots)
every time it came back on screen, as textures go after 30 frames unused.
Images are now decoded in process by `beacon-decode` (identical pixels,
`images_match_the_ffmpeg_command_line`; 15-80 ms) and kept decoded (256 MB,
least recently used out), so showing one again is an upload.

The benchmark project, `bun scripts/perf.ts`, warm cache, two runs each:

| | 2026-10-12 (native) | proxies fixed | + stills in process |
|-|-|-|-|
| jump p50 / p95 / max | 20 / 68 / – ms | 19 / 68-75 / 178 ms | **19 / 58-64 / 83 ms** |
| settle p50 / p95 | 100 / 142 ms | 98 / 128 ms | 94 / 128 ms |
| scrub fwd / back (fps, p50) | | 233 / 156-172 | 231-236 / 135-156 |
| play 10 s | 0 skipped | 0 skipped | 0 skipped |
| CPU (user + sys) | 9.8 s | 9.1 s | 8.8-9.1 s |

What is left in a jump is decoding (proxies); the settle is the tscc2
screen's originals. Next, as below: frames kept on the GPU (step 3) and the
row-parallel tscc2 decoder for the settle.

## What to change, in order
Each step is measured before and after with the benchmark (step 0).
0. **Benchmark** (done 2026-10-12): `bun scripts/perf.ts <project>` opens
   a copy, waits for its proxies and times the offscreen preview (at
   1280×720, the frame read back included): 40 jumps, 10 settles on the
   originals, 90 scrub steps of two frames each way, and 10 s of play.
   Baseline on the benchmark project (578 s, a 3600×2336 tscc2 screen and a 4K camera,
   GOP-10 proxies):

   | | p50 | p95 | max |
   |-|-|-|-|
   | jump (proxy) | 86 ms | 281 ms | 435 ms |
   | settle (originals) | 551 ms | 934 ms | 1777 ms |
   | scrub forward, step | 6 ms | 29 ms | 76 ms |
   | scrub backward, step | 69 ms | 93 ms | 101 ms |

   Scrubbing runs at 163 fps forward but 15 fps backward: every step back
   restarts ffmpeg. Playing 10 s showed 299 of 300 frames.

   **Targets:** a jump ≤ 100 ms at p95 at full quality
   (no visible settle), backward scrub ≥ 30 updates/s, forward ≥ 60,
   press-to-play ≤ 60 ms, no dropped frames playing.
1. **All-intra scrub proxies: measured, and not worth it alone.** These are
   30 s of opus-55's screen at proxy size (1800×1168), timed with one ffmpeg
   process per seek as the preview does now:

   | proxy | size | seek + 1 frame | decode a frame, 1 thread |
   |-|-|-|-|
   | H.264 GOP 10, 10 Mb/s (today) | 35 MB | 68 ms | 3.6 ms |
   | H.264 all-intra, `-q:v 55` | 80 MB | 59 ms | 6.7 ms |
   | H.264 all-intra, 30 Mb/s | 110 MB | 71 ms | |
   | ProRes 422 Proxy (VideoToolbox) | 163 MB | 55 ms | 4.5 ms |

   Starting and stopping ffmpeg alone costs 28 ms, and opening, probing and
   seeking cost most of the rest. A GOP-10 jump decodes ~5 frames on average
   (~18 ms). So all-intra saves ~10 ms today for 2.3× the disk. It pays off
   only with step 2, where a jump becomes one ~5-7 ms decode instead of up to
   ten (~36 ms). Make that switch together with step 2.
2. **Decoders in process, kept open: done 2026-10-12 (branch `perf`).**
   `beacon-decode` is a C shim over libavformat/libavcodec (FFmpeg 7.1 from Nix
   for now; Phase 6.5 bundles its own build), called from a thread per
   decoder that stays open across seeks; VideoToolbox decodes H.264/HEVC/ProRes
   (byte-identical to the ffmpeg command line's frames, colour matrix
   included: swscale has to be given each frame's matrix and range before it
   initialises, or BT.709 sources come out as BT.601; `beacon-decode`'s test
   checks tagged, untagged, screen and camera sources). The benchmark project, same benchmark:

   | | before | after |
   |-|-|-|
   | jump p50 / p95 | 86 / 281 ms | 47 / 146 ms |
   | settle p50 / p95 | 551 / 934 ms | 172 / 234 ms |
   | scrub backward, step p50 | 69 ms (15 fps) | 35 ms (29 fps) |
   | scrub forward, step p50 | 6 ms | 5 ms |
   | play 10 s | 1 skipped | 0 skipped |

   10 s of the small project exports in 3.8 s instead of 5.1 s. Measured alone
   (`cargo run --release -p beacon-decode --example seekbench`), an exact-frame
   seek on opus-55's originals costs: 4K H.264 camera ~100 ms p50 (either
   decoder); the 3600×2336 tscc2 screen 262 ms p50 / 725 ms p95, because its
   keyframes are ~98 frames apart and FFmpeg's tscc2 decoder is single
   threaded (5-13 ms a frame). The screen's originals are now what limits
   the settle; options in step 2b.
   Canvas edits (`scripts/perf.ts`, at a settled frame, one `clip.set` a
   pointer move as the canvas sends them): move, resize and crop ~6 ms a step
   (p95 ≤ 10 ms), select and canvas zoom ~1 ms. The engine isn't what limits
   canvas drags; anything slower felt in the app is the window side.
   2a. **Frames kept for steps back (done 2026-10-12)**: each decoding thread
   keeps the frames it decodes within 0.5 s before a start (references, no
   copies; 256 MB at most), so a step back is served without a seek.
   Backward scrubbing 35 → 7 ms a step p50 (27 → 141 fps); frames are byte
   identical to fresh decodes. Keeping more costs: tscc2 updates its last
   frame in place, so a held frame makes it copy 3600×2336 a frame (the
   settle rose to 197 ms p50 until the window was cut to 0.5 s; now 150 ms).
   Where a frame's time goes (`BEACON_PROFILE`, a 10 s export of the benchmark project): decoding
   waits 2.8 ms, the texture upload 1.8 ms, drawing and readback 5.1 ms; the
   RGBA conversion on the decoding threads 1.3 ms (4K camera) to 4 ms (screen).
   That is what step 3 removes: CPU and fans more than latency.
   2b. **The screen's settle**: settle in two stages: an intra proxy at once,
   the originals behind it without blocking the render thread, swapped in
   when ready (they differ only when zoomed in). Or a pool of decoders parked
   at keyframes (Cap's), or a faster tscc2 decoder.
   The original plan for this step:
   - H.264/HEVC/ProRes: `beacon-media` already demuxes the MP4 streams, so its
     samples go straight to a `VTDecompressionSession`. That needs no
     AVFoundation container support for `.trec` and gives exact frame
     control: seek is "feed from the last keyframe".
   - tscc2: FFmpeg's decoder (libavcodec, LGPL, dynamically linked, the same
     build Phase 6.5 bundles) fed by the same demuxer, outputting planar
     YUV. Skip the 1-byte "unchanged" packets without decoding.
   - Per source, a pool of 2-3 decoders at different positions (Cap's rule:
     reuse within 0.5 s behind the frame, otherwise reset the nearest idle
     one). Proxy and original decoders live side by side, as `SourceTex.spare`
     already does.
   This removes the process start and the pipe, and the settle stops
   blocking the render thread: decode runs on its own threads, the newest
   request wins, and stale ones are dropped.
3. **Zero copy to the GPU**: VideoToolbox frames as IOSurface → `MTLTexture`
   → wgpu texture, with NV12 planes converted in the shader. tscc2's planes
   are uploaded as is (no CPU RGBA) and converted the same way. This drops
   the 33 MB per 4K frame of copies and the CPU colour conversion. Keep
   `write_texture` as the fallback and for the export worker until its
   output is checked against today's (the parity test).
4. **Prefetch ahead, and a small decoded-frame cache**: while playing,
   decode ahead of the playhead on the decoder threads (the preroll at cuts
   stays). Keep recently shown frames as textures (a budget in MB) so
   scrubbing back over a stretch is free. Nothing is prefetched behind the
   playhead.
5. **Audio start**: keep the cpal stream open while paused and produce the
   mix progressively from the playhead. Measure press-to-play first; the
   mix is an ffmpeg process today.
6. **Later, if the benchmark says so**: move `evaluate()` into Rust only if
   the per-frame scene evaluation and JSON across the FFI show up in the
   profile (playing is 6.5 ms a frame in total today). Add a render cache
   of composited frames (Olive/Kdenlive) for heavy effect stacks.

Steps 2-3 are the big ones and need no change outside `beacon-render`/`beacon-ffi`
(`Pixels` becomes a texture source) except deleting the ffmpeg spawn path for
preview. Export keeps its own decode path until in-process decoding matches
it frame for frame.

## Hot paths from the 2026-10-17 review (branch `perf/hot-paths`, 2026-10-18)

Measured before changing anything (`docs/review-2026-10-17.md` §2), on a copy of the user's largest project
(304 clips, 1080p30), in the UI harness (headless Chromium, React's development build) or by script:

| What | Before | After |
|---|---|---|
| Timeline's cached layer redrawn by 20 proxy/transcript progress messages (P1) | 20 redraws, 25 ms | 0 |
| The same layer over 30 playhead moves with a group open (P2) | 30 redraws (every tick) | 0 |
| The shell (App, top bar, toolbar, transport, Properties, timeline) over 60 playhead moves (P3) | 60 renders each, 1.4 ms a tick | not changed: under a millisecond to win in a production build |
| Saving the whole project after an edit (P5): stringify, write, fsync | 0.6 ms (0.9 worst) | not changed |
| One drag step (`clip.set`, coalesced) on the 304-clip project (P6, P7) | 2.2 ms p50, 5.4 worst; whole-document validation 1.3 of it | |
| Export's audio mix (P15), 578 s from 27 segments of 2 files | 9.6 s, of which the AAC encode is 9.5 and opening 27 inputs about 0.2 | not changed: it runs beside the video render, so no export waits for it |
| First audio at play start (P15), 27 / 18 / 11 inputs | 56 / 50 / 41 ms | not changed |
| Importing 7 fixture files (P16): probe and loudness, one file at a time | 0.67 s | 0.26 s, four at a time |
| Waveforms sent to the window when one finishes (P11) | every asset's | the one that finished |
| Missing-media check on every edit and every 3 s (P10) | one `existsSync` per asset, sent only on a change | not changed |
| Preview from the originals on the same project, 1280×720 (`perf.ts --no-proxies`), decode buffers reused (P19) | jump p50 95 ms, settle 4.2, scrub forward 3.5 / backward 6.9 | jump 91-98, settle 3.7 (both runs), forward 3.5-3.6 / backward 6.5-7.2: within a run's noise, but no 33 MB allocation per CPU-decoded frame |
| Stills drawn again when they come back (P20): only images were cached; a cursor shape costs 9 ms (27 worst) | 13 cursor loads in a `perf.ts` run | 8 (one per shape), 5 served from the cache |

