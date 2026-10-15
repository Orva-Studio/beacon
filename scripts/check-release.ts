#!/usr/bin/env bun
/**
 * Checks a release DMG as a Mac without Homebrew or FFmpeg would see it: the app inside unpacked as its first launch
 * does, both signed (ad hoc), its Info.plist entries and icon, the update files beside it, nothing linked from outside the app or the system, and the
 * app's own beacon-mcp, run with a bare PATH and an empty home, making a project, exporting MP4 and GIF, importing
 * the MP4 and reading a frame back. The release workflow runs it before publishing.
 *
 * Given a folder instead (`bun run build:mcp`'s dist), it runs only the beacon-mcp part, on the beacon-mcp there.
 *
 *   bun scripts/check-release.ts <beacon-macos-arm64.dmg | dist> [--version 0.2.0]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: "string" } } });
const dmg = positionals[0];
if (!dmg || !existsSync(dmg)) throw new Error("usage: bun scripts/check-release.ts <dmg | folder with beacon-mcp> [--version x.y.z]");

/** Where the app looks for updates: the latest GitHub release's files. */
const UPDATES = "https://github.com/Orva-Studio/beacon/releases/latest/download";
const ENGINE_FILES = ["beacon-mcp", "beacon-worker", "beacon-recorder", "libbeacon_ffi.dylib", "ffmpeg", "ffprobe", "whisper-cli"];
const dir = mkdtempSync(join(tmpdir(), "beacon-release-"));
const mount = join(dir, "mnt");
const step = (what: string) => console.log(`✓ ${what}`);

async function checkApp(app: string, what: string) {
  await $`codesign --verify --deep --strict ${app}`.quiet();
  step(`${what} is signed`);
}

/**
 * The update files beside the DMG, which Check for Updates reads from the latest release: update.json names this
 * app and version, its hash is the app's own build (version.json, which points at the releases), and the archive it
 * names unpacks into the same app, signed.
 */
async function checkUpdate(app: string, version: string) {
  const manifest = join(dirname(dmg!), "stable-macos-arm64-update.json");
  if (!existsSync(manifest)) throw new Error(`no ${basename(manifest)} beside the DMG`);
  const update = JSON.parse(readFileSync(manifest, "utf8")) as { identifier: string; channel: string; version: string; hash: string; platform: string; arch: string; artifact: { file: string } };
  const local = JSON.parse(readFileSync(join(app, "Contents/Resources/version.json"), "utf8")) as { hash: string; baseUrl: string; channel: string };
  const expected = { identifier: "dev.beacon.editor", channel: "stable", version, hash: local.hash, platform: "macos", arch: "arm64" };
  for (const [k, v] of Object.entries(expected)) if (update[k as keyof typeof expected] !== v) throw new Error(`update.json's ${k} is ${update[k as keyof typeof expected]}, not ${v}`);
  if (local.baseUrl !== UPDATES) throw new Error(`the app looks for updates at ${local.baseUrl || "nowhere"}, not ${UPDATES}`);
  const archive = join(dirname(dmg!), update.artifact.file);
  if (!existsSync(archive)) throw new Error(`no ${update.artifact.file} beside the DMG`);
  const into = join(dir, "update");
  mkdirSync(into);
  writeFileSync(join(dir, "update.tar"), Bun.zstdDecompressSync(readFileSync(archive)));
  await $`tar -xf ${join(dir, "update.tar")} -C ${into}`.quiet();
  await checkApp(join(into, "Beacon.app"), "the update's Beacon.app");
  const updated = JSON.parse(readFileSync(join(into, "Beacon.app/Contents/Resources/version.json"), "utf8")) as { hash: string };
  if (updated.hash !== local.hash) throw new Error(`the update archive is build ${updated.hash}, not ${local.hash}`);
  step(`update.json and ${update.artifact.file}: version ${version}, build ${local.hash}, from ${UPDATES}`);
}

