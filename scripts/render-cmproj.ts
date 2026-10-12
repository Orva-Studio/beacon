// Headless re-render of a Camtasia project (the Phase 2 gate).
// Usage: bun run render-cmproj <project.cmproj> <out.mp4 | out-dir/> [--from s] [--to s] [--frames 1,2,3]
import { importCmproj } from "@beacon/camtasia";
import { createRegistry } from "@beacon/features";
import { DEFAULT_CACHE_DIR, renderProject } from "@beacon/render";
import { secondsToTicks } from "@beacon/model";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [cmproj, out] = args;
if (!cmproj || !out) {
  console.error("usage: render-cmproj <project.cmproj> <out.mp4 | dir/> [--from s] [--to s] [--frames 1,2]");
  process.exit(1);
}
const registry = createRegistry();
const { project, report } = await importCmproj(cmproj, registry);
for (const line of report) console.error(`import: ${line}`);
const started = performance.now();
const { frames } = await renderProject(project, registry, {
  output: out.endsWith("/") ? { kind: "png", dir: out } : { kind: "video", path: out },
  from: opt("--from") ? secondsToTicks(Number(opt("--from"))) : undefined,
  to: opt("--to") ? secondsToTicks(Number(opt("--to"))) : undefined,
  frames: opt("--frames")?.split(",").map(Number),
  cacheDir: DEFAULT_CACHE_DIR,
  onProgress: (f, total) => process.stderr.write(`\r${f}/${total}`),
});
const s = (performance.now() - started) / 1000;
console.error(`\n${frames} frames in ${s.toFixed(1)}s (${(frames / s).toFixed(1)} fps)`);
