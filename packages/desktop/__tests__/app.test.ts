import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalCore } from "@beacon/core";

const HERMES = join(homedir(), "client-videos/personal/hermes.cmproj");
const APP = join(import.meta.dir, "../build/dev-macos-arm64/Beacon-dev.app/Contents/MacOS/launcher");
const dir = mkdtempSync(join(tmpdir(), "ot-app-"));
let app: ReturnType<typeof Bun.spawn> | undefined;
afterAll(() => {
  app?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!existsSync(HERMES))(
  "an agent drives and reads the open app over MCP, and its edits reach the timeline",
  async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const project = join(dir, "hermes.beproj");
    const local = new LocalCore();
    await local.close(await local.create({ path: project, cmproj: HERMES }));

    // In the background: the window opens without taking focus, and nothing plays.
    const socket = join(dir, "app.sock");
    app = Bun.spawn([APP], { env: { ...process.env, BEACON_BACKGROUND: "1", BEACON_PROJECT: project, BEACON_SOCKET: socket }, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(100);
    expect(existsSync(socket)).toBe(true);

    const client = new Client({ name: "app-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../../mcp/src/main.ts")], stderr: "ignore" }));
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
      expect((await call("project_open", { path: project }))[0]!.text).toContain("connected to the open Beacon app");

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
