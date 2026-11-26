#!/usr/bin/env bun
/**
 * `beacon` for cloud agents' Linux machines: the MCP server (packages/mcp/src/main.ts) compiled for linux-x64 and
 * linux-arm64, each packed as `beacon-linux-<arch>.tar.gz` holding `beacon`. The release publishes them beside the
 * DMG; skills/references/cloud.md says what they do away from a Mac.
 *
 *   bun scripts/build-cli.ts [out]   (default dist)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const out = resolve(process.argv[2] ?? "dist");
const ENTRY = join(import.meta.dir, "../packages/mcp/src/main.ts");
mkdirSync(out, { recursive: true });

for (const arch of ["x64", "arm64"]) {
  const work = mkdtempSync(join(tmpdir(), "beacon-cli-"));
  try {
    await $`bun build --compile --minify --target=bun-linux-${arch} ${ENTRY} --outfile ${join(work, "beacon")}`.quiet();
    await $`tar -czf ${join(out, `beacon-linux-${arch}.tar.gz`)} -C ${work} beacon`;
    console.log(`beacon-linux-${arch}.tar.gz`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
