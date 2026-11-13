// What agents reach outside Beacon's MCP tools for, read from Claude Code's own session transcripts (nothing new
// is recorded). Every Bash call in an editing session marks a tool Beacon is missing; the output stays on this Mac.
//   bun scripts/agent-gaps.ts [--since 2026-11-01] [--examples 5] [--min-beacon 25]
import { Glob } from "bun";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    since: { type: "string" },
    examples: { type: "string", default: "5" },
    "min-beacon": { type: "string", default: "25" },
  },
});
const since = opt.since ? Date.parse(opt.since) : 0;
const examples = Number(opt.examples);
const minBeacon = Number(opt["min-beacon"]);

// A Bash call can fall in more than one group; it is counted in each.
const groups: [string, RegExp][] = [
  ["Motion graphics built outside Beacon", /graphic|\brender|motion|html|frames|contact sheet|\bsheet\b/i],
  ["Web capture (screenshots, scroll recordings)", /screenshot|captur|scroll|cookie|carousel|cdp|chrom|playwright|browser|embed/i],
  ["Media prep (download, convert, crop, logos)", /download|convert|crop|logo|photo|icon|encod|ffmpeg|ffprobe|loudness|probe/i],
  ["Past projects and references", /reference|previous|recent sessions|camtasia|past edit|other projects/i],
  ["Reading Beacon's source for settings", /effect|param|feature folder|handler|codebase|runtime/i],
  ["Transcript or project files read directly", /transcript|word tim|project\.json|print words/i],
  ["Long command lists built in a script", /command list|commands for every|for every clip/i],
];

type Call = { id: string; name: string; at: number; text: string };
type Session = { file: string; beacon: Call[]; shell: Call[]; commits: number; results: Map<string, { at: number; error: boolean }> };

const sessions: Session[] = [];
{
  for await (const rel of new Glob(`.claude*/projects/*/*.jsonl`).scan({ cwd: homedir(), dot: true })) {
    const file = `${homedir()}/${rel}`;
    const s: Session = { file, beacon: [], shell: [], commits: 0, results: new Map() };
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(d.timestamp ?? "");
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (d.type === "assistant" && b.type === "tool_use") {
          const call: Call = { id: b.id, name: b.name, at, text: b.input?.description ?? b.input?.command ?? "" };
          if (b.name.startsWith("mcp__beacon__")) s.beacon.push(call);
          else if (b.name === "Bash") {
            s.shell.push(call);
            if (/git commit/.test(b.input?.command ?? "")) s.commits++;
          }
        } else if (d.type === "user" && b.type === "tool_result") s.results.set(b.tool_use_id, { at, error: !!b.is_error });
      }
    }
    const last = s.beacon.at(-1)?.at ?? 0;
    // Sessions that commit are building Beacon, not editing a video with it.
    if (s.beacon.length >= minBeacon && s.commits <= 2 && last >= since) sessions.push(s);
  }
}

const shell = sessions.flatMap((s) => s.shell.filter((c) => c.text.trim()));
const beacon = sessions.flatMap((s) => s.beacon.map((c) => ({ ...c, result: s.results.get(c.id) })));
console.log(`${sessions.length} editing sessions: ${beacon.length} Beacon calls, ${shell.length} Bash calls\n`);
for (const s of sessions)
  console.log(`  ${basename(dirname(s.file)).slice(0, 32).padEnd(32)} ${basename(s.file).slice(0, 8)}  beacon ${String(s.beacon.length).padStart(4)}  bash ${String(s.shell.length).padStart(4)}`);

console.log("\nWhat Bash was used for");
const unmatched = shell.filter((c) => !groups.some(([, re]) => re.test(c.text)));
for (const [name, re] of [...groups, ["Other", /$^/] as [string, RegExp]]) {
  const hits = name === "Other" ? unmatched : shell.filter((c) => re.test(c.text));
  console.log(`\n${String(hits.length).padStart(5)}  ${name}`);
  for (const c of hits.slice(-examples)) console.log(`         ${c.text.replace(/\s+/g, " ").slice(0, 110)}`);
}

console.log("\nBeacon tools: calls, median and slowest seconds, errors");
const byTool = Map.groupBy(beacon, (c) => c.name.replace("mcp__beacon__", ""));
const rows = [...byTool].map(([name, calls]) => {
  const secs = calls.flatMap((c) => (c.result ? [(c.result.at - c.at) / 1000] : [])).sort((a, b) => a - b);
  return { name, n: calls.length, median: secs[secs.length >> 1] ?? 0, max: secs.at(-1) ?? 0, errors: calls.filter((c) => c.result?.error).length };
});
for (const r of rows.sort((a, b) => b.n - a.n))
  console.log(`  ${r.name.padEnd(28)} ${String(r.n).padStart(5)}  ${r.median.toFixed(1).padStart(6)}  ${r.max.toFixed(0).padStart(5)}  ${r.errors || ""}`);
