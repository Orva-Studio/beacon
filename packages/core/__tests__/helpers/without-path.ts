/**
 * Run by bundled-tools.test.ts with PATH holding only macOS's own folders: imports, a frame and exports must
 * all work with Beacon's own ffmpeg and ffprobe. Prints what it made as JSON.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WHISPER_MODEL, transcribe } from "@beacon/media";
import { LocalCore } from "../../src";

const [recording, video, speech] = process.argv.slice(2) as [string, string, string | undefined];
const dir = mkdtempSync(join(tmpdir(), "beacon-no-path-"));
try {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [recording, video]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const frame = await core.frame(h, 1, { width: 320 });
  const sizes: Record<string, number> = {};
  for (const ext of ["mp4", "gif", "webm"]) {
    const output = join(dir, `out.${ext}`);
    const job = await core.export(h, { output, from: 0, to: 1, ...(ext === "mp4" ? {} : { size: { width: 320, height: 180 } }) });
    await job.done;
    sizes[ext] = statSync(output).size;
  }
  await core.close(h);
  // whisper-cli too, when this Mac has the model (it isn't part of Beacon's download).
  const words = speech && existsSync(DEFAULT_WHISPER_MODEL) ? (await transcribe(speech, { model: DEFAULT_WHISPER_MODEL })).words.length : undefined;
  console.log(JSON.stringify({ frame: frame.png.length, sizes, words }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
