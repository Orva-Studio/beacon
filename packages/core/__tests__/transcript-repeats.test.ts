import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WHISPER_MODEL, transcribe } from "@beacon/media";
import { findRetakes, RETAKE_DEFAULTS } from "@beacon/features/src/transcript/retakes";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
/** A take with lines redone straight after themselves, a name said twice, and pauses at room level between sentences. */
const TAKE = join(FIXTURES, "repeats.wav");

test.skipIf(!existsSync(TAKE) || !existsSync(DEFAULT_WHISPER_MODEL))(
  "words whisper drops from a quick repeat come back, so Remove Retakes finds them, and pauses above the silence threshold are pauses",
  async () => {
    const t = await transcribe(TAKE, { model: DEFAULT_WHISPER_MODEL });
    const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").length;
    // Before, the word after a dropped repeat took its time: 1.5 s, and 3 s for a dropped sentence.
    expect(t.words.filter((w) => w.end - w.start > 0.6 + 0.08 * letters(w.text))).toEqual([]);
    const groups = findRetakes(t.words, RETAKE_DEFAULTS);
    expect(groups.length).toBeGreaterThanOrEqual(7);
    // A name said again straight away: too short a line for `minWords`, a stutter.
    expect(groups.some((g) => g.every((take) => take.last - take.first < 2))).toBe(true);
    const pauses = t.speech.slice(1).filter(([a], i) => a - t.speech[i]![1] >= 0.3);
    expect(pauses.length).toBeGreaterThanOrEqual(27);
  },
  120_000,
);
