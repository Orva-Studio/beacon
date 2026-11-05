// Drives Beacon's MCP server over stdio as an agent would, through scripted everyday tasks on a project made
// from a Camtasia fixture, and reports per task: tool calls, bytes sent and received, wall time (docs/performance.md, "MCP").
//   bun scripts/mcp-eval.ts [project.cmproj] [--json]   (default: $BEACON_FIXTURES/small.cmproj)
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false } } });
const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const source = positionals[0] ?? join(FIXTURES, "small.cmproj");
const dir = mkdtempSync(join(tmpdir(), "beacon-mcp-eval-"));

interface Clip {
  id: string;
  type: string;
  start: number;
  end: number;
}
interface Track {
  track: string;
  clips: Clip[];
}
interface Row {
  task: string;
  calls: number;
  sent: number;
  received: number;
  ms: number;
  errors: number;
}

const client = new Client({ name: "mcp-eval", version: "0" });
await client.connect(new StdioClientTransport({ command: "bun", args: [join(import.meta.dir, "../packages/mcp/src/main.ts")], stderr: "ignore" }));

let row: Row = { task: "", calls: 0, sent: 0, received: 0, ms: 0, errors: 0 };
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  row.calls++;
  row.sent += JSON.stringify({ name, arguments: args }).length;
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
  row.received += JSON.stringify(r.content).length;
  if (r.isError) row.errors++;
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
}
async function json<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  // Servers before 0.17 sent an empty list as no content at all.
  return JSON.parse(r.text || "[]") as T;
}
/** Older servers answered timeline_clips with the tracks alone; newer ones with `{ tracks, more? }`. */
const tracksOf = (r: unknown): Track[] => (Array.isArray(r) ? r : (r as { tracks: Track[] }).tracks);
const clipsAt = async (t: number, track?: string) => tracksOf(await json("timeline_clips", { from: t, to: t + 0.01, ...(track ? { track } : {}) }));

const rows: Row[] = [];
async function task(name: string, fn: () => Promise<void>) {
  row = { task: name, calls: 0, sent: 0, received: 0, ms: 0, errors: 0 };
  const t0 = performance.now();
  try {
    await fn();
  } catch (e) {
    row.task += ` (failed: ${e instanceof Error ? e.message.slice(0, 120) : e})`;
  }
  row.ms = Math.round(performance.now() - t0);
  rows.push(row);
}

try {
  const listed = await client.listTools();
  const setup: Row = { task: "connect: instructions + tools/list", calls: 0, sent: 0, received: (client.getInstructions() ?? "").length + JSON.stringify(listed.tools).length, ms: 0, errors: 0 };
  const session = { tools: listed.tools.length, toolsBytes: JSON.stringify(listed.tools).length, instructions: (client.getInstructions() ?? "").length };

  // Not timed: the project and its transcripts, as a user would have them before asking.
  row = { ...setup };
  const path = join(dir, "eval.beproj");
  await call("project_create", { path, cmproj: source });
  // A project made from a .cmproj starts no transcripts; transcripts are kept by media, so this is slow only once.
  const assets = await json<Record<string, { id: string; kind: string }>>("project_get", { path: "/assets" });
  for (const a of Object.values(assets)) if (a.kind !== "image") await call("analyze", { key: "transcript", asset: a.id });
  for (const j of (await json<{ id: string; state: string }[]>("job_status")).filter((j) => j.state === "running")) {
    for (let state = "running"; state === "running"; ) state = (await json<{ state: string }>("job_status", { id: j.id, wait: 30 })).state;
  }
  rows.push(setup);

  await task("open and get oriented", async () => {
    await call("project_open", { path });
    await call("memory_list");
  });

  await task("split at 0:30 and delete the first part", async () => {
    const under = (await clipsAt(30)).flatMap((t) => t.clips);
    await json("clip_split", { at: 30, clips: under.map((c) => c.id) });
    const first = (await clipsAt(29.9)).flatMap((t) => t.clips).filter((c) => c.end <= 30.001);
    await json("clip_remove", { clips: first.map((c) => c.id), ripple: true });
  });

  await task("add a marker at 1:15", async () => {
    await json("marker_add", { time: 75, name: "Demo starts" });
  });

  await task("set the camera's opacity to 50% at 1:40", async () => {
    const tracks = await clipsAt(100);
    const camera = tracks.flatMap((t) => t.clips).find((c) => c.type === "video") ?? tracks.flatMap((t) => t.clips)[0]!;
    await json("clip_set", { clip: camera.id, props: { transform: { opacity: 0.5 } } });
  });

  await task("add captions", async () => {
    await json("captions_add");
  });

  await task("move a clip to another track", async () => {
    const tracks = await clipsAt(150);
    const top = tracks.filter((t) => t.clips.length).at(-1)!;
    const r = await call("clip_move", { clips: [top.clips[0]!.id], tracks: 1, linked: false });
    if (r.isError) await json("clip_move", { clips: [top.clips[0]!.id], tracks: 1 });
  });

  await task("undo the move", async () => {
    await call("project_undo");
  });

  await task("read the clips in 1:00-2:00", async () => {
    await json("timeline_clips", { from: 60, to: 120 });
  });

  await task("read what is said in 1:00-2:00", async () => {
    await call("transcript_get", { from: 60, to: 120 });
  });

  await task("zoom in on the top left at 1:30 for 3 s", async () => {
    const screen = (await clipsAt(90)).flatMap((t) => t.clips).find((c) => c.type === "screen")!;
    await json("zoom_to", { clip: screen.id, at: 90, rect: { x: 0, y: 0, width: 1800, height: 1013 }, until: 93 });
  });

  await task("three edits as one undo step", async () => {
    const screen = (await clipsAt(200)).flatMap((t) => t.clips).find((c) => c.type === "screen")!;
    await json("transaction", {
      label: "Mark and fade",
      commands: [
        { command: "marker_add", args: { time: 200, name: "Fade" } },
        { command: "clip_set", args: { clip: screen.id, props: { transform: { opacity: 0.8 } } } },
        { command: "marker_add", args: { time: 210, name: "Back" } },
      ],
    });
  });

  await task("a wrong clip id, then the right one", async () => {
    const r = await call("clip_set", { clip: "c999999", props: { transform: { opacity: 0.9 } } });
    if (!r.isError) throw new Error("a wrong id was taken");
    // An error naming valid ids saves the agent a read.
    const id = /\b(c\d+|clip-[0-9a-f]+)\b(?<!c999999)/.exec(r.text)?.[1] ?? (await clipsAt(10)).flatMap((t) => t.clips)[0]!.id;
    await json("clip_set", { clip: id, props: { transform: { opacity: 0.9 } } });
  });

  const tasks = rows.filter((r) => r !== setup);
  const total = { task: "total (tasks)", ...Object.fromEntries((["calls", "sent", "received", "ms", "errors"] as const).map((k) => [k, tasks.reduce((n, r) => n + r[k], 0)])) } as Row;
  if (values.json) console.log(JSON.stringify({ session, rows: [...rows, total] }, null, 1));
  else {
    console.log(`${session.tools} tools, tools/list ${session.toolsBytes} bytes, instructions ${session.instructions} chars\n`);
    console.log("| Task | Calls | Bytes out | Bytes in | ms | Errors |\n|---|---:|---:|---:|---:|---:|");
    for (const r of [...rows, total]) console.log(`| ${r.task} | ${r.calls} | ${r.sent} | ${r.received} | ${r.ms} | ${r.errors} |`);
  }
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
