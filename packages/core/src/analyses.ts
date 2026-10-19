import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { jobSignal } from "@beacon/media";
import { secondsToTicks, walkClips, type AppSettings, type Asset, type JobAnalyzerDef, type ResourceDef } from "@beacon/model";
import type { AppEvent, ImportResult, Job, ResourceInfo } from "./api";
import type { AppConfig } from "./config";
import { download } from "./download";
import { Jobs } from "./jobs";
import type { CoreParts, OpenProject } from "./project";

/** Preview jobs (proxies) built at once: Quietly keeps the fans off, Fast builds two. */
const PREVIEW_JOBS_AT_ONCE = { quiet: 1, fast: 2 } as const;

/** A project's queue of preview jobs, and the media it has prepared or is preparing. */
interface PreviewQueue {
  todo: { asset: Asset; def: { id: string } }[];
  running: Map<string, number>;
  /** Running job id → its asset. */
  jobs: Map<string, string>;
}

/** Bytes in a file, or in a folder and everything under it; 0 if missing. */
async function diskSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return s.size;
    const sizes = await Promise.all((await readdir(path)).map((f) => diskSize(join(path, f))));
    return sizes.reduce((n, b) => n + b, 0);
  } catch {
    return 0;
  }
}

/** Background analyses of media (proxies, waveforms, transcripts), the preview queue, and the resources they need. */
export class Analyses {
  readonly #previewQueues = new WeakMap<OpenProject, PreviewQueue>();

  /** Which analyses may start on their own, beyond what the settings allow (tests leave transcripts out). */
  #automatic: (analyzer: string, asset: Asset) => boolean = () => true;

  constructor(
    readonly parts: CoreParts,
    readonly jobs: Jobs,
    readonly config: AppConfig,
    readonly watchApp: (fn: (e: AppEvent) => void) => () => void,
  ) {
    // Settings › General chooses which media get proxies on their own: projects shown now follow at once.
    watchApp((e) => e.kind === "settings" && this.#followAutomatic());
  }

  /** Sets which analyses (e.g. proxies) may start on their own; projects shown now follow at once. */
  setAutomatic(fn: (analyzer: string, asset: Asset) => boolean) {
    this.#automatic = fn;
    this.#followAutomatic();
  }

  #followAutomatic() {
    for (const p of this.parts.projects()) if (p.view) this.previewJobs(p);
  }

