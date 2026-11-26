import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";
import pkg from "../package.json";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dir = mkdtempSync(join(tmpdir(), "beacon-cli-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const beacon = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

// `beacon` for cloud agents (the user, 2026-11-26): the MCP server, and a check an agent runs before handing a project over.
test("beacon --version, --help, and validate: a project's media missing or not yet measured is said; a broken one is refused", async () => {
  expect(beacon("--version").out.trim()).toBe(`beacon ${pkg.version}`);
  expect(beacon("--help").out).toContain("beacon validate <dir>");
  expect(beacon("export").code).toBe(2);

  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const project = join(dir, "Agent.beproj");
  await core.close(await core.create({ path: project }));
  const file = join(project, "project.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  expect(beacon("validate", project)).toMatchObject({ code: 0, out: `${project}: valid (0 media, 0 tracks, 0 clips)\n` });

  doc.assets["asset-1"] = { id: "asset-1", kind: "video", path: "media/gone.mp4", fingerprint: "", derived: {} };
  writeFileSync(file, JSON.stringify(doc));
  const missing = beacon("validate", project);
  expect(missing.code).toBe(0);
  expect(missing.out).toContain(`missing: ${join(project, "media/gone.mp4")} (asset-1)`);

  doc.tracks = [{ id: "track-1", name: "", clips: [{ id: "clip-1", type: "video", start: -5 }] }];
  writeFileSync(file, JSON.stringify(doc));
  const broken = beacon("validate", project);
  expect(broken.code).toBe(1);
  expect(broken.out).toContain("not valid");
});
