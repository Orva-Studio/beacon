#!/usr/bin/env bun
/**
 * Runs a `beacon` binary built for Linux as a cloud agent would: --version, then over MCP a standalone project,
 * a clip made with the machine's ffmpeg imported (measured with its ffprobe), a cut, a description, and a frame
 * refused as needing the Mac app; then `beacon validate` on the result. CI runs it on Linux (release.yml's
 * `linux` job); locally, inside a Linux container with ffmpeg.
 *
 *   bun scripts/check-cli.ts <beacon>
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = process.argv[2] && resolve(process.argv[2]);
if (!bin) throw new Error("usage: bun scripts/check-cli.ts <beacon>");
const step = (what: string) => console.log(`ok  ${what}`);
const dir = mkdtempSync(join(tmpdir(), "beacon-cli-"));

try {
  const version = (await $`${bin} --version`.text()).trim();
  if (!/^beacon \d+\.\d+\.\d+/.test(version)) throw new Error(`--version said "${version}"`);
  step(version);

  const clip = join(dir, "clip.mp4");
  await $`ffmpeg -v error -f lavfi -i testsrc=size=640x360:rate=30:duration=4 -f lavfi -i sine=frequency=440:duration=4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${clip}`;

  const client = new Client({ name: "check-cli", version: "0" });
  await client.connect(new StdioClientTransport({ command: bin, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }, stderr: "inherit" }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), error: !!r.isError };
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.error) throw new Error(`${name}: ${r.text}`);
    return r.text;
  };

  const project = join(dir, "Cloud.beproj");
  await ok("project_create", { path: project, standalone: true });
  const imported = JSON.parse(await ok("media_import", { files: [clip] })) as { clips: string[] };
  if (!imported.clips.length) throw new Error("media_import placed no clip");
  step("a standalone project, and a clip imported (the machine's ffprobe)");

  await ok("timeline_rippleDelete", { ranges: [{ start: 1, end: 2 }] });
  const described = await ok("project_describe", {});
  if (!/duration 3s/.test(described)) throw new Error(`after cutting a second of four:\n${described}`);
  step("a second cut out: 3 s left");

  const frame = await call("frame_at", { time: 0.5 });
  if (!frame.error || !/Beacon app on a Mac/.test(frame.text)) throw new Error(`frame_at: ${frame.text}`);
  step("a frame refused: needs the Beacon app on a Mac");
  await client.close();

  const valid = await $`${bin} validate ${project}`.nothrow().text();
  if (!/: valid \(1 media/.test(valid) || /missing/.test(valid)) throw new Error(`beacon validate: ${valid}`);
  step("beacon validate: valid, its media inside it");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
