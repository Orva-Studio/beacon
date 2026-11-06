// A report a user can send when something goes wrong (Help › Save Diagnostics…): this Mac, Beacon's setup, the open
// projects in numbers, the jobs, and what the app adds (its version, permissions, log and crash reports). Never a key,
// never a file's contents; the home folder, project names and media file names are replaced, as they can name clients.
import { statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, extname } from "node:path";
import { projectDuration, ticksToSeconds, type Project } from "@beacon/model";
import { tool } from "@beacon/media";
import type { JobInfo, PreferenceInfo, ResourceInfo, SecretInfo } from "./api";

/** What the app knows that core doesn't. */
export interface DiagnosticsExtra {
  app?: { version: string; build?: string };
  /** Screen Recording, camera, microphone: granted, denied, not asked. */
  permissions?: Record<string, string>;
  /** The app's log, newest last. */
  log?: string;
  /** Beacon's crash reports: file names, and the newest one's start. */
  crashes?: { names: string[]; newest?: string };
}

export interface DiagnosticsSource {
  projects: { path: string; doc: Project }[];
  settings: unknown;
  preferences: PreferenceInfo[];
  secrets: SecretInfo[];
  resources: ResourceInfo[];
  jobs: JobInfo[];
}

const run = (cmd: string[]) => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};

/**
 * A path in a user's folders or on a disk, to the end of its last part: the folders and file names in it can name
 * clients, whichever project they were from (the log keeps earlier sessions'), so all that is kept is its extension.
 */
const PATH = /(?:~|\/(?:Users|Volumes)\/[^/\n]+)((?:\/[^/\n]+)+)/g;
const EXTENSION = /\.[A-Za-z0-9]{1,8}(?=$|[\s:,;)'"\]])/;

/** Replaces the home folder, each name in `names`, then every path, so the report says what kind of file, not whose. */
export function redactor(names: Map<string, string>): (text: string) => string {
  const home = homedir();
  const ordered = [...names].filter(([n]) => n.length > 2).sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text.split(home).join("~");
    for (const [name, as] of ordered) out = out.split(name).join(as);
    return out.replace(PATH, (_, rest: string) => {
      const last = rest.slice(rest.lastIndexOf("/") + 1);
      const ext = EXTENSION.exec(last);
      return ext ? `<path>${ext[0]}${last.slice(ext.index + ext[0].length)}` : "<path>";
    });
  };
}

function machine(): string[] {
  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
  let free = "";
  try {
    const s = statfsSync(homedir());
    free = gb(s.bavail * s.bsize);
  } catch {
    free = "unknown";
  }
  return [
    `macOS ${run(["sw_vers", "-productVersion"]) || "unknown"} (${run(["sw_vers", "-buildVersion"]) || "?"})`,
    `${run(["sysctl", "-n", "machdep.cpu.brand_string"]) || "unknown chip"}, ${run(["sysctl", "-n", "hw.model"]) || "unknown model"}, ${gb(totalmem())} memory, ${free} free on the home disk`,
  ];
}

function project(doc: Project, i: number): string[] {
  const assets = Object.values(doc.assets);
  const kinds = new Map<string, number>();
  for (const a of assets) kinds.set(`${a.kind} ${extname(a.path) || "(no extension)"}`, (kinds.get(`${a.kind} ${extname(a.path) || "(no extension)"}`) ?? 0) + 1);
  const clips = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
  const { width, height, fps } = doc.settings;
  return [
    `project ${i + 1}: ${width}×${height} at ${(fps.num / fps.den).toFixed(2)} fps, ${ticksToSeconds(projectDuration(doc)).toFixed(1)} s, ${doc.tracks.length} tracks, ${clips} clips, ${assets.length} media (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ") || "none"})${doc.settings.standalone ? ", standalone" : ""}`,
  ];
}

/** The report, as plain text. */
export function diagnosticsReport(src: DiagnosticsSource, extra: DiagnosticsExtra = {}): string {
  const names = new Map<string, string>();
  src.projects.forEach(({ path, doc }, i) => {
    names.set(basename(path, extname(path)), `<project ${i + 1}>`);
    for (const [k, a] of Object.values(doc.assets).entries()) names.set(basename(a.path, extname(a.path)), `<media ${i + 1}.${k + 1}>`);
  });
  const ffmpeg = (() => {
    try {
      return run([tool("ffmpeg"), "-version"]).split("\n")[0] ?? "";
    } catch (e) {
      return `not found (${e instanceof Error ? e.message : e})`;
    }
  })();
  const section = (title: string, lines: string[]) => [``, `## ${title}`, ...(lines.length ? lines : ["(none)"])];
  const lines = [
    `# Beacon diagnostics`,
    `Made ${new Date().toISOString()}. It holds no keys and no file contents; paths and media names are replaced. Look it over before you send it.`,
    ``,
    `Beacon ${extra.app?.version ?? "(not from the app)"}${extra.app?.build ? ` (build ${extra.app.build})` : ""}`,
    ...machine(),
    ...section("Permissions", Object.entries(extra.permissions ?? {}).map(([k, v]) => `${k}: ${v}`)),
    ...section("Tools", [ffmpeg || "ffmpeg: no version", ...src.resources.map((r) => `${r.title}: ${r.present ? "downloaded" : "not downloaded"}`)]),
    ...section("Settings", [JSON.stringify(src.settings)]),
    ...section("Preferences", src.preferences.map((p) => `${p.id}: ${p.value}`)),
    ...section("Keys", src.secrets.map((s) => `${s.title}: ${s.set ? "set" : "not set"}`)),
    ...section("Open projects", src.projects.flatMap(({ doc }, i) => project(doc, i))),
    ...section("Jobs", src.jobs.map((j) => `${j.label}: ${j.state}${j.state === "running" ? ` ${Math.round(j.progress * 100)}%` : ""}, ${Math.round(j.elapsed)} s${j.error ? `: ${j.error}` : ""}`)),
    ...section("Crash reports", extra.crashes ? [...extra.crashes.names, ...(extra.crashes.newest ? ["", "newest:", extra.crashes.newest] : [])] : []),
    ...section("Log", extra.log ? extra.log.split("\n") : []),
  ];
  return redactor(names)(lines.join("\n")) + "\n";
}
