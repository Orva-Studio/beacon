import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jobSignal, spawn, toolsDir, until } from "@beacon/media";
import type { AgentAbout } from "./api";

/** Agents Beacon can start a run of, by their CLI's name: each given a request with Beacon's tools attached. */
export const RUN_AGENTS = ["codex"] as const;
export type RunAgent = (typeof RUN_AGENTS)[number];

/** Where agent CLIs are usually installed: an app opened from Finder doesn't get the shell's PATH. */
const PLACES = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global/bin"), join(homedir(), ".bun/bin")];

const found = new Map<string, { path: string; version: string } | null>();

/** An agent's CLI and its version, found once: the usual places, else the user's login shell; null when it isn't installed. */
export async function findAgentCli(name: RunAgent, given?: string): Promise<{ path: string; version: string } | null> {
  if (!given && found.has(name)) return found.get(name)!;
  let path = given ?? PLACES.map((d) => join(d, name)).find(existsSync);
  if (!path) {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = Bun.spawnSync([shell, "-lc", `command -v ${name}`], { stdout: "pipe", stderr: "ignore" });
    path = r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
  }
  let result: { path: string; version: string } | null = null;
  if (path && existsSync(path)) {
    const v = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    result = { path, version: v.stdout.toString().trim().split(/\s+/).pop() ?? "" };
  }
  if (!given) found.set(name, result);
  return result;
}

/** How an agent starts Beacon's MCP server: the app's compiled beacon-mcp, else the repo's source with this Bun. */
export function mcpCommand(): { command: string; args: string[] } {
  const compiled = join(toolsDir(), "beacon-mcp");
  if (existsSync(compiled)) return { command: compiled, args: [] };
  return { command: process.execPath, args: [join(import.meta.dir, "../../mcp/src/main.ts")] };
}

/** The request as the run is given it: the user's words, what they are about, and how to work. */
export function runPrompt(prompt: string, about: AgentAbout): string {
  const lines = [
    "The user typed this request in Beacon, a video editor, about their project:",
    "",
    prompt,
    "",
    "What it is about:",
    ...(about.project ? [`- project: ${about.project} (open it with the beacon tool project_open; the Beacon app has it open, so your edits show there live)`] : []),
    ...(about.label ? [`- ${about.label}`] : []),
    ...(about.clip ? [`- clip id: ${about.clip}`] : []),
    ...(about.section ? [`- section id: ${about.section}`] : []),
    ...(about.from !== undefined && about.to !== undefined ? [`- timeline: ${about.from.toFixed(2)} s to ${about.to.toFixed(2)} s`] : []),
    "",
    "Work only through the beacon MCP tools (read beacon://docs resources when you need them); don't run shell commands or edit files. Finish with one line saying what you did, or why you couldn't.",
  ];
  return lines.join("\n");
}

/** One step a run reports: a message of the agent's, or a tool it called. */
export interface RunStep {
  message?: string;
  tool?: string;
}

/**
 * Runs `codex exec` on a request, with Beacon's MCP server attached and its tools approved for this run only, in a
 * read-only sandbox (it changes the project through Beacon's tools alone). Reports each step; returns its last message.
 */
export async function runCodex(cli: string, prompt: string, about: AgentAbout, step: (s: RunStep) => void): Promise<string> {
  const mcp = mcpCommand();
  const toml = (v: string) => JSON.stringify(v);
  const cwd = about.project ? dirname(about.project) : homedir();
  const args = [
    cli,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    cwd,
    "-c",
    'approval_policy="never"',
    "-c",
    `mcp_servers.beacon.command=${toml(mcp.command)}`,
    "-c",
    `mcp_servers.beacon.args=[${mcp.args.map(toml).join(",")}]`,
    "-c",
    'mcp_servers.beacon.default_tools_approval_mode="approve"',
    runPrompt(prompt, about),
  ];
  const proc = spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // Cancelled: stop reading at once; a child of the run can keep its output open after it is killed.
  const signal = jobSignal() ?? new AbortController().signal;
  signal.addEventListener("abort", () => proc.kill(), { once: true });
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let last = "";
  let failed = "";
  let buffered = "";
  for (;;) {
    const { done, value: chunk } = await until(reader.read(), signal);
    if (done) break;
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) {
      let e: { type?: string; item?: { type?: string; text?: string; tool?: string; message?: string }; error?: { message?: string } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "item.started" && e.item?.type === "mcp_tool_call" && e.item.tool) step({ tool: e.item.tool });
      if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) {
        last = e.item.text;
        step({ message: last });
      }
      if (e.type === "turn.failed" || e.type === "error") failed = e.error?.message ?? (e as { message?: string }).message ?? "it stopped";
    }
  }
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0 || failed) throw new Error(`Codex ${failed ? `stopped: ${failed}` : `exited with ${code}: ${err.trim().split("\n").slice(-2).join(" | ")}`}`);
  return last;
}
