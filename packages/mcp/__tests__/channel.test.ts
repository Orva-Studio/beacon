import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_SOCKET, LocalCore, serveCore, type AppEvent } from "@beacon/core";

const dir = mkdtempSync(join(tmpdir(), "beacon-channel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The user's requests from the app reached an agent only by switching to its terminal (the user, 2026-11-03).
test("a request typed in the app reaches an agent's session as a channel message with what it is about, and the agent's app_reply comes back as an app event", async () => {
  // The app: a core served on its socket, as the desktop serves its own.
  const app = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), socket: DEFAULT_SOCKET });
  const served = serveCore(app, { path: DEFAULT_SOCKET });
  const events: AppEvent[] = [];
  const unwatch = app.watchApp((e) => events.push(e));

  // An agent's session: Beacon's MCP server, its client taking channel messages as Claude Code does.
  const client = new Client({ name: "channel-test", version: "1.2" });
  const messages: { content: string; meta: Record<string, string> }[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") messages.push(n.params as { content: string; meta: Record<string, string> });
  };
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../src/main.ts")], stderr: "ignore" }));
  try {
    expect(client.getServerCapabilities()?.experimental?.["claude/channel"]).toEqual({});
    expect(client.getInstructions()).toContain('<channel source="beacon"');

    // The app finds the session by its agent's name.
    let session: Awaited<ReturnType<LocalCore["agents"]>>[number] | undefined;
    for (let i = 0; i < 50 && !session; i++) {
      session = (await app.agents()).find((a) => a.name === "channel-test");
      if (!session) await Bun.sleep(100);
    }
    expect(session).toMatchObject({ name: "channel-test", version: "1.2" });

    const request = await app.askAgent(session!.socket, "Make this a counter from 0 to 10,000", { project: "/p/demo.beproj", clip: "clip-1", from: 12, to: 16.5, label: "Motion graphic, 0:12–0:16" });
    for (let i = 0; i < 50 && !messages.length; i++) await Bun.sleep(50);
    expect(messages).toEqual([
      { content: "Make this a counter from 0 to 10,000", meta: { request, reply_to: DEFAULT_SOCKET, project: "/p/demo.beproj", clip: "clip-1", from: "12.00", to: "16.50", label: "Motion graphic, 0:12–0:16" } },
    ]);

    // The agent answers through app_reply; the app hears it.
    const reply = async (args: Record<string, unknown>) => (await client.callTool({ name: "app_reply", arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    expect((await reply({ request, reply_to: DEFAULT_SOCKET, status: "received" })).isError).toBeFalsy();
    expect((await reply({ request, reply_to: DEFAULT_SOCKET, status: "done", text: "Made it a counter, 0 to 10,000 over 3 s" })).isError).toBeFalsy();
    for (let i = 0; i < 50 && events.filter((e) => e.kind === "agent").length < 2; i++) await Bun.sleep(50);
    expect(events.filter((e) => e.kind === "agent")).toEqual([
      { kind: "agent", request, status: "received" },
      { kind: "agent", request, status: "done", text: "Made it a counter, 0 to 10,000 over 3 s" },
    ]);
    // reply_to comes in a message: only a Beacon app's socket is answered.
    const foreign = await reply({ request, reply_to: join(dir, "app-1.sock"), status: "done" });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toContain("isn't a Beacon app's socket");

    // An ended session can't be sent to.
    await expect(app.askAgent(join(dir, "mcp-1.sock"), "hi", {})).rejects.toThrow("that agent session has ended");
  } finally {
    await client.close();
    unwatch();
    served.stop();
  }
}, 30_000);
