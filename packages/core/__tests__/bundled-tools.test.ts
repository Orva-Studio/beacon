import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const [RECORDING, VIDEO] = ["recording.trec", "video.mp4"].map((f) => join(FIXTURES, f)) as [string, string];
const SYSTEM_ONLY = "/usr/bin:/bin:/usr/sbin:/sbin";

test.skipIf(![RECORDING, VIDEO].every(existsSync))("with no ffmpeg on PATH, Beacon imports, draws and exports MP4, GIF and WebM with its own", () => {
  expect(Bun.which("ffmpeg", { PATH: SYSTEM_ONLY })).toBeNull();
  const { BEACON_TOOLS_DIR: _, ...env } = process.env;
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "helpers/without-path.ts"), RECORDING, VIDEO], { env: { ...env, PATH: SYSTEM_ONLY }, stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const out = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  expect(out.frame).toBeGreaterThan(1000);
  for (const ext of ["mp4", "gif", "webm"]) expect(out.sizes[ext]).toBeGreaterThan(1000);
}, 180_000);

test.skipIf(![RECORDING, VIDEO].every(existsSync))("the app's engine folder, moved anywhere, carries everything it loads", async () => {
  const { bundleTools } = await import("../../../scripts/bundle-tools");
  const dir = mkdtempSync(join(tmpdir(), "beacon-engine-"));
  try {
    await bundleTools(join(dir, "staged"));
    renameSync(join(dir, "staged"), join(dir, "moved"));
    const engine = join(dir, "moved");
    const env = { ...process.env, PATH: SYSTEM_ONLY, BEACON_TOOLS_DIR: engine, BEACON_FFI_PATH: join(engine, "libbeacon_ffi.dylib"), BEACON_WORKER_PATH: join(engine, "beacon-worker") };
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "helpers/without-path.ts"), RECORDING, VIDEO], { env, stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!).sizes.mp4).toBeGreaterThan(1000);
    expect(Bun.spawnSync([join(engine, "whisper-cli"), "--help"]).exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
