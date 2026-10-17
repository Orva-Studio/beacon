import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

test("settings change by what is given: a Snapshot folder gone since doesn't stop other changes, and null unsets it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-settings-"));
  try {
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    // Chosen before its drive was unplugged.
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ proxyMode: "quiet", snapshotFolder: join(dir, "gone") }));
    const core = new LocalCore({ configDir });
    expect(await core.setSettings({ proxyMode: "fast" })).toMatchObject({ proxyMode: "fast", exportColorSpace: "bt709", snapshotFolder: join(dir, "gone") });
    await expect(core.setSettings({ snapshotFolder: join(dir, "missing") })).rejects.toThrow("doesn't exist");
    expect((await core.setSettings({ snapshotFolder: null })).snapshotFolder).toBeUndefined();
    expect(await new LocalCore({ configDir }).settings()).toEqual({ exportColorSpace: "bt709", autoProxy: { recording: false, video: false }, proxyMode: "fast" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
