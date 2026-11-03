import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore, type AppEvent } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-agent-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in `codex`: answers --version, writes its arguments down, and speaks codex exec's JSON events (or fails, or waits). */
function fakeCodex(mode: "ok" | "fail" | "slow") {
  const path = join(dir, `codex-${mode}`);
  const events = [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { type: "agent_message", text: "I'll open the project." } },
    { type: "item.started", item: { type: "mcp_tool_call", server: "beacon", tool: "project_open" } },
    { type: "item.completed", item: { type: "agent_message", text: "Made it a counter from 0 to 10,000." } },
    { type: "turn.completed" },
  ];
  const jsonl = join(dir, `events-${mode}.jsonl`);
  writeFileSync(jsonl, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(join(dir, `args-${mode}`))}
${mode === "slow" ? "sleep 30" : ""}
${mode === "fail" ? 'echo "not logged in" >&2; exit 1' : `cat ${JSON.stringify(jsonl)}`}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function events(core: LocalCore, request: string, until: (e: AppEvent[]) => boolean, seen: AppEvent[]) {
  for (let i = 0; i < 200 && !until(seen.filter((e) => e.kind === "agent" && e.request === request)); i++) await Bun.sleep(25);
  return seen.filter((e) => e.kind === "agent" && e.request === request);
}

// Codex can't take a request into an open session as Claude Code does (the user, 2026-11-03): Beacon starts a run of it.
test("Ask an Agent with Codex starts a run with Beacon's tools attached and approved, in a read-only sandbox; its steps and last message come back, a failure says why, and Cancel stops it", async () => {
  const seen: AppEvent[] = [];
  const make = (mode: "ok" | "fail" | "slow") => new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), controlDir: join(dir, "control"), agentClis: { codex: fakeCodex(mode) } });
  const core = make("ok");
  core.watchApp((e) => seen.push(e));
  expect((await core.agents()).filter((a) => a.run)).toEqual([{ socket: "run:codex", name: "codex", version: "9.9.9", started: 0, run: true }]);

  const about = { project: join(dir, "demo.beproj"), clip: "clip-7", from: 2, to: 5, label: "Motion graphic, 0:02–0:05" };
  const request = await core.askAgent("run:codex", "Make this a counter", about);
  const told = await events(core, request, (e) => e.some((x) => x.kind === "agent" && x.status === "done"), seen);
  expect(told.map((e) => (e.kind === "agent" ? [e.status, e.text] : []))).toEqual([
    ["received", undefined],
    ["received", "I'll open the project."],
    ["received", "Using project open"],
    ["received", "Made it a counter from 0 to 10,000."],
    ["done", "Made it a counter from 0 to 10,000."],
  ]);
  // The request id is the job's.
  expect((await core.job(request)).state).toBe("done");
  const args = readFileSync(join(dir, "args-ok"), "utf8").split("\n");
  expect(args.slice(0, 7)).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", dir]);
  expect(args).toContain('approval_policy="never"');
  expect(args).toContain('mcp_servers.beacon.default_tools_approval_mode="approve"');
  expect(args.find((a) => a.startsWith("mcp_servers.beacon.args="))).toContain("mcp/src/main.ts");
  const prompt = args.slice(args.indexOf('mcp_servers.beacon.default_tools_approval_mode="approve"') + 1).join("\n");
  expect(prompt).toContain("Make this a counter");
  expect(prompt).toContain(`- project: ${about.project}`);
  expect(prompt).toContain("- clip id: clip-7");
  expect(prompt).toContain("- timeline: 2.00 s to 5.00 s");
  expect(prompt).toContain("don't run shell commands");

  // It fails: the toast says why.
  const failing = make("fail");
  failing.watchApp((e) => seen.push(e));
  const bad = await failing.askAgent("run:codex", "Anything", about);
  const failed = await events(failing, bad, (e) => e.some((x) => x.kind === "agent" && x.status === "done"), seen);
  expect(failed.at(-1)).toMatchObject({ status: "done", text: expect.stringContaining("Codex exited with 1: not logged in") });

  // Cancelled: the run stops, and says so.
  const slow = make("slow");
  slow.watchApp((e) => seen.push(e));
  const long = await slow.askAgent("run:codex", "Anything", about);
  await Bun.sleep(300);
  await slow.cancelJob(long);
  const stopped = await events(slow, long, (e) => e.some((x) => x.kind === "agent" && x.status === "done"), seen);
  expect(stopped.at(-1)).toMatchObject({ status: "done", text: "Cancelled" });

  // Not installed: not offered, and refused.
  const none = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), controlDir: join(dir, "control"), agentClis: {} });
  expect((await none.agents()).some((a) => a.run)).toBe(false);
  await expect(none.askAgent("run:codex", "x", {})).rejects.toThrow("codex isn't installed");
}, 30_000);