/** The app's engine folder, unpacked from the DMG and checked. */
async function appEngine(): Promise<string> {
  await $`hdiutil attach -nobrowse -readonly -mountpoint ${mount} ${dmg}`.quiet();
  const wrapper = join(mount, "Beacon.app");
  if (!existsSync(wrapper)) throw new Error(`no Beacon.app in the DMG (${readdirSync(mount).join(", ")})`);
  await checkApp(wrapper, "the DMG's Beacon.app");

  const resources = join(wrapper, "Contents/Resources");
  const packed = readdirSync(resources).find((f) => f.endsWith(".tar.zst"));
  if (!packed) throw new Error("the app has no packed bundle to unpack");
  writeFileSync(join(dir, "app.tar"), Bun.zstdDecompressSync(readFileSync(join(resources, packed))));
  mkdirSync(join(dir, "app"));
  await $`tar -xf ${join(dir, "app.tar")} -C ${join(dir, "app")}`.quiet();
  const app = join(dir, "app/Beacon.app");
  await checkApp(app, "the unpacked Beacon.app");

  const plist = join(app, "Contents/Info.plist");
  const key = async (k: string) => (await $`plutil -extract ${k} raw ${plist}`.nothrow().quiet().text()).trim();
  for (const k of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) if (!(await key(k))) throw new Error(`Info.plist has no ${k}`);
  const version = await key("CFBundleVersion");
  if (values.version && version !== values.version) throw new Error(`the app is version ${version}, not ${values.version}`);
  const icon = await key("CFBundleIconFile");
  if (!icon || !existsSync(join(app, "Contents/Resources", icon.endsWith(".icns") ? icon : `${icon}.icns`))) throw new Error("the app has no icon");
  step(`Info.plist: camera and microphone prompts, version ${version}, its icon`);

  await checkUpdate(app, version);

  const engine = join(app, "Contents/Resources/app/engine");
  const missing = ENGINE_FILES.filter((f) => !existsSync(join(engine, f)));
  if (missing.length) throw new Error(`the app's engine folder lacks ${missing.join(", ")}`);
  for (const f of readdirSync(engine)) {
    const links = (await $`otool -L ${join(engine, f)}`.quiet().text()).split("\n").slice(1).map((l) => l.trim().split(" ")[0]!).filter(Boolean);
    const foreign = links.filter((l) => !l.startsWith("/System/") && !l.startsWith("/usr/lib/") && !l.startsWith("@rpath/"));
    if (foreign.length) throw new Error(`${f} loads ${foreign.join(", ")} from outside the app`);
  }
  step(`the engine folder has ${ENGINE_FILES.join(", ")}, linked only to the system and each other`);
  return engine;
}

/** beacon-mcp from `engine`, with a bare PATH and an empty home: a project, MP4 and GIF exports, an import, a frame. */
async function driveMcp(engine: string) {

  const home = join(dir, "home");
  mkdirSync(home);
  const client = new Client({ name: "check-release", version: "0" });
  await client.connect(new StdioClientTransport({ command: join(engine, "beacon-mcp"), env: { PATH: "/usr/bin:/bin", HOME: home }, stderr: "inherit" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    return r.content;
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args))[0]!.text!);
  const jobId = (r: unknown) => (typeof r === "string" ? r : ((r as { job?: string; id?: string }).job ?? (r as { id: string }).id));
  const wait = async (job: string) => {
    for (;;) {
      const s = await json("job_status", { id: job, wait: 30 });
      if (s.state === "done") return;
      if (s.state !== "running") throw new Error(`job ${job}: ${JSON.stringify(s)}`);
    }
  };
  try {
    const tools = (await client.listTools()).tools.length;
    await call("project_create", { path: join(dir, "a.beproj") });
    await call("edit_addAnnotation", { preset: "text", time: 0, duration: 2 });
    for (const out of ["a.mp4", "a.gif"]) await wait(jobId(await json("export_start", { output: join(dir, out) })));
    for (const out of ["a.mp4", "a.gif"]) if (!existsSync(join(dir, out))) throw new Error(`no ${out}`);
    step(`beacon-mcp (${tools} tools) exported MP4 and GIF with nothing on PATH`);

    await call("project_create", { path: join(dir, "b.beproj") });
    const imported = await json("media_import", { files: [join(dir, "a.mp4")] });
    for (const job of imported.jobs ?? []) await wait(jobId(job)).catch(() => {});
    const frame = await call("frame_at", { time: 1, width: 320 });
    if (frame[0]?.type !== "image") throw new Error("frame_at returned no image");
    step("it imported the MP4 and read a frame of it");
  } finally {
    await client.close();
  }

  const whisper = Bun.spawnSync([join(engine, "whisper-cli"), "--help"], { env: { PATH: "/usr/bin:/bin" } });
  if (!whisper.stderr.toString().includes("usage") && !whisper.stdout.toString().includes("usage")) throw new Error(`whisper-cli doesn't run: ${whisper.stderr}`);
  step("whisper-cli runs");
}

try {
  await driveMcp(statSync(dmg).isDirectory() ? resolve(dmg) : await appEngine());
} finally {
  await $`hdiutil detach ${mount} -force`.quiet().nothrow();
  rmSync(dir, { recursive: true, force: true });
}
