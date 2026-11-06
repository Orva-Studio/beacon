import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { nestedOf, onlyClips, projectDuration, secondsToTicks, ticksToSeconds } from "@beacon/model";
import { checkEncoding, DerivedData, renderProject, videoFormat } from "@beacon/render";
import type { ExportOptions, Job } from "./api";
import type { Analyses } from "./analyses";
import type { AppConfig } from "./config";
import type { Jobs } from "./jobs";
import { realPath } from "./media-copy";
import type { CoreParts, OpenProject } from "./project";

/** The encoding options of an export call, without its other fields. */
const encoding = ({ output: _, overwrite: _o, from: _f, to: _t, ...rest }: ExportOptions) => rest;

/** Exports (a video, or PNG frames, and the side files features write beside it), and where anything may be written. */
export class Exporter {
  constructor(
    readonly parts: CoreParts,
    readonly jobs: Jobs,
    readonly config: AppConfig,
    readonly analyses: Analyses,
  ) {}

  checkOutput(p: OpenProject, path: string, opts: { overwrite?: boolean } = {}): void {
    const out = resolve(path);
    // Where it really lands: a link on the way (a folder linked into a project, a file linked to media) is followed.
    const real = realPath(out);
    const doc = p.store.doc;
    if (Object.values(doc.assets).some((a) => resolve(a.path) === out || realPath(resolve(a.path)) === real)) throw new Error(`${out} is media used by the project; write somewhere else`);
    const bundle = [...out.split(sep), ...real.split(sep)].find((part) => /\.(cmproj|beproj)$/i.test(part));
    if (bundle) throw new Error(`${out} is inside ${bundle}; write outside project folders`);
    if (opts.overwrite || !existsSync(out)) return;
    if (statSync(out).isDirectory() ? readdirSync(out).length > 0 : true) throw new Error(`${out} already exists; pass overwrite to replace it`);
  }

  export(p: OpenProject, opts: ExportOptions): Job {
    const { registry, cacheDir } = this.parts;
    const only = opts.clips && onlyClips(p.store.doc, opts.clips, nestedOf(registry));
    const missing = only && opts.clips!.find((id) => !only.found.some((c) => c.id === id));
    if (missing) throw new Error(`no clip "${missing}" on the timeline`);
    const project = only ? only.project : p.store.doc;
    if (only) opts = { from: only.from, to: only.to, ...opts };
    const output = resolve(opts.output);
    this.checkOutput(p, output, { overwrite: opts.overwrite });
    // Refused before the job starts, not after a render.
    if (!opts.output.endsWith("/")) checkEncoding(videoFormat(output), opts);
    const speed = opts.speed ?? 1;
    if (!(speed >= 0.25 && speed <= 3)) throw new Error(`an export plays at 0.25× to 3×, not ${opts.speed}×`);
    const colorSpace = this.config.settings().exportColorSpace;
    // Edits made while it renders must not reach the export, its derived data included.
    const data = new DerivedData(registry, cacheDir, () => project, this.config.pref);
    // Beside a video, files features write from the same range (captions as .srt) when asked for, named after it.
    const range = { from: opts.from ?? 0, to: opts.to ?? ticksToSeconds(projectDuration(project)), speed };
    const sides = opts.output.endsWith("/")
      ? []
      : [...registry.exportFiles.values()].filter((f) => opts.files?.includes(f.id)).flatMap((f) => {
          const text = f.write(range, { project, registry, data: data.get, pref: data.pref });
          return text === undefined ? [] : [{ path: join(dirname(output), basename(output, extname(output)) + f.extension), text }];
        });
    for (const f of sides) this.checkOutput(p, f.path, { overwrite: opts.overwrite });
    mkdirSync(opts.output.endsWith("/") ? output : dirname(output), { recursive: true });
    // What effects need (a matte) is made first: the export never draws a clip without it.
    const needed = this.analyses.effectJobs(p, true);
    // What it waits for, as the export card says it: the effect that needs it and what it is doing ("Remove Background: finding the person").
    const waitingFor = (key: string) => {
      const fx = [...registry.effects.values()].find((e) => e.needs?.includes(key));
      return fx ? `${fx.title}: ${(fx.preparing ?? "preparing").toLowerCase()}` : key;
    };
    return this.parts.startJob(p, "export", `Export ${basename(output)}`, async (progress) => {
      if (needed.length) {
        const info = (id: string) => {
          try {
            return this.jobs.info(id);
          } catch {
            return undefined;
          }
        };
        const what = [...new Set(needed.map((j) => waitingFor(info(j.id)?.kind ?? "")))].filter(Boolean).join(", ");
        let left = needed.length;
        for (const j of needed) void j.done.finally(() => left--).catch(() => {});
        while (left > 0) {
          const share = needed.reduce((n, j) => n + (info(j.id)?.progress ?? 1), 0) / needed.length;
          progress(share, `Waiting for ${what} (${Math.round(share * 100)}%)`);
          await Promise.race([Promise.allSettled(needed.map((j) => j.done)), Bun.sleep(500)]);
        }
        await Promise.all(needed.map((j) => j.done));
      }
      progress(0, "Starting: opening the media");
      let started = false;
      const from = opts.from === undefined ? undefined : secondsToTicks(opts.from);
      const to = opts.to === undefined ? undefined : secondsToTicks(opts.to);
      const { frames } = await renderProject(project, registry, {
        output: opts.output.endsWith("/") ? { kind: "png", dir: output } : { kind: "video", ...encoding({ ...opts, colorSpace: opts.colorSpace ?? colorSpace }), path: output },
        from,
        to,
        cacheDir,
        data: data.get,
        speed,
        onProgress: (f, total) => {
          const stage = f >= total ? "Finishing: adding the sound" : "Exporting";
          if (!started || f >= total) progress(f / total, stage);
          else progress(f / total);
          started = true;
        },
      });
      for (const f of sides) writeFileSync(f.path, f.text);
      return { output, frames, seconds: ticksToSeconds((to ?? projectDuration(project)) - (from ?? 0)) / speed, ...(sides.length ? { files: sides.map((f) => f.path) } : {}) };
    });
  }
}
