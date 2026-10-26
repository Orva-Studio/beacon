#!/usr/bin/env bun
/**
 * Stages the app's `engine` folder (packages/engine/target/bundle, which electrobun.config.ts copies whole):
 * beacon-ffi, the worker and the recorder, and Beacon's own ffmpeg, ffprobe and whisper-cli with the FFmpeg
 * libraries they load. The libraries are found through @rpath beside whatever loads them, so the folder works
 * wherever the app is, on a Mac with no FFmpeg. Run after `bun run build`. With `--mcp`, also beacon-mcp, compiled,
 * so agents get Beacon's tools from the app alone (it finds the engine and tools beside itself).
 *
 *   bun scripts/bundle-tools.ts [--mcp] [dir]
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { $ } from "bun";
import { foreignLinks, linked } from "./macho";

const ENGINE = join(import.meta.dir, "../packages/engine");
const RELEASE = join(ENGINE, "target/release");
const TOOLS = join(ENGINE, "third-party/out");
export const STAGE = join(ENGINE, "target/bundle");

/** The engine's own binaries, from its Cargo build. */
const ENGINE_BINARIES = ["libbeacon_ffi.dylib", "beacon-worker", "beacon-recorder"];
/** Beacon's own tools, from `bun run build:tools`. */
const TOOL_BINARIES = ["ffmpeg", "ffprobe", "whisper-cli", "beacon-speech", "beacon-writer", "beacon-html"];
/** Every file of the app's engine folder but the FFmpeg libraries. */
export const ENGINE_FILES = ["beacon-mcp", ...ENGINE_BINARIES, ...TOOL_BINARIES];

export async function bundleTools(to = STAGE): Promise<string[]> {
  // The app's stage is rebuilt from nothing; another folder (`build:mcp`'s dist) only gains these files.
  if (to === STAGE) rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const ours = join(TOOLS, "lib") + "/";
  // The FFmpeg libraries by the names their users link (libavcodec.61.dylib), symlinks followed.
  const libs = readdirSync(join(TOOLS, "lib")).filter((f) => /^lib\w+\.\d+\.dylib$/.test(f));
  const files = [
    ...ENGINE_BINARIES.map((f) => join(RELEASE, f)),
    ...TOOL_BINARIES.map((f) => join(TOOLS, "bin", f)),
    ...libs.map((f) => join(TOOLS, "lib", f)),
  ];
  for (const file of files) {
    const out = join(to, basename(file));
    copyFileSync(file, out);
    const changes = (await linked(out)).filter((l) => l.startsWith(ours)).flatMap((l) => ["-change", l, `@rpath/${basename(l)}`]);
    const id = file.endsWith(".dylib") ? ["-id", `@rpath/${basename(file)}`] : [];
    if (changes.length || id.length) {
      await $`install_name_tool ${id} ${changes} -add_rpath @loader_path ${out}`.quiet();
      // Rewriting invalidates the signature, and arm64 runs nothing unsigned: sign again (ad hoc; releases re-sign).
      await $`codesign --force --sign - ${out}`.quiet();
    }
  }
  const staged = files.map((f) => basename(f));
  for (const f of staged) {
    const foreign = await foreignLinks(join(to, f), (l) => l.startsWith("@rpath/") && staged.includes(l.slice(7)));
    if (foreign.length) throw new Error(`${f} would load ${foreign.join(", ")}, which a Mac without them doesn't have`);
  }
  return staged;
}

export async function bundleMcp(to = STAGE) {
  const out = join(to, "beacon-mcp");
  await $`bun build --compile ${join(import.meta.dir, "../packages/mcp/src/main.ts")} --outfile ${out}`.quiet();
  await $`codesign --force --sign - ${out}`.quiet();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const to = args.find((a) => !a.startsWith("--"));
  const staged = await bundleTools(to);
  if (args.includes("--mcp")) await bundleMcp(to);
  console.log(`staged ${staged.length + (args.includes("--mcp") ? 1 : 0)} files in ${to ?? STAGE}`);
}
