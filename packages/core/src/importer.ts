import { existsSync, rmSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { importCmproj } from "@beacon/camtasia";
import { fileFingerprint } from "@beacon/media";
import { projectDuration, secondsToTicks, ticksToSeconds, type Asset, type MediaImporterDef, type Project } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import type { ImportOptions, ImportResult, ProjectHandle } from "./api";
import type { Analyses } from "./analyses";
import type { AppConfig } from "./config";
import { copyIntoProject, isInside } from "./media-copy";
import { probeAsset, type CoreParts, type OpenProject } from "./project";

/** Media brought into projects: files probed and placed, copies into project folders, and what a Camtasia project's import left out. */
export class Importer {
  readonly #reports = new Map<string, string[]>();
  #imports = 0;

  constructor(
    readonly parts: CoreParts,
    readonly config: AppConfig,
    readonly analyses: Analyses,
  ) {}

  /** A Camtasia project read for a new project at `dir`; what it left out or changed is kept for `report`. */
  async cmproj(dir: string, file: string): Promise<Project> {
    const { project, report } = await importCmproj(resolve(file), this.parts.registry);
    for (const line of report) console.error(`import: ${line}`);
    this.#reports.set(dir, report);
    return project;
  }

  report(h: ProjectHandle): string[] {
    return this.#reports.get(resolve(h)) ?? [];
  }

  /**
   * Copies media from outside the project folder into its `media` folder: the assets as they will be, each with
   * its copy's path and the results (transcripts) its original had. Missing files are left as they are.
   */
  async copyIn(dir: string, assets: Asset[]): Promise<Asset[]> {
    const outside = assets.filter((a) => !isInside(dir, a.path) && existsSync(a.path));
    if (!outside.length) return [];
    const copies = await copyIntoProject(dir, outside.map((a) => a.path));
    const data = new DerivedData(this.parts.registry, this.parts.cacheDir, () => ({ assets: {} }) as unknown as Project, this.config.pref);
    return outside.map((a) => {
      const path = copies.get(a.path)!;
      const copy = { ...a, path, fingerprint: fileFingerprint(path) };
      data.carry(a, copy);
      return copy;
    });
  }

  /** All or nothing: every file is probed first, then they are added in one undo step. */
  async import(p: OpenProject, files: string[], opts: ImportOptions): Promise<ImportResult> {
    const id = `import-${++this.#imports}`;
    const paths = files.map((f) => resolve(f));
    this.parts.emit(p, { kind: "importing", id, files: paths, state: "reading" });
    try {
      const result = await this.#import(p, paths, opts);
      this.parts.emit(p, { kind: "importing", id, files: paths, state: "done", assets: result.assets });
      return result;
    } catch (e) {
      this.parts.emit(p, { kind: "importing", id, files: paths, state: "failed", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async #import(p: OpenProject, files: string[], opts: ImportOptions): Promise<ImportResult> {
    const { registry } = this.parts;
    const result: ImportResult = { assets: [], clips: [], jobs: [] };
    const todo = files.map((file) => {
      const importer = registry.importerFor(extname(file));
      if (!importer) throw new Error(`no feature imports ${extname(file) || "files without an extension"} (${file})`);
      return { file, importer };
    });
    // A few at a time: each decodes its audio once for its loudness.
    const probed: { file: string; importer: MediaImporterDef; asset: Omit<Asset, "id"> }[] = new Array(todo.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < todo.length; i = next++) {
        const { file, importer } = todo[i]!;
        try {
          probed[i] = { file, importer, asset: { kind: importer.kind, path: file, fingerprint: fileFingerprint(file), derived: await (importer.probe ?? probeAsset)(file) } };
        } catch (e) {
          // The import fails: the others stop rather than decode the rest for nothing.
          next = todo.length;
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    let at = opts.at === undefined ? projectDuration(p.store.doc) : secondsToTicks(opts.at);
    const cursorScale = this.config.settings().cursorScale ?? 1;
    const label = probed.length === 1 ? `Import ${basename(probed[0]!.file)}` : `Import ${probed.length} files`;
    const copied = probed.flatMap(({ asset, importer }, i) => (p.store.doc.settings.standalone || importer.copyIn ? [{ id: String(i), ...asset }] : []));
    const copies = copied.length ? await this.copyIn(p.path, copied) : [];
    for (const { id, path, fingerprint } of copies) Object.assign(probed[Number(id)]!.asset, { path, fingerprint });
    try {
      this.parts.saved(
        p,
        p.store.transaction(label, (tx) => {
          for (const { importer, asset } of probed) {
            const id = tx.run<string>("asset.add", asset);
            result.assets.push(id);
            if (opts.place === false) continue;
            const placed = tx.run<string[]>("asset.place", { asset: id, time: ticksToSeconds(at), ...(opts.track ? { track: opts.track } : {}) });
            result.clips.push(...placed);
            // A recording's cursor starts at the size Settings › Recording gives (100% unset).
            if (cursorScale !== 1 && importer.kind === "recording") {
              // asset.place returns the clips in the importer's order.
              const specs = importer.clips({ id, ...asset }, p.store.doc);
              const cursors = placed.filter((_, i) => specs[i] && registry.group(specs[i]!.type, "cursor"));
              if (cursors.length) tx.run("clip.set", { clips: cursors, props: { cursor: { scale: cursorScale } } });
            }
            at += Math.max(0, ...importer.clips({ id, ...asset }, p.store.doc).map((s) => s.duration));
          }
        }),
        false,
      );
    } catch (e) {
      for (const c of copies) rmSync(c.path, { recursive: true, force: true });
      throw e;
    }
    return this.analyses.imported(p, result);
  }
}