  /**
   * Whether an analysis starts on its own (on import, when shown or when a preference changes) rather than only
   * when asked: proxies only for the kinds of media the settings name.
   */
  #starts(settings: AppSettings, analyzer: string, asset: Asset): boolean {
    if (analyzer === "proxy" && !(asset.kind === "recording" ? settings.autoProxy.recording : settings.autoProxy.video)) return false;
    return this.#automatic(analyzer, asset);
  }

  /**
   * Proxies and the like, a few at a time (each ffmpeg uses every core; a project of 28 media started them
   * all at once and the fans ran), media near the playhead first. Later ones start only while the project
   * is still shown.
   */
  previewJobs(p: OpenProject) {
    const { registry } = this.parts;
    const doc = p.store.doc;
    const at = secondsToTicks(p.session.state.playhead);
    const distance = new Map<string, number>();
    for (const { clip, offset } of walkClips(doc.tracks, registry)) {
      if (!clip.assetId) continue;
      const [a, b] = [offset + clip.start, offset + clip.start + clip.duration];
      const d = at < a ? a - at : at > b ? at - b : 0;
      distance.set(clip.assetId, Math.min(d, distance.get(clip.assetId) ?? Infinity));
    }
    const settings = this.config.settings();
    const wanted = Object.values(doc.assets)
      .flatMap((asset) =>
        [...registry.jobAnalyzers.values()].filter((def) => def.when === "preview" && def.applies(asset) && !p.data.has(asset, def.id) && this.#starts(settings, def.id, asset) && existsSync(asset.path)).map((def) => ({ asset, def })),
      )
      .sort((x, y) => (distance.get(x.asset.id) ?? Infinity) - (distance.get(y.asset.id) ?? Infinity));
    // One queue per project: asked again (media imported), it is refilled rather than doubled.
    const queue = this.#previewQueues.get(p);
    if (queue) {
      queue.todo.splice(0, queue.todo.length, ...wanted);
      return void this.#preparing(p, queue);
    }
    if (!wanted.length) return;
    const state: PreviewQueue = { todo: wanted, running: new Map(), jobs: new Map() };
    const todo = state.todo;
    this.#previewQueues.set(p, state);
    const unwatch = this.watchApp((e) => {
      if (e.kind === "job" && e.job.state === "running" && state.jobs.has(e.job.id)) this.#preparing(p, state);
    });
    let workers = 0;
    const next = (): Promise<void> | undefined => {
      const item = todo.shift();
      if (!item || this.parts.find(p.path) !== p || !p.view) {
        if (--workers === 0) {
          this.#previewQueues.delete(p);
          unwatch();
          this.parts.emit(p, { kind: "preparing", assets: {} });
        }
        return;
      }
      let job: Job;
      try {
        job = this.analyze(p, item.def.id, item.asset.id);
      } catch {
        return next();
      }
      const id = item.asset.id;
      state.running.set(id, (state.running.get(id) ?? 0) + 1);
      state.jobs.set(job.id, id);
      this.#preparing(p, state);
      const finished = () => {
        state.running.set(id, state.running.get(id)! - 1);
        state.jobs.delete(job.id);
        this.#preparing(p, state);
        return next();
      };
      return job.done.then(() => {
        if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
        return finished();
      }, finished);
    };
    // Counted before each starts: a worker that finds nothing left stops at once, and must not be restarted here.
    const started = Math.min(PREVIEW_JOBS_AT_ONCE[settings.proxyMode], todo.length);
    workers = started;
    for (let i = 0; i < started; i++) void next();
  }

  /** Tells the window each medium's progress, for those with a job queued or running. */
  #preparing(p: OpenProject, q: PreviewQueue) {
    const left = new Set([...q.todo.map((i) => i.asset.id), ...[...q.running].filter(([, n]) => n > 0).map(([id]) => id)]);
    // A medium's progress is its jobs' average, a queued one counting as none.
    const assets: Record<string, number> = {};
    for (const id of left) {
      const jobs = [...q.jobs].filter(([, a]) => a === id).map(([j]) => this.jobs.info(j).progress);
      const queued = q.todo.filter((i) => i.asset.id === id).length;
      assets[id] = jobs.reduce((a, b) => a + b, 0) / Math.max(1, jobs.length + queued);
    }
    this.parts.emit(p, { kind: "preparing", assets });
  }

  /** After media is added: the app's view makes its proxies and waveforms, and its analyses (transcripts) start. */
  imported(p: OpenProject, result: ImportResult): ImportResult {
    if (p.view) this.previewJobs(p);
    const { jobs, needs } = this.importAnalyses(p, result.assets);
    result.jobs.push(...jobs);
    return needs ? { ...result, needs } : result;
  }

  /**
   * Starts the analyses new media gets (transcripts), except those waiting for a resource that isn't downloaded:
   * those are reported, to the caller and as a `needs` event, and start when it arrives.
   */
  importAnalyses(p: OpenProject, assets: string[]): { jobs: string[]; needs?: string[] } {
    const { registry } = this.parts;
    const jobs: string[] = [];
    const needs = new Set<string>();
    const settings = this.config.settings();
    for (const id of assets) {
      for (const def of registry.jobAnalyzers.values()) {
        const a = p.store.doc.assets[id]!;
        if ((def.when ?? "import") !== "import" || !def.applies(a) || p.data.has(a, def.id) || !this.#starts(settings, def.id, a)) continue;
        const need = this.#needsOf(def);
        if (need && !this.#resourceReady(need)) needs.add(need);
        else if (existsSync(a.path)) jobs.push(this.analyze(p, def.id, id).id);
      }
    }
    for (const id of needs) this.parts.emit(p, { kind: "needs", resource: this.#resourceInfo(registry.resources.get(id)!) });
    return needs.size ? { jobs, needs: [...needs] } : { jobs };
  }

  analyze(p: OpenProject, key: string, assetId: string): Job {
    const def = this.#jobAnalyzer(key);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    if (!existsSync(asset.path)) throw new Error(`${basename(asset.path)} is missing: it was moved, renamed or deleted (Locate… in the Media Bin's menu finds it)`);
    const pref = this.config.pref;
    const variant = def.variant?.(pref);
    const subject = this.#subject(def, asset, variant);
    const running = this.jobs.running(subject);
    if (running) return { id: running.info.id, done: running.done };
    const need = this.#needsOf(def);
    if (need && !this.#resourceReady(need)) {
      const r = this.parts.registry.resources.get(need)!;
      throw new Error(`${key} needs the ${r.title} (${Math.round(r.bytes / 1e6)} MB), which isn't downloaded; download it (fetchResource "${r.id}") once the user agrees`);
    }
    return this.parts.startJob(
      p,
      key,
      `${key} ${asset.path}`,
      async (progress) => {
        const value = await def.analyze(asset, progress, {
          cacheDir: this.parts.cacheDir,
          // How background analyses run (Settings › General): quietly, at macOS background priority, unless "fast".
          quiet: this.config.settings().proxyMode === "quiet",
          resource: (id) => this.#resourcePath(this.parts.registry.resources.get(id)!),
          pref,
          secret: (id) => this.config.secrets.get(id),
        });
        // Made for the variant it started under (a transcriber since changed): stored there it would be taken for the new one's.
        if (def.variant?.(pref) !== variant) throw new Error(`${key} was for a setting since changed`);
        jobSignal()?.throwIfAborted();
        p.data.store(asset, def, value);
        this.parts.emit(p, { kind: "derived", asset: assetId, key, present: true });
        return { asset: assetId };
      },
      subject,
      assetId,
    );
  }

  async forget(p: OpenProject, key: string, assetId: string): Promise<boolean> {
    const def = this.#jobAnalyzer(key);
    const asset = p.store.doc.assets[assetId];
    if (!asset) throw new Error(`no asset "${assetId}"`);
    const running = this.jobs.running(this.#subject(def, asset));
    if (running) {
      Jobs.stop(running);
      await running.done.catch(() => {});
    }
    const had = p.data.drop(asset, def);
    this.parts.emit(p, { kind: "derived", asset: assetId, key, present: false });
    if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
    return had;
  }

  /** What a job is for, so a second request joins the running one: the analysis, the asset as it is, and the variant (the transcriber). */
  #subject(def: JobAnalyzerDef, asset: Asset, variant = def.variant?.(this.config.pref)): string {
    return `${def.id}:${asset.path}\0${asset.fingerprint}${variant ? `\0${variant}` : ""}`;
  }

  #jobAnalyzer(key: string) {
    const { registry } = this.parts;
    const def = registry.jobAnalyzers.get(key);
    if (!def) throw new Error(`no background analyzer "${key}"; there are: ${[...registry.jobAnalyzers.keys()].join(", ")}`);
    return def;
  }

  /** The analyzer's cached results of every version, and its folder. */
  #analysisFiles(key: string): string[] {
    const def = this.#jobAnalyzer(key);
    const derived = join(this.parts.cacheDir, "derived");
    const results = existsSync(derived) ? readdirSync(derived).filter((f) => f.startsWith(`${key}-v`) && /^\d+(-[a-z0-9]+)?-[0-9a-f]{16}\.json$/.test(f.slice(key.length + 2))).map((f) => join(derived, f)) : [];
    return def.folder ? [...results, join(this.parts.cacheDir, def.folder)] : results;
  }

  async analysisSize(key: string): Promise<number> {
    const sizes = await Promise.all(this.#analysisFiles(key).map(diskSize));
    return sizes.reduce((n, b) => n + b, 0);
  }

  async forgetAll(key: string): Promise<number> {
    const def = this.#jobAnalyzer(key);
    for (const p of this.parts.projects()) {
      const q = this.#previewQueues.get(p);
      q?.todo.splice(0, q.todo.length, ...q.todo.filter((i) => i.def.id !== key));
    }
    const running = this.jobs.runningOf(undefined, (j) => j.info.kind === key);
    for (const j of running) Jobs.stop(j);
    await Promise.all(running.map((j) => j.done.catch(() => {})));
    const before = await this.analysisSize(key);
    for (const file of this.#analysisFiles(key)) {
      if (!file.endsWith(".json")) continue;
      // Without a folder, the result names the files it made.
      if (!def.folder) {
        try {
          def.discard?.(JSON.parse(readFileSync(file, "utf8")));
        } catch {}
      }
      rmSync(file, { force: true });
    }
    if (def.folder) rmSync(join(this.parts.cacheDir, def.folder), { recursive: true, force: true });
    for (const p of this.parts.projects()) {
      p.data.dropAll(def);
      for (const asset of Object.values(p.store.doc.assets)) if (def.applies(asset)) this.parts.emit(p, { kind: "derived", asset: asset.id, key, present: false });
      if (p.view && !p.view.playing) p.view.show(p.session.state.playhead);
    }
    return before - (await this.analysisSize(key));
  }

  /** A preference changed: what the old choice was making (another transcriber's transcripts) stops, and the new one's start. */
  preferenceChanged() {
    const decided = new Set([...this.parts.registry.jobAnalyzers.values()].filter((d) => d.variant).map((d) => d.id));
    this.jobs.cancelOf(undefined, (j) => decided.has(j.info.kind));
    for (const p of this.parts.projects()) this.importAnalyses(p, Object.keys(p.store.doc.assets));
  }

  #resourcePath(def: ResourceDef): string {
    return join(this.parts.cacheDir, def.folder, def.file);
  }

  /** Its hash was checked when it was downloaded; after that, being there is enough. */
  #resourceReady(id: string): boolean {
    return existsSync(this.#resourcePath(this.parts.registry.resources.get(id)!));
  }

  #resourceInfo(def: ResourceDef): ResourceInfo {
    const job = this.jobs.running(`resource:${def.id}`);
    return { id: def.id, title: def.title, description: def.description, bytes: def.bytes, present: this.#resourceReady(def.id), ...(job ? { job: job.info.id } : {}) };
  }

  #needsOf(def: JobAnalyzerDef): string | undefined {
    return typeof def.needs === "function" ? def.needs(this.config.pref) : def.needs;
  }

  resources(): ResourceInfo[] {
    return [...this.parts.registry.resources.values()].map((def) => this.#resourceInfo(def));
  }

  fetchResource(id: string): Job {
    const { registry } = this.parts;
    const def = registry.resources.get(id);
    if (!def) throw new Error(`no resource "${id}"; there are: ${[...registry.resources.keys()].join(", ")}`);
    const subject = `resource:${id}`;
    const running = this.jobs.running(subject);
    if (running) return { id: running.info.id, done: running.done };
    const path = this.#resourcePath(def);
    return this.parts.startJob(undefined, "resource", `Download ${def.title}`, async (progress) => {
      if (!this.#resourceReady(id)) await download(def, path, progress);
      this.#resumeWaiting(id);
      return { path };
    }, subject);
  }

  /** A resource arrived: the analyses that were waiting for it start, in every open project. */
  #resumeWaiting(resource: string) {
    for (const p of this.parts.projects()) {
      for (const def of this.parts.registry.jobAnalyzers.values()) {
        if (this.#needsOf(def) !== resource || (def.when ?? "import") !== "import") continue;
        for (const a of Object.values(p.store.doc.assets)) if (def.applies(a) && !p.data.has(a, def.id) && existsSync(a.path)) this.analyze(p, def.id, a.id);
      }
    }
  }
}
