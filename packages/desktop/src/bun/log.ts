// Beacon's own log, ~/Library/Logs/Beacon/beacon.log: a release's stderr goes nowhere, so warnings, errors and failed
// jobs are kept here for Help › Save Diagnostics… Rolled over to beacon.old.log at 2 MB.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

export const LOG_DIR = join(homedir(), "Library/Logs/Beacon");
export const LOG = join(LOG_DIR, "beacon.log");
const MAX = 2 * 1024 * 1024;

export function log(level: "info" | "warn" | "error", ...parts: unknown[]) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > MAX) renameSync(LOG, join(LOG_DIR, "beacon.old.log"));
    const text = parts.map((p) => (typeof p === "string" ? p : inspect(p, { depth: 4, breakLength: Infinity }))).join(" ");
    appendFileSync(LOG, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    // A log that can't be written mustn't take the app with it.
  }
}

/** console.warn and console.error into the log too, and what nothing caught. */
export function startLog(version: string) {
  for (const level of ["warn", "error"] as const) {
    const was = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log(level, ...args);
      was(...args);
    };
  }
  // Ahead of Electrobun's handler, which exits the app at once.
  process.prependListener("uncaughtException", (e) => log("error", "uncaught:", e));
  process.on("unhandledRejection", (e) => log("error", "unhandled rejection:", e));
  log("info", `Beacon ${version} started`);
}

/** The log's last `lines` lines, the old file's end first when the new one is short. */
export function logTail(lines = 400): string {
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  const all = [...read(join(LOG_DIR, "beacon.old.log")), ...read(LOG)];
  return all.slice(-lines).join("\n");
}

/** Beacon's crash reports from the last two weeks (its launcher, Bun, and its helpers), newest first. */
export function crashReports(days = 14): { names: string[]; newest?: string } {
  const dir = join(homedir(), "Library/Logs/DiagnosticReports");
  if (!existsSync(dir)) return { names: [] };
  const since = Date.now() - days * 86_400_000;
  const ours = readdirSync(dir)
    .filter((f) => /^(Beacon|launcher|bun|beacon-[a-z]+|ffmpeg|ffprobe|whisper-cli)[-_.]/i.test(f))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .filter((x) => x.at > since)
    .sort((a, b) => b.at - a.at);
  const newest = ours[0] && readFileSync(join(dir, ours[0].f), "utf8").split("\n").slice(0, 80).join("\n");
  return { names: ours.map((x) => x.f), ...(newest ? { newest } : {}) };
}
