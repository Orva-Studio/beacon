import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRegistry } from "@beacon/features";
import { readProject, unmeasured } from "@beacon/core";

export const HELP = `beacon: Beacon's tools for agents, as an MCP server, and a check of .beproj projects.

  beacon                 the MCP server, over stdio (also \`beacon mcp\`)
  beacon validate <dir>  check a .beproj: its project.json, and the media it lists (exit 1 if
                         refused or media is missing)
  beacon --version       this build's version
  beacon --help          this

Away from a Mac, Beacon edits projects but doesn't draw, export or transcribe: those need the Beacon
app. ffmpeg and ffprobe come from PATH, or BEACON_TOOLS_DIR. Docs: the server's beacon://docs/cloud.
`;

/**
 * `beacon validate <dir>`: what Beacon would refuse, and what it would measure or miss on opening. Exit code 1 if
 * refused or media is missing (the project wouldn't work where it is opened), so a hand-over script can stop on it.
 */
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
  const toMeasure = assets.filter((a) => !missing.includes(a) && unmeasured(a, registry));
  const clips = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
  const lines = [`${dir}: valid (${assets.length} media, ${doc.tracks.length} tracks, ${clips} clips)`];
  for (const a of missing) lines.push(`  missing: ${a.path} (${a.id})`);
  if (toMeasure.length) lines.push(`  not measured yet, measured when the project opens: ${toMeasure.map((a) => a.id).join(", ")}`);
  if (missing.length) lines.push(`${missing.length} media missing: put the files where the project says, or in its media folder`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return missing.length ? 1 : 0;
}
