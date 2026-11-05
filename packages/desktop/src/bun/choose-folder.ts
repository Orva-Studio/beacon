import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Finder's folder picker with a New Folder button: AppleScript's `choose folder` (Electrobun's `openFileDialog` leaves
 * NSOpenPanel's `canCreateDirectories` off and has no option for it). osascript brings its dialog to the front itself;
 * Cancel (error -128) gives null.
 */
export async function chooseFolder(start: string): Promise<string | null> {
  const expanded = start.replace(/^~(?=\/|$)/, homedir());
  const from = existsSync(expanded) ? expanded : homedir();
  const script = ["on run argv", "activate", "return POSIX path of (choose folder default location (POSIX file (item 1 of argv) as alias))", "end run"];
  const p = Bun.spawn(["/usr/bin/osascript", ...script.flatMap((line) => ["-e", line]), from], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0 || !out) return null;
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}
