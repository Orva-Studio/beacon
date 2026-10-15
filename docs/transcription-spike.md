# Apple's on-device transcriber vs Whisper (spike, 2026-10-15)

Phase 6.5 asked whether macOS 26's `SpeechTranscriber` (Speech framework,
`SpeechAnalyzer`) could replace Whisper and drop the model download. Nothing
was switched.

**Setup.** The 5.3-minute fixture `audio.m4a` (a developer-tools video:
product names, SDKs, OCR, Rust), M5 Pro, macOS 26.6.2. Apple:
`SpeechTranscriber(locale: en-US)` through `SpeechAnalyzer.analyzeSequence`
(a 90-line Swift tool; its speech assets are installed and managed by
macOS). Whisper: Beacon's own pipeline (`transcribe`, bundled whisper-cli
1.9.2, `large-v3-turbo-q5_0`, chunked at pauses).

| | Apple SpeechTranscriber | Whisper large-v3-turbo |
|---|---|---|
| "<Product>'s parse endpoint" | the product name split into two words, "pass, endpoint" | right |
| "language-specific SDKs" | "STKs" | right |
| "want to parse documents" | "pass" | right |
| "part of the parse endpoint" | "past and point" | right |
| The product name (first mention), a feature name, Claude Code, Rust, CLI, OCR, struct, glyph, LLMs | right | right ("ClaudeCode" joined) |
| Other errors | "all when" for "or when" | a word lost at a few chunk edges ("really does [help]", "If I open [it]"), one garble ("MWAT" for "and what") |
| Time | 4.2 s | 32.6 s |
| Download | none (system assets) | about 575 MB, once |

**Reading.** Apple's transcriber is about 8× faster and needs no download,
but it got 4 of the technical terms wrong where Whisper got none; for this
channel's videos those are the words that matter (cutting by transcript,
captions). Whisper's own misses are at chunk edges, which Beacon's chunking
causes and can fix.

**Suggestion (not built).** Keep Whisper as the transcriber. Apple's could
be offered when the user says Not Now to the download: transcripts with no
download, marked as less accurate on technical words. Word times would need
checking against Whisper's DTW timings before Remove Silences relies on
them.
