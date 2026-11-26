import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRegistry } from "@beacon/features";
import { readProject } from "@beacon/core";

export const HELP = `beacon: Beacon's tools for agents, as an MCP server, and a check of .beproj projects.

  beacon                 the MCP server, over stdio (also \`beacon mcp\`)
  beacon validate <dir>  check a .beproj: its project.json, and the media it lists
  beacon --version       this build's version
  beacon --help          this

Away from a Mac, Beacon edits projects but doesn't draw, export or transcribe: those need the Beacon
app. ffmpeg and ffprobe come from PATH, or BEACON_TOOLS_DIR. Docs: the server's beacon://docs/cloud.
`;

/** `beacon validate <dir>`: what Beacon would refuse, and what it would measure or miss on opening. Exit code 1 if refused. */
export function validate(path: string | undefined): number {
  if (!path) {
    process.stderr.write("usage: beacon validate <project.beproj>\n");
    return 2;
  }
  const dir = resolve(path);
  const registry: ReturnType<typeof createRegistry> = createRegistry();
  let doc;
  try {
    doc = readProject(dir, registry).doc;
    registry.validate(doc);
  } catch (e) {
    process.stdout.write(`${dir}: not valid: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const assets = Object.values(doc.assets);
  const missing = assets.filter((a) => !existsSync(a.path));
  const unmeasured = assets.filter((a) => !missing.includes(a) && !a.derived.media && !Object.keys(a.derived).length);
  const clips = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
  const lines = [`${dir}: valid (${assets.length} media, ${doc.tracks.length} tracks, ${clips} clips)`];
  for (const a of missing) lines.push(`  missing: ${a.path} (${a.id})`);
  if (unmeasured.length) lines.push(`  not measured yet, measured when the project opens: ${unmeasured.map((a) => a.id).join(", ")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
