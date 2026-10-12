// Phase 1 gate: read every .trec under a folder through the native reader and
// dump its streams, cursor track and clicks. Fails if any file errors or has
// TSCM chunks the reader doesn't know.
// Usage: bun run dump-trec [root=~/client-videos] [--out dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Glob } from "bun";
import { MouseButton, Trec } from "@beacon/media";

const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
const outDir = values.out;
const root = positionals[0] ?? `${process.env.HOME}/client-videos`;

const files = (await Array.fromAsync(new Glob("**/*.trec").scan({ cwd: root, followSymlinks: false }))).sort();
const failures: { path: string; error: string }[] = [];
const versions = new Map<string, number>();
let cursorSamples = 0;
let clicks = 0;
const started = performance.now();

for (const rel of files) {
  try {
    using trec = Trec.open(join(root, rel));
    const { info } = trec;
    const cursor = trec.cursor();
    const buttons = trec.buttons();
    cursorSamples += cursor.t.length;
    clicks += buttons.kind.filter((k) => k === MouseButton.leftDown).length;
    versions.set(info.recorder.version, (versions.get(info.recorder.version) ?? 0) + 1);
    if (outDir) {
      const dump = {
        path: rel,
        recorder: info.recorder,
        duration: info.duration,
        streams: info.streams,
        cursor: Array.from(cursor.t, (t, i) => [t, cursor.x[i], cursor.y[i]]),
        buttons: Array.from(buttons.t, (t, i) => [t, buttons.kind[i]]),
        cursorImages: info.cursorImages,
        cursorImageChanges: info.cursorImageChanges,
      };
      const file = join(outDir, `${rel.replaceAll("/", "__")}.json`);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, JSON.stringify(dump));
    }
  } catch (e) {
    failures.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`${files.length} .trec files read in ${seconds}s`);
console.log(`Recorder versions: ${[...versions].map(([v, n]) => `${v} (${n})`).join(", ")}`);
console.log(`cursor samples: ${cursorSamples}, left clicks: ${clicks}`);
console.log(`errors: ${failures.length}`);
for (const f of failures) console.log(`  ${f.path}: ${f.error}`);
if (outDir) console.log(`dumps written to ${outDir}`);
if (failures.length || !files.length) process.exit(1);
