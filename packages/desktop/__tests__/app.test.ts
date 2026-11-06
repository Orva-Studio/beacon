import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalCore } from "@beacon/core";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const SMALL = join(FIXTURES, "small.cmproj");
/** 28 media and 304 clips, the largest fixture. */
const LARGE = join(FIXTURES, "project.cmproj");
const APP = join(import.meta.dir, "../build/dev-macos-arm64/Beacon-dev.app/Contents/MacOS/launcher");
const dir = mkdtempSync(join(tmpdir(), "ot-app-"));
let app: ReturnType<typeof Bun.spawn> | undefined;
afterAll(() => {
  app?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!existsSync(SMALL))(
  "an agent drives and reads the open app over MCP, and its edits reach the timeline",
  async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const project = join(dir, "small.beproj");
    const local = new LocalCore();
    await local.close(await local.create({ path: project, cmproj: SMALL }));

    // In the background: the window opens without taking focus, and nothing plays.
    const socket = join(dir, "app.sock");
    app = Bun.spawn([APP], { env: { ...process.env, BEACON_BACKGROUND: "1", BEACON_PROJECT: project, BEACON_SOCKET: socket }, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(100);
    expect(existsSync(socket)).toBe(true);

    const client = new Client({ name: "app-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../../mcp/src/main.ts")], env: { ...process.env, BEACON_SOCKET: socket } as Record<string, string>, stderr: "ignore" }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
      if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
      return r.content;
    };
    /** The snapshot once the window reports drawing what `want` matches. */
    const shown = async (want: RegExp) => {
      let text = "";
      for (let i = 0; i < 50; i++) {
        const snap = await call("ui_snapshot");
        text = snap.at(-1)!.text!;
        if (want.test(text.split("window shows: ")[1] ?? "")) return snap;
        await Bun.sleep(100);
      }
      throw new Error(`the window never showed ${want}; last snapshot:\n${text}`);
    };
    try {
      // Before any project, an agent is told where to find the app's; with no path, project_open connects to it.
      await expect(call("ui_state")).rejects.toThrow("connects to the project open in the Beacon app");
      expect((await call("project_open"))[0]!.text).toContain("connected to the open Beacon app");

      await call("playhead_set", { time: 100 });
      await call("selection_step", { direction: "next", scope: "playhead" });
      await call("panel_show", { tool: "visualEffects" });
      await call("timeline_zoom", { to: "in" });
      const state = JSON.parse((await call("ui_state"))[0]!.text!);
      expect(state.session.playhead).toBe(100);
      expect(state.session.selection.length).toBeGreaterThan(0);
      expect(state.session.panels.tool).toBe("visualEffects");
      expect(state.session.timeline.end - state.session.timeline.start).toBeLessThan(377);

      const snap = await shown(new RegExp(`playhead 100\\.00 s; selected ${state.session.selection[0]}.*tool panel visualEffects`));
      expect(snap[0]!.type).toBe("image");
      expect(Buffer.from(snap[0]!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");

      await call("marker_add", { time: 50, name: "from the agent" });
      await shown(/ 1 markers/);
      await call("project_undo");
      await shown(/ 0 markers/);
    } finally {
      await client.close();
    }
  },
  180_000,
);

/** The built app on `project` in the background, and an agent connected to it over MCP. */
async function launch(project: string, name: string) {
  const socket = join(dir, `${name}.sock`);
  const proc = Bun.spawn([APP], { env: { ...process.env, BEACON_BACKGROUND: "1", BEACON_PROJECT: project, BEACON_SOCKET: socket }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(100);
  const client = new Client({ name: "app-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../../mcp/src/main.ts")], env: { ...process.env, BEACON_SOCKET: socket } as Record<string, string>, stderr: "ignore" }));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    if (r.isError) throw new Error(`${tool}: ${r.content[0]?.text}`);
    return r.content;
  };
  // Once the app holds the project (opened first by the agent, the project would be the agent's), by its path: with
  // no path, any running Beacon's project would do, the user's own app's too.
  for (let i = 0; i < 100 && !(existsSync(join(project, "lock")) && readFileSync(join(project, "lock"), "utf8").includes(socket)); i++) await Bun.sleep(100);
  expect((await call("project_open", { path: project }))[0]!.text).toContain("connected to the open Beacon app");
  /** What the window reports drawing, once `want` matches it (or the last report, after `ms`). */
  const shows = async (want: RegExp, ms = 15_000) => {
    let text = "";
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
      text = (await call("ui_snapshot")).at(-1)!.text!.split("window shows: ")[1] ?? "";
      if (want.test(text)) return text;
    }
    throw new Error(`the window never showed ${want}; it showed: ${text}`);
  };
  // The window drawn first: playing needs its canvas.
  await shows(/playhead/, 30_000);
  const close = async () => {
    await client.close();
    proc.kill();
    await proc.exited;
  };
  return { call, shows, close };
}

