import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WHISPER_MODEL, transcribe } from "@beacon/media";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TAKE = join(FIXTURES, "repeats.wav");

// Each short chunk heard alone cost Whisper a whole 30 s window, which kept the GPU (and the fans) going for over a
// minute on a 7½-minute take. Packed, it hears about the take's speech in 28 s files, a few more where a chunk with a
// dropped word is heard again alone.
test.skipIf(!existsSync(TAKE) || !existsSync(DEFAULT_WHISPER_MODEL))(
  "local Whisper hears chunks packed into ~28 s files, not each in a window of its own",
  async () => {
    const steps: number[] = [];
    const t = await transcribe(TAKE, { model: DEFAULT_WHISPER_MODEL, onProgress: (f) => steps.push(f) });
    const files = Math.round(1 / Math.min(...steps.filter((f) => f > 0)));
    const speech = t.speech.reduce((n, [a, b]) => n + b - a, 0);
    const chunks = t.speech.length;
    console.log(`${speech.toFixed(0)} s of speech in ${chunks} regions: ${files} files`);
    expect(files).toBeLessThanOrEqual(2 * Math.ceil(speech / 28) + 2);
    expect(files).toBeLessThan(chunks / 3);
  },
  120_000,
);
