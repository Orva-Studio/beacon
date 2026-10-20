import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";
import type { ProjectBridge } from "@beacon/ui";
import type { Current, ProjectWindow } from "../src/bun/app";
import { createProjects } from "../src/bun/projects";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-windows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in editor window: what it was told, and how often it was brought forward. */
class FakeWindow implements ProjectWindow {
  current?: Current;
  messages: [string, unknown][] = [];
  activated = 0;
  message = ((type: string, data: unknown) => void this.messages.push([type, data])) as ProjectWindow["message"];
  status = (text: string) => void this.messages.push(["status", text]);
  activate = () => void this.activated++;
}

const bridge = { unwatch() {}, rev: () => 0, sendWaveforms() {}, proxies: { queued: {}, jobs: {} } } as unknown as ProjectBridge;

test.skipIf(!existsSync(VIDEO))("each project opens in a window of its own; one already open is brought forward; Save As keeps its window; closing a window releases its project; one window plays at a time", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const paths = ["A", "B", "C"].map((n) => join(dir, `${n}.beproj`));
  for (const p of paths) {
    const h = await core.create({ path: p });
    const copy = join(dir, `${p.slice(-8, -7)}.mp4`);
    copyFileSync(VIDEO, copy);
    const r = await core.import(h, [copy]);
    for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
    await core.close(h);
  }
  const [A, B, C] = paths as [string, string, string];
  const windows: FakeWindow[] = [new FakeWindow()];
  let focused: FakeWindow = windows[0]!;
  const shown: string[] = [];
  const projects = createProjects({
    core,
    focused: () => focused,
    windows: () => windows,
    newWindow: () => {
      const w = new FakeWindow();
      windows.push(w);
      return w;
    },
    watch: () => bridge,
    shown: async (w, h) => void shown.push(`${windows.indexOf(w as FakeWindow)}:${h}`),
    leaving: () => {},
    recentChanged: () => {},
    openFileDialog: async () => [],
  });

  // The start screen's window takes the first; the next opens beside it, and both stay open in core.
  await projects.open(A);
  await projects.open(B);
  expect(windows.map((w) => w.current?.path)).toEqual([A, B]);
  expect(shown).toEqual([`0:${A}`, `1:${B}`]);
  expect(core.doc(A).tracks.length).toBeGreaterThan(0);
  expect(core.doc(B).tracks.length).toBeGreaterThan(0);
  // Edits stay in their own project.
  await core.run(A, "track.add", { name: "Only in A" });
  expect(core.doc(B).tracks.some((t) => t.name === "Only in A")).toBe(false);

  // Opened again, it is brought forward rather than opened twice.
  focused = windows[1]!;
  await projects.open(A);
  expect(windows.length).toBe(2);
  expect(windows[0]!.activated).toBe(1);
  // From a window with a project, a third opens in a third window.
  await projects.open(C);
  expect(windows.map((w) => w.current?.path)).toEqual([A, B, C]);

  // Playing in one window stops the others.
  for (const p of [A, B]) core.attachView(p, { offscreen: { width: 320, height: 180 } }, { silent: true });
  await core.run(A, "playback.play", {});
  expect((await core.session(A)).playing).toBe(true);
  await core.run(B, "playback.play", {});
  await projects.playing(windows[1]!);
  expect([(await core.session(A)).playing, (await core.session(B)).playing]).toEqual([false, true]);
  await core.run(B, "playback.pause", {});
  for (const p of [A, B]) core.detachView(p);

  // Save As opens the copy in the same window, releasing the original.
  await projects.saveAs(windows[0]!, { name: "A copy", folder: dir, standalone: false });
  const copy = join(dir, "A copy.beproj");
  expect(windows[0]!.current?.path).toBe(copy);
  expect(() => core.doc(A)).toThrow();

  // A window closed: its project saved and released, the others untouched.
  await projects.closeWindow(windows[1]!);
  expect(windows[1]!.current).toBeUndefined();
  expect(() => core.doc(B)).toThrow();
  expect(core.doc(copy).tracks.some((t) => t.name === "Only in A")).toBe(true);
  expect(core.doc(C).tracks.length).toBeGreaterThan(0);
  // Reopened, it comes back in the focused window if that shows nothing, else a new one.
  focused = windows[1]!;
  await projects.open(B);
  expect(windows[1]!.current?.path).toBe(B);
  expect(windows.length).toBe(3);
  // Closed while it can't be saved (its folder read-only, as a full disk would refuse it): kept open with its edits,
  // another window says so, and opened again it comes back as it was.
  await core.run(B, "track.add", { name: "Unsaved" });
  chmodSync(B, 0o555);
  try {
    await projects.closeWindow(windows[1]!);
    expect(windows[1]!.current).toBeUndefined();
    expect(core.doc(B).tracks.some((t) => t.name === "Unsaved")).toBe(true);
    const told = windows[0]!.messages.find(([t]) => t === "notice");
    expect((told?.[1] as { title: string }).title).toBe("“B” couldn't be saved");
  } finally {
    chmodSync(B, 0o755);
  }
  await projects.open(B);
  expect(windows.find((w) => w.current?.path === B)).toBeDefined();
  expect(core.doc(B).tracks.some((t) => t.name === "Unsaved")).toBe(true);
  for (const w of windows) await projects.closeWindow(w);
  core.closeAll();
}, 120_000);
