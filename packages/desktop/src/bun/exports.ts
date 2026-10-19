import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { JobInfo } from "@beacon/core";
import { DEFAULT_EXPORT, exportCanvas, exportOptions, type ExportSettings } from "@beacon/ui";
import type { App } from "./app";

/** The Export dialog's last folder and settings, offered next time. */
type ExportPrefs = { folder: string; settings: ExportSettings };

/** File > Export… and Export Selection…: the window's Export dialog, the exports it starts, and every export's progress. */
export function createExports(app: App) {
  const { core, message, status } = app;

  function exportPrefs(): ExportPrefs {
    try {
      const saved = (core.readConfig("export.json") ?? {}) as Partial<ExportPrefs>;
      const settings = { ...DEFAULT_EXPORT, ...saved.settings };
      // 6000 was the default before Automatic (0.6): saved by every export, so almost never chosen.
      if (settings.bitrate === 6000) settings.bitrate = null;
      return { folder: saved.folder && existsSync(saved.folder) ? saved.folder : join(homedir(), "Movies"), settings };
    } catch {
      return { folder: join(homedir(), "Movies"), settings: DEFAULT_EXPORT };
    }
  }

  /** Exports started from the window, by job id: their output files. */
  const exports = new Map<string, string>();

  /** Offers the in/out range when there is one; Export Selection… requires it. */
  async function exportDialog(selection = false) {
    const current = app.current();
    if (!current) return status("Open a project first");
    const range = (await core.session(current.path)).range ?? undefined;
    if (selection && !range) return status("Set an in/out range first: ⌘-drag from the playhead");
    const name = basename(current.path, ".beproj");
    message("exportSheet", { name: selection ? `${name} selection` : name, ...exportPrefs(), ...(range ? { range } : {}), canvas: exportCanvas(core.doc(current.path).settings) });
  }

  async function startExport({ name, folder, settings, range, overwrite }: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; overwrite?: boolean }) {
    const current = app.current();
    if (!current) throw new Error("Open a project first");
    if (!name || /[/:]/.test(name)) throw new Error("Give the file a name without / or :");
    const output = join(folder, `${name}.${settings.format}`);
    if (!overwrite && existsSync(output)) throw new Error(`${basename(output)} already exists in ${basename(folder)}`);
    try {
      core.writeConfig("export.json", { folder, settings });
    } catch {}
    const job = await core.export(current.path, { output, overwrite: true, ...exportOptions(settings), ...(range ? { from: range.in, to: range.out } : {}) });
    exports.set(job.id, output);
    message("exportJob", { id: job.id, output, state: "running", progress: 0 });
  }

  // Exports report here rather than through the open project: one keeps going when another project is opened.
  // Agents' exports too: until it is done, an export started elsewhere is known by its label.
  function exportJob(job: JobInfo) {
    const { id, state, progress, error, result, label } = job;
    const output = exports.get(id) ?? (result as { output?: string } | undefined)?.output ?? label.replace(/^Export /, "");
    message("exportJob", { id, output, state, progress, ...(error ? { error } : {}) });
    if (state !== "running") exports.delete(id);
  }

  return { exportDialog, startExport, exportJob };
}
