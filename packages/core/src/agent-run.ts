import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jobSignal, spawn, toolsDir, until } from "@beacon/media";
import type { AgentAbout, AgentSession } from "./api";
import { shortId, type CoreParts } from "./project";
import { askControl, controlSockets } from "./socket";

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

/** What agent sessions and runs are given of core: who it is, where sessions' sockets are, and how to tell a reply. */
export interface AgentRunsContext {
  readonly parts: CoreParts;
  /** This process's own control socket, left out of the sessions found. */
  readonly control?: string;
  /** The automation socket a session replies to. */
  readonly socket?: string;
  readonly controlDir?: string;
  readonly agentClis?: Partial<Record<RunAgent, string>>;
  reply(request: string, status: "received" | "done", text?: string): void;
}

/** Agent sessions connected to Beacon (asked through their control sockets), and runs of agent CLIs Beacon starts itself. */
export class AgentRuns {
  constructor(readonly ctx: AgentRunsContext) {}

  async agents(): Promise<AgentSession[]> {
    const mine = this.ctx.control;
    const found = await Promise.all(
      controlSockets(this.ctx.controlDir).filter((s) => s !== mine).map(async (socket): Promise<AgentSession | undefined> => {
        try {
          const info = (await askControl(socket, "agent", [], 1000)) as { name: string; version: string; project?: string };
          return { socket, name: info.name, version: info.version, ...(info.project ? { project: info.project } : {}), started: statSync(socket).mtimeMs };
        } catch {
          // An MCP server from before Beacon asked this, or one that is gone.
          return undefined;
        }
      }),
    );
    const sessions = found.filter((a): a is AgentSession => !!a).sort((a, b) => b.started - a.started);
    const runs = await Promise.all(RUN_AGENTS.map(async (name) => ({ name, cli: await this.#agentCli(name) })));
    return [...sessions, ...runs.flatMap(({ name, cli }) => (cli ? [{ socket: `run:${name}`, name, version: cli.version, started: 0, run: true }] : []))];
  }

  #agentCli(name: RunAgent) {
    const given = this.ctx.agentClis;
    if (given) return given[name] ? findAgentCli(name, given[name]) : Promise.resolve(null);
    return findAgentCli(name);
  }

  async ask(socket: string, prompt: string, about: AgentAbout): Promise<string> {
    if (socket.startsWith("run:")) return this.#runAgent(socket.slice(4) as RunAgent, prompt, about);
    if (!controlSockets(this.ctx.controlDir).includes(socket)) throw new Error("that agent session has ended");
    const request = shortId("ask");
    const meta: Record<string, string> = { request, ...(this.ctx.socket ? { reply_to: this.ctx.socket } : {}) };
    for (const [k, v] of Object.entries(about)) if (v !== undefined) meta[k] = typeof v === "number" ? v.toFixed(2) : v;
    await askControl(socket, "prompt", [prompt, meta]);
    return request;
  }

  /** A run of an agent's CLI on the request, as a job whose id is the request's: its steps and last message as `agent` events. */
  async #runAgent(name: RunAgent, prompt: string, about: AgentAbout): Promise<string> {
    if (!RUN_AGENTS.includes(name)) throw new Error(`Beacon can't start a run of ${name}`);
    const cli = await this.#agentCli(name);
    if (!cli) throw new Error(`${name} isn't installed`);
    const tell = (status: "received" | "done", text?: string) => this.ctx.reply(job.id, status, text);
    const job = this.ctx.parts.startJob(undefined, "agent", `Codex: ${prompt.slice(0, 60)}`, async (progress) => {
      const last = await runCodex(cli.path, prompt, about, (s) => {
        const text = s.tool ? `Using ${s.tool.replace(/_/g, " ")}` : s.message;
        progress(0, text);
        tell("received", text);
      }).catch((e: Error) => {
        tell("done", jobSignal()?.aborted || e.message === "cancelled" ? "Cancelled" : e.message);
        throw e;
      });
      tell("done", last || "Done");
      return { message: last };
    });
    // Told once the id is known: it is the request's.
    queueMicrotask(() => tell("received"));
    return job.id;
  }
}
