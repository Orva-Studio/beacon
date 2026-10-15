#!/usr/bin/env bun
/**
 * Stages the app's `engine` folder (packages/engine/target/bundle, which electrobun.config.ts copies whole):
 * beacon-ffi, the worker and the recorder, and Beacon's own ffmpeg, ffprobe and whisper-cli with the FFmpeg
 * libraries they load. The libraries are found through @rpath beside whatever loads them, so the folder works
 * wherever the app is, on a Mac with no FFmpeg. Run after `bun run build`.
 *
 *   bun scripts/bundle-tools.ts [dir]
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { $ } from "bun";

const ENGINE = join(import.meta.dir, "../packages/engine");
const RELEASE = join(ENGINE, "target/release");
const TOOLS = join(ENGINE, "third-party/out");
export const STAGE = join(ENGINE, "target/bundle");

async function linked(file: string): Promise<string[]> {
  const lines = (await $`otool -L ${file}`.text()).split("\n").slice(1);
  return lines.map((l) => l.trim().split(" ")[0]!).filter(Boolean);
}

export async function bundleTools(to = STAGE): Promise<string[]> {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const ours = join(TOOLS, "lib") + "/";
  // The FFmpeg libraries by the names their users link (libavcodec.61.dylib), symlinks followed.
  const libs = readdirSync(join(TOOLS, "lib")).filter((f) => /^lib\w+\.\d+\.dylib$/.test(f));
  const files = [
    ...["libbeacon_ffi.dylib", "beacon-worker", "beacon-recorder"].map((f) => join(RELEASE, f)),
    ...["ffmpeg", "ffprobe", "whisper-cli"].map((f) => join(TOOLS, "bin", f)),
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
  const staged = readdirSync(to);
  for (const f of staged) {
    const foreign = (await linked(join(to, f))).filter((l) => !l.startsWith("/System/") && !l.startsWith("/usr/lib/") && !(l.startsWith("@rpath/") && staged.includes(l.slice(7))));
    if (foreign.length) throw new Error(`${f} would load ${foreign.join(", ")}, which a Mac without them doesn't have`);
  }
  return staged;
}

if (import.meta.main) {
  const staged = await bundleTools(process.argv[2]);
  console.log(`staged ${staged.length} files in ${process.argv[2] ?? STAGE}`);
}
