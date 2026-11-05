import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video-3.mp4");
const dir = mkdtempSync(join(homedir(), ".beacon-diagnostics-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(VIDEO))("the diagnostics report holds the setup and projects in numbers, never a key, a home path or a media name", async () => {
  const secrets = new Map<string, string>();
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  try {
    await core.setSecret("openai-api-key", "sk-secret-value-123");
    const media = join(dir, "Acme Client Interview.mp4");
    copyFileSync(VIDEO, media);
    const h = await core.create({ path: join(dir, "Acme Client.beproj") });
    const r = await core.import(h, [media], { at: 0 });
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});

    const report = await core.diagnostics({ app: { version: "9.9.9" }, permissions: { screen: "granted", camera: "not asked" }, log: `2026-11-05 error could not read ${media}\n2026-11-05 warn saving ${h}`, crashes: { names: ["bun-2026-11-05.ips"] } });
    expect(report).toContain("Beacon 9.9.9");
    expect(report).toMatch(/^macOS \d+/m);
    expect(report).toContain("camera: not asked");
    expect(report).toContain("OpenAI API key: set");
    expect(report).toMatch(/project 1: \d+×\d+ at [\d.]+ fps, [\d.]+ s, \d+ tracks, \d+ clips, 1 media \(1 video \.mp4\)/);
    expect(report).toContain("bun-2026-11-05.ips");
    expect(report).toContain("could not read ~/");
    expect(report).toContain("<media 1.1>");
    expect(report).toContain("<project 1>.beproj");
    expect(report).toMatch(/ffmpeg version/);
    for (const leak of ["sk-secret-value-123", homedir(), "Acme Client"]) expect(report).not.toContain(leak);
  } finally {
    core.closeAll();
  }
}, 60_000);
