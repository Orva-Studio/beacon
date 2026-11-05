import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAuthor, LocalCore, RemoteCore, serveCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-undo-authors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an agent's changes over the app's socket are its own undo steps: ⌘Z skips them, the agent's undo takes only its own, Undo Agents' Last Change takes the newest, and a clash is refused saying whose", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const server = serveCore(core, { path: join(dir, "app.sock") });
  const agent = await RemoteCore.connect(join(dir, "app.sock"));
  const as = <T>(fn: () => Promise<T>) => asAuthor("claude-code", fn);
  try {
    await agent.open(h);
    const track = (await core.run(h, "track.add", { name: "Screen" })).results[0] as string;
    const mine = (await core.run(h, "clip.add", { type: "video", track, start: 0, duration: 1 })).results[0] as string;
    const theirs = (await as(() => agent.run(h, "clip.add", { type: "video", track, start: 2, duration: 1 }))).results[0] as string;
    expect((await core.history(h)).steps.undo.map((s) => s.author)).toEqual([undefined, undefined, "claude-code"]);

    const ids = () => core.doc(h).tracks[0]!.clips.map((c) => c.id);
    expect(await core.undo(h)).toBe("clip.add");
    expect(ids()).toEqual([theirs]);
    // The agent's own undo never takes the user's steps.
    expect(await as(() => agent.undo(h))).toBe("clip.add");
    // Over the socket nothing comes back as null.
    expect(await as(() => agent.undo(h))).toBeNull();
    expect(ids()).toEqual([]);
    await as(() => agent.redo(h));
    await core.redo(h);
    expect(ids().sort()).toEqual([mine, theirs].sort());

    expect(await core.undoAgents(h)).toBe("clip.add");
    expect(ids()).toEqual([mine]);
    await as(() => agent.redo(h));

    await as(() => agent.run(h, "clip.move", { clip: mine, start: 5 }));
    await core.run(h, "clip.move", { clip: theirs, start: 8 });
    // The user's newest step is theirs to undo; the one before it, on the clip the agent moved since, isn't.
    await core.undo(h);
    await core.run(h, "clip.set", { clip: mine, props: { transform: { opacity: 0.5 } } }, { label: "Opacity" });
    await as(() => agent.run(h, "clip.move", { clip: mine, start: 6 }));
    await expect(core.undo(h)).rejects.toThrow("Claude Code changed this clip since: undo Claude Code's change first");
  } finally {
    agent.disconnect();
    server.stop();
    await core.close(h);
  }
});

test("the app's socket answers only a client with this launch's token, and sends it nothing before", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache2"), configDir: join(dir, "config2") });
  const path = join(dir, "token.sock");
  const server = serveCore(core, { path });
  const said: string[] = [];
  const socket = await Bun.connect({ unix: path, socket: { data: (_, chunk) => void said.push(new TextDecoder().decode(chunk)) } });
  try {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: ["wrong"] })}\n`);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "history", params: ["x"] })}\n`);
    for (let i = 0; i < 50 && said.join("").split("\n").filter(Boolean).length < 2; i++) await Bun.sleep(20);
    const replies = said.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; error?: { message: string } });
    expect(replies.map((r) => [r.id, r.error?.message.split(":")[0]])).toEqual([[1, "this Beacon app wants its token in hello (protocol 2)"], [2, "say hello first, with the app's token"]]);
    // A client that reads the token connects as before.
    (await RemoteCore.connect(path)).disconnect();
  } finally {
    socket.end();
    server.stop();
  }
});
