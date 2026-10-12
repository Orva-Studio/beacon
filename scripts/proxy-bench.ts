// Builds one file's proxies into a temporary cache and prints the build time
// (docs/performance.md, the fans backlog). Wrap it in `/usr/bin/time -l` for CPU time.
//   bun scripts/proxy-bench.ts <media> [--mode quiet|fast]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LocalCore } from "@beacon/core";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { mode: { type: "string", default: "quiet" } } });
const source = positionals[0];
if (!source) throw new Error("usage: bun scripts/proxy-bench.ts <media> [--mode quiet|fast]");
const dir = mkdtempSync(join(tmpdir(), "ot-proxy-bench-"));
try {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  if (values.mode !== "fast" && values.mode !== "quiet") throw new Error("--mode is quiet or fast");
  core.setJobMode(values.mode);
  const h = await core.create({ path: join(dir, "bench.beproj") });
  const { assets } = await core.import(h, [source]);
  const t0 = performance.now();
  await (await core.analyze(h, "proxy", assets[0]!)).done;
  console.log(`${source.split("/").pop()}: proxies built in ${((performance.now() - t0) / 1000).toFixed(1)} s (${values.mode})`);
  await core.close(h);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
