import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const VIDEO = join(process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures"), "video.mp4");

test.skipIf(!existsSync(VIDEO))("core starts proxies by the settings, and a change another process wrote is told and followed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-settings-"));
  try {
    const configDir = join(dir, "config");
    const core = new LocalCore({ configDir, cacheDir: join(dir, "cache") });
    core.setAutomatic((analyzer) => analyzer !== "transcript");
    const told: unknown[] = [];
    core.watchApp((e) => e.kind === "settings" && told.push(e.settings));
    const h = await core.create({ path: join(dir, "p.beproj") });
    const video = join(dir, "video.mp4");
    copyFileSync(VIDEO, video);
    const { assets } = await core.import(h, [video]);
    core.attachView(h, { offscreen: { width: 64, height: 36 } }, { silent: true, proxies: true });
    const proxying = async () => (await core.jobs()).some((j) => j.kind === "proxy" && j.asset === assets[0] && j.state === "running");
    expect(await proxying()).toBe(false);

    // An agent's core, with the project not open here, writes the file; reloading tells the change and follows it.
    await new LocalCore({ configDir }).setSettings({ autoProxy: { recording: false, video: true } });
    expect(told).toEqual([]);
    expect(core.reloadSettings().autoProxy.video).toBe(true);
    expect(told).toMatchObject([{ autoProxy: { video: true } }]);
    core.reloadSettings();
    expect(told).toHaveLength(1);
    expect(await proxying()).toBe(true);
    await core.close(h);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new project takes settings as project.settings.set does: loudnessTarget null is Auto-normalize off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-settings-"));
  try {
    const core = new LocalCore({ configDir: join(dir, "config") });
    const off = await core.create({ path: join(dir, "off.beproj"), settings: { width: 1080, height: 1920, loudnessTarget: null } });
    expect(core.doc(off).settings).toMatchObject({ width: 1080, height: 1920 });
    expect(core.doc(off).settings.loudnessTarget).toBeUndefined();
    expect((await core.create({ path: join(dir, "on.beproj") })).length && core.doc(join(dir, "on.beproj")).settings.loudnessTarget).toBeNumber();
    await core.run(off, "project.settings.set", { loudnessTarget: -16 });
    expect(core.doc(off).settings.loudnessTarget).toBe(-16);
    const cmproj = join(process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures"), "small.cmproj");
    if (existsSync(cmproj)) {
      const imported = await core.create({ path: join(dir, "imported.beproj"), cmproj, settings: { loudnessTarget: null } });
      expect(core.doc(imported).settings.loudnessTarget).toBeUndefined();
    }
    core.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reloading tells a change back to the defaults, and nothing when the file didn't change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-settings-"));
  try {
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ autoProxy: { recording: false, video: true } }));
    const core = new LocalCore({ configDir });
    const told: unknown[] = [];
    core.watchApp((e) => e.kind === "settings" && told.push(e.settings));
    core.reloadSettings();
    expect(told).toEqual([]);
    await new LocalCore({ configDir }).setSettings({ autoProxy: { recording: false, video: false } });
    core.reloadSettings();
    expect(told).toMatchObject([{ autoProxy: { video: false } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
