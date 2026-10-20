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

## Word timings by transcriber (Phase 7, 2026-10-15)

Beacon now offers three transcribers (Settings › General › Transcripts, or
`preference_set` for agents): Whisper on this Mac, Apple's SpeechTranscriber
(`beacon-speech`, a small Swift tool), and Whisper through OpenAI's API
(`whisper-1`, the API model that returns word timestamps). Each one's word
times were checked against local Whisper's DTW times on three fixtures (the
5.3-minute `audio.m4a` and two recordings, 3.6 and 1.8 minutes; 1,380 words
from local Whisper). The times compared are Beacon's stored ones, after
fitting to detected speech.

| | Apple SpeechTranscriber | OpenAI API (`whisper-1`) |
|---|---|---|
| Words (local Whisper: 1,380) | 1,391 | 1,388 |
| Local Whisper's words also found | 96% | 97% |
| Word start, distance from local's: median / p90 / p99 | 160 / 460 / 990 ms | 0 / 280 / 510 ms |
| Word end: median / p90 | 145 / 470 ms | 0 / 280 ms |
| Starts within 50 ms of local's | 35% | 65% |
| Time for the 5.3-minute file (local: 22-25 s) | 4.3 s | 12-24 s |

- **Before fitting, measured against the audio**: at the start of each stretch
  of speech, Apple's first word starts a median of 80 ms after the sound and
  its last word ends 20 ms before the sound stops. The API's are 40 ms after
  and 40 ms before.
- **Where Apple and local Whisper differ by 300 ms or more** (322 words), the
  API agrees with local Whisper 167 times and with Apple 78 times. Apple's
  word times are the loosest of the three.
- **Remove Silences** cuts where the audio has no detected speech, not at gaps
  between words. So its cuts are the same with every transcriber: all 55
  silences of 0.6 s or more were identical. The choice matters for cutting by
  words (Remove Filler Words, `transcript_cut`) and for captions.

Fixes the check found:
- Apple's word starts can come more than 0.3 s before a stretch of speech
  begins, so Beacon dropped those words. A word now goes to the stretch of
  speech it overlaps most.
- Inside continuous speech, the quiet point between two words is searched for
  around each word's start. The search assumed Whisper's DTW lag (0.25 s
  before the start, 0.03 s after); it is now ±0.15 s for Apple and the API.
- Sent minutes of audio at once, the API skipped repeated phrases (retakes):
  197 words where local Whisper had 286. It now gets the same short,
  pause-split chunks as local Whisper, four requests at a time.
- Over noise with no speech (typing, clicks), the API invented words ("Bye"
  four times, "You", "www"). Words in segments with `no_speech_prob` above 0.6
  and `avg_logprob` below -0.5 are now dropped. Every invented word was in a
  segment at 0.78 or more; real speech stayed at 0.49 or less.
