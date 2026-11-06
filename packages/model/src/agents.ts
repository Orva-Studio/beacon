/** Agents as people read their names: an MCP client's own name ("claude-code") to "Claude Code"; others as they are. */
const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "codex-mcp-client": "Codex" };
export const agentName = (name: string) => AGENT_NAMES[name] ?? name;
