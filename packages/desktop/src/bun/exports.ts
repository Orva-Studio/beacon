import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isAudioFormat, nestedOf, type JobInfo } from "@beacon/core";
import { DEFAULT_EXPORT, exportOptions, exportSheetFor, type ExportSettings } from "@beacon/ui";
import type { App } from "./app";

/** The Export dialog's last folder and settings, offered next time, and the last audio format an audio-only selection starts on. */
type ExportPrefs = { folder: string; settings: ExportSettings; audioFormat?: ExportSettings["format"] };

/** File > Export… and Export Selection…: the window's Export dialog, the exports it starts, and every export's progress. */
export function createExports(app: App) {
  const { core, message, status } = app;

  function exportPrefs(): ExportPrefs {
    try {
      const saved = (core.readConfig("export.json") ?? {}) as Partial<ExportPrefs>;
      const settings = { ...DEFAULT_EXPORT, ...saved.settings };
      // 6000 was the default before Automatic (0.6): saved by every export, so almost never chosen.
      if (settings.bitrate === 6000) settings.bitrate = null;
      return { folder: saved.folder && existsSync(saved.folder) ? saved.folder : join(homedir(), "Movies"), settings, ...(saved.audioFormat ? { audioFormat: saved.audioFormat } : {}) };
    } catch {
      return { folder: join(homedir(), "Movies"), settings: DEFAULT_EXPORT };
    }
  }

  /** Exports started from the window, by job id: their output files. */
  const exports = new Map<string, string>();

  /** File > Export… (⌘E) and Export Selection…: the window's Export sheet, as `exportSheetFor` decides it. */
  async function exportDialog(selection = false) {
    const current = app.current();
    if (!current) return status("Open a project first");
    const prefs = exportPrefs();
    const sheet = exportSheetFor({
      name: basename(current.path, ".beproj"),
      project: core.doc(current.path),
      session: await core.session(current.path),
      traits: (type) => core.registry.clipTypes.get(type)?.traits ?? [],
      nested: nestedOf(core.registry),
      ...prefs,
      selection,
    });
    if (!sheet) return status("Select clips or set an in/out range first (⌘-drag from the playhead)");
    message("exportSheet", sheet);
  }

  async function startExport({ name, folder, settings, range, clips, overwrite }: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; clips?: string[]; overwrite?: boolean }) {
    const current = app.current();
    if (!current) throw new Error("Open a project first");
    if (!name || /[/:]/.test(name)) throw new Error("Give the file a name without / or :");
    const output = join(folder, `${name}.${settings.format}`);
    if (!overwrite && existsSync(output)) throw new Error(`${basename(output)} already exists in ${basename(folder)}`);
    try {
      // A selection's format follows what was picked (audio, no audio track): the usual settings stay as they were.
      const prefs = exportPrefs();
      core.writeConfig("export.json", { ...prefs, folder, ...(clips ? {} : { settings }), ...(isAudioFormat(settings.format) ? { audioFormat: settings.format } : {}) });
    } catch {}
    const job = await core.export(current.path, { output, overwrite: true, ...exportOptions(settings), ...(clips ? { clips } : range ? { from: range.in, to: range.out } : {}) });
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

  return { exportDialog, startExport, exportJob, owns: (id: string) => exports.has(id) };
}
