import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticksToSeconds } from "@beacon/model";
import { asAuthor, LocalCore, readProject, RemoteCore, serveCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-script-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const clips = (core: LocalCore, h: string) => core.doc(h).tracks.flatMap((t) => t.clips);

test("a transaction takes actions and editor commands beside commands, each planned on what the steps before it made: one undo step, and nothing kept when a step fails", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "t.beproj") });
  const before = (await core.history(h)).undo.length;
  const r = await core.transaction(h, "Two graphics", [
    { command: "motion.add", args: { time: 0, duration: 2 } },
    { command: "playhead.set", args: { time: 3 } },
    { command: "motion_add", args: { duration: 2 } },
  ]);
  // The second at the playhead the step before it moved.
  expect(clips(core, h).filter((c) => c.type === "motion").map((c) => ticksToSeconds(c.start)).sort()).toEqual([0, 3]);
  expect((r.results as unknown[]).length).toBe(3);
  expect((await core.history(h)).undo).toEqual([...(await core.history(h)).undo.slice(0, before), "Two graphics"]);

  await core.undo(h);
  expect(clips(core, h)).toHaveLength(0);

  const doc = core.doc(h);
  const playhead = (await core.session(h)).playhead;
  await expect(core.transaction(h, "Fails", [
    { command: "motion.add", args: { time: 0, duration: 2 } },
    { command: "playhead.set", args: { time: 9 } },
    { command: "clip.move", args: { clip: "clip-nope", start: 1 } },
  ])).rejects.toThrow(/step 3 \(clip\.move\)/);
  expect(core.doc(h)).toBe(doc);
  expect((await core.session(h)).playhead).toBe(playhead);

  // A dry run says what it would do and leaves everything as it was.
  const dry = await core.transaction(h, "Dry", [{ command: "motion.add", args: { time: 0, duration: 2 } }], { dryRun: true });
  expect(dry.diff.join("\n")).toMatch(/clip/);
  expect(core.doc(h)).toBe(doc);
  core.closeAll();
});

test("a script runs in a sandbox: loops over queries and commands as one undo step, returns its value and log, sees nothing of Beacon's process, and is stopped when it runs too long; a throw keeps nothing", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "s.beproj") });
  const before = (await core.history(h)).undo.length;

  const r = await core.script(h, `
    const track = beacon.run("track_add", { name: "Screen" });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(beacon.run("clip.add", { type: "video", track, start: i * 2, duration: 1 }));
    beacon.log("made", ids.length);
    const listed = beacon.query("timeline.clips", {});
    return { ids, listed: listed.tracks[0].clips.length, process: typeof process, bun: typeof Bun, require: typeof require };
  `, { label: "Five clips" });
  const value = r.value as { ids: string[]; listed: number; process: string; bun: string; require: string };
  expect(value.ids).toHaveLength(5);
  expect(value.listed).toBe(5);
  expect([value.process, value.bun, value.require]).toEqual(["undefined", "undefined", "undefined"]);
  expect(r.logs).toEqual(["made 5"]);
  expect(r.changed).toBe(true);
  expect((await core.history(h)).undo.slice(before)).toEqual(["Five clips"]);
  await core.undo(h);
  expect(clips(core, h)).toHaveLength(0);

  // The host's functions can't be reached through the wrappers or an error.
  const escape = await core.script(h, `
    let a = "none", b = "none";
    a = beacon.run.constructor("return typeof process")();
    try { beacon.run("clip.move", { clip: "x", start: 1 }); } catch (e) { b = e.constructor.constructor("return typeof process")(); }
    return [a, b, typeof globalThis.__call];
  `);
  expect(escape.value).toEqual(["undefined", "undefined", "undefined"]);

  const doc = core.doc(h);
  await expect(core.script(h, `beacon.run("track.add", { name: "A" }); throw new Error("changed my mind");`)).rejects.toThrow(/changed my mind/);
  expect(core.doc(h)).toBe(doc);
  await expect(core.script(h, `beacon.run("track.add", { name: "A" }); while (true) {}`, { seconds: 0.3 })).rejects.toThrow(/stopped/);
  expect(core.doc(h)).toBe(doc);
  await expect(core.script(h, `beacon.run("clip_nothing", {})`)).rejects.toThrow(/no command "clip_nothing"/);
  await expect(core.script(h, `beacon.run("timeline.clips", {})`)).rejects.toThrow(/query, for beacon.query/);

  // A dry run says what it would change and keeps nothing.
  const dry = await core.script(h, `return beacon.run("track.add", { name: "B" })`, { dryRun: true });
  expect(dry.diff.join("\n")).toMatch(/track/);
  expect(core.doc(h)).toBe(doc);
  // Nor on disk: a batch is saved once it is kept.
  expect(readProject(h, core.registry).doc.tracks).toHaveLength(doc.tracks.length);
  await expect(core.script(h, `beacon.run("project.settings.set", { standalone: true })`)).rejects.toThrow(/on its own/);
  await expect(core.script(h, `beacon.run("track.add", { name: "A" }); return 1n;`)).rejects.toThrow(/JSON/);
  await expect(core.script(h, `beacon.run("track.add", { name: "A" }); const o = { x: 1n }; return o;`)).rejects.toThrow(/JSON/);
  await expect(core.script(h, `beacon.run("track.add", { name: "A" }); beacon.run("playback.pause", {});`)).rejects.toThrow(/on its own/);
  expect(core.doc(h)).toBe(doc);
  // A step changing what an earlier one made.
  await core.script(h, `const t = beacon.run("track.add", { name: "a" }); beacon.run("track.set", { track: t, name: "Kept" });`);
  expect(readProject(h, core.registry).doc.tracks.map((t) => t.name)).toContain("Kept");
  core.closeAll();
});

test("an agent's script over the app's socket is its own undo step, which ⌘Z skips", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "r.beproj") });
  const server = serveCore(core, { path: join(dir, "app.sock") });
  const agent = await RemoteCore.connect(join(dir, "app.sock"));
  try {
    await agent.open(h);
    await core.run(h, "track.add", { name: "Mine" });
    await asAuthor("claude-code", () => agent.script(h, `beacon.run("track.add", { name: "Theirs" }); beacon.run("track.add", { name: "Theirs too" });`, { label: "Agent tracks" }));
    expect((await core.history(h)).steps.undo.slice(-2)).toEqual([{ label: "track.add" }, { label: "Agent tracks", author: "claude-code" }]);
    expect(await core.undo(h)).toBe("track.add");
    expect(core.doc(h).tracks.map((t) => t.name)).toEqual(["Theirs", "Theirs too"]);
  } finally {
    agent.disconnect();
    server.stop();
    core.closeAll();
  }
});
