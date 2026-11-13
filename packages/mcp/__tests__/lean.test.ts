import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "beacon-lean-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the server stays lean: short instructions, core tools loaded, no duplicate editor keys, compact replies, errors naming what works", async () => {
  const client = new Client({ name: "lean-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../src/main.ts")], stderr: "ignore" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: !!r.isError, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.error) throw new Error(`${name}: ${r.text}`);
    return JSON.parse(r.text);
  };
  try {
    // Claude Code cuts server instructions at 4,096 characters.
    expect(client.getInstructions()!.length).toBeLessThan(4096);
    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map((t) => t.name));
    expect(tools.filter((t) => t._meta?.["anthropic/alwaysLoad"]).map((t) => t.name).sort()).toEqual(
      ["asset_place", "frame_at", "frames_sheet", "memory_list", "project_describe", "project_open", "script", "status", "timeline_clips", "timeline_rippleDelete", "transaction", "transcript_cut", "transcript_get"],
    );
    // Read whole, not saved to a file the agent must read back.
    expect(tools.find((t) => t.name === "transcript_get")!._meta?.["anthropic/maxResultSizeChars"]).toBe(200_000);
    expect(names.has("edit_split")).toBe(false);
    expect(names.has("edit_fade")).toBe(true);
    const guide = await client.readResource({ uri: "beacon://docs/guide" });
    expect(JSON.stringify(guide.contents[0])).toContain("## Recording");

    await call("project_create", { path: join(dir, "lean.beproj") });
    const track = (await json("track_add", { name: "Screen" })).result;
    const [a] = await Promise.all([0, 10, 20].map(async (start) => (await json("clip_add", { type: "video", track, start, duration: 10 })).result as string));

    const split = await json("clip_split", { at: 5, clips: [a] });
    expect(split.changed).toEqual([`set clip ${a}: duration 10 -> 5`, `add clip ${split.result[0]}: video 5-10s on ${track}`]);

    const compact = await json("timeline_clips", { from: 12, to: 13 });
    expect(compact.tracks).toHaveLength(1);
    expect(compact.tracks[0].clips.map((c: { start: number }) => c.start)).toEqual([10]);
    expect(compact.tracks[0].clips[0].props).toBeUndefined();
    expect((await json("timeline_clips", { from: 12, to: 13, detail: true })).tracks[0].clips[0]).toMatchObject({ props: {}, effects: [], animations: [] });
    expect((await json("timeline_clips", { limit: 2 })).more).toStartWith("2 more clips");

    const wrong = await call("clip_set", { clip: "c999", props: { transform: { opacity: 0.5 } } });
    expect(wrong.error).toBe(true);
    expect(wrong.text).toContain(`clips on the timeline: ${a} video 0-5s (${track})`);
    // Every track, not only the first with clips.
    const second = (await json("track_add", { name: "Camera" })).result;
    await json("clip_add", { type: "video", track: second, start: 0, duration: 5 });
    const noTrack = await call("track_set", { track: "t999", hidden: true });
    expect(noTrack.text).toContain(`tracks: ${track} "Screen", ${second} "Camera"`);
    expect((await call("edit_split")).text).toContain("call clip_split with the clip ids");
    expect((await call("clip_splitt")).text).toContain("nearest: clip_split");
    expect((await call("transaction", { label: "x", commands: [{ command: "clip_sett", args: {} }] })).text).toContain("nearest: clip_set");

    // Arguments it doesn't take: the error lists those it does.
    expect((await call("clip_move", { clip: a, start: 40, title: "x" })).text).toMatch(/clip_move takes: .*clip/);
    // A script: many edits in one call, one undo step, its value back.
    const made = await json("script", { label: "Three more", code: `const ids = []; for (let i = 0; i < 3; i++) ids.push(beacon.run("clip_add", { type: "video", track: ${JSON.stringify(second)}, start: 10 + i * 2, duration: 1 })); return ids;` });
    expect(made.result).toHaveLength(3);
    expect(made.undo).toBe("Three more");
    // An action in a transaction, beside a command.
    const both = await json("transaction", { label: "Graphic", commands: [{ command: "motion_add", args: { time: 0, duration: 2 } }, { command: "playhead_set", args: { time: 1 } }] });
    expect(both.undo).toBe("Graphic");
  } finally {
    await client.close();
  }
}, 60_000);

test("every editor key left out of MCP names a command that is a tool", async () => {
  const { LocalCore } = await import("@beacon/core");
  const core = new LocalCore();
  const commands = core.commands();
  const ids = new Set([...commands.filter((c) => !c.duplicates).map((c) => c.id), ...core.queries().map((q) => q.id)]);
  const left = commands.filter((c) => c.duplicates);
  expect(left.length).toBeGreaterThan(20);
  for (const c of left) expect(ids.has(c.duplicates!)).toBe(true);
  core.closeAll();
});