// A project opened with its waveforms and thumbnails made already showed none: the reply to the window's `init` came
// after them and wiped them (2026-11-06). The race needed a project slower to send than the fixtures (it showed on
// the user's, five long takes), so the UI flow "the project shown again keeps the pictures" is what fails without
// the fix; this checks the whole way, the app's own start-up, that a project opened again shows every picture.
test.skipIf(!existsSync(LARGE))("a project opened again, its waveforms and thumbnails made, shows them all", async () => {
  const project = join(dir, "again.beproj");
  const local = new LocalCore();
  await local.close(await local.create({ path: project, cmproj: LARGE }));
  const first = await launch(project, "first");
  let made: RegExpMatchArray;
  try {
    // Made (or found made) the first time: once the counts stop growing for 3 s, every one is there.
    let last = "";
    let since = Date.now();
    for (const end = Date.now() + 120_000; Date.now() < end; await Bun.sleep(300)) {
      const now = (await first.shows(/[1-9]\d* waveforms, [1-9]\d* thumbnails/, 60_000)).match(/\d+ waveforms, \d+ thumbnails/)![0];
      if (now !== last) (last = now), (since = Date.now());
      else if (Date.now() - since > 3000) break;
    }
    made = last.match(/(\d+) waveforms, (\d+) thumbnails/)!;
  } finally {
    await first.close();
  }
  const again = await launch(project, "again");
  try {
    await again.shows(new RegExp(`${made[1]} waveforms, ${made[2]} thumbnails`), 15_000);
  } finally {
    await again.close();
  }
}, 180_000);

// A pause moved the playhead on to where the sound sent to the device ended, the output's latency ahead of the frame
// shown, and the picture redrawn a moment later jumped back (2026-11-06). Plays sound on the Mac's output.
test.skipIf(!existsSync(SMALL))("a pause leaves the playhead on the frame shown, and it stays there", async () => {
  const project = join(dir, "pause.beproj");
  const local = new LocalCore();
  await local.close(await local.create({ path: project, cmproj: SMALL }));
  const app = await launch(project, "pause");
  const playhead = async () => JSON.parse((await app.call("ui_state"))[0]!.text!).session.playhead as number;
  try {
    for (const from of [20, 60]) {
      await app.call("playhead_set", { time: from });
      await app.call("playback_toggle");
      await Bun.sleep(1500);
      const playing = await playhead();
      await app.call("playback_toggle");
      const paused = await playhead();
      expect(paused).toBeGreaterThan(from + 0.5);
      // At most the time between the two reads (a few ticks), never the output's latency (0.2 s and more).
      expect(paused - playing).toBeLessThan(0.12);
      await Bun.sleep(1500);
      expect(await playhead()).toBe(paused);
      await app.shows(new RegExp(`playhead ${paused.toFixed(2)} s`), 3000);
    }
  } finally {
    await app.close();
  }
}, 120_000);
