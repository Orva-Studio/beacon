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

    const report = await core.diagnostics({ app: { version: "9.9.9" }, permissions: { screen: "granted", camera: "not asked" }, log: `2026-11-05 error could not read ${media}: denied\n2026-11-05 warn saving ${h}\n2026-11-04 error no such file ${join(homedir(), "Movies/Old Client Pitch.beproj/media/Old Client Pitch.mov")}\n2026-11-05 error transcript of Acme Client Interview.mp4 failed\n2026-11-03 error opening ${join(homedir(), "Movies/Acme.com Confidential Interview.mov")}: denied\n2026-11-03 error mkdir ${join(homedir(), "Library/Application Support/Beacon")}: EACCES: permission denied\n2026-11-02 error ${join(homedir(), "Movies/O'Brien Secret Interview.mov")}: denied\n2026-11-02 error reading "${join(homedir(), "Movies/Archive (Hidden Co), take 2/Interview.mov")}" twice\n2026-11-01 error ENOENT: no such file, open /private/var/folders/ab/cd/T/TemporaryItems/Temp Client Cut.mov\n2026-11-01 error writing /tmp/Tmp Client Draft.mp4: full`, crashes: { names: ["bun-2026-11-05.ips"] } });
    expect(report).toContain("Beacon 9.9.9");
    expect(report).toMatch(/^macOS \d+/m);
    expect(report).toContain("camera: not asked");
    expect(report).toContain("OpenAI API key: set");
    expect(report).toMatch(/project 1: \d+×\d+ at [\d.]+ fps, [\d.]+ s, \d+ tracks, \d+ clips, 1 media \(1 video \.mp4\)/);
    expect(report).toContain("bun-2026-11-05.ips");
    expect(report).toContain("could not read <path>.mp4: denied");
    expect(report).toContain("saving <path>.beproj");
    expect(report).toContain("no such file <path>.mov");
    expect(report).toContain("transcript of <media 1.1>.mp4 failed");
    expect(report).toContain("opening <path>.mov: denied");
    expect(report).toContain("mkdir <path>: EACCES: permission denied");
    expect(report).toContain("error <path>.mov: denied");
    expect(report).toContain('reading "<path>.mov" twice');
    expect(report).toContain("open <path>.mov");
    expect(report).toContain("writing <path>.mp4: full");
    expect(report).toMatch(/ffmpeg version/);
    for (const leak of ["sk-secret-value-123", homedir(), "Acme Client", "Old Client", "Confidential", "Brien", "Secret", "Hidden Co", "take 2", "Temp Client", "Tmp Client", "TemporaryItems"]) expect(report).not.toContain(leak);
  } finally {
    core.closeAll();
  }
}, 60_000);
