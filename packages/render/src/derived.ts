import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Asset, FeatureRegistry, JobAnalyzerDef, Project } from "@beacon/model";

/** Frame indexes and derived data (transcripts), shared by every project and script. */
export const DEFAULT_CACHE_DIR = join(homedir(), "Library/Caches/Beacon");

function hash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Derived asset data for evaluation and queries. Quick analyzers run on first
 * use; job analyzers' results are cached on disk by asset path, fingerprint
 * and analyzer version, so any project using the same file reuses them.
 */
export class DerivedData {
  readonly #memo = new Map<string, unknown>();

  constructor(
    readonly registry: FeatureRegistry,
    readonly cacheDir: string,
    readonly project: () => Project,
  ) {}

  #key(asset: Asset, key: string) {
    return `${asset.path}\0${asset.fingerprint}\0${key}`;
  }

  cacheFile(asset: Asset, def: JobAnalyzerDef): string {
    return join(this.cacheDir, "derived", `${def.id}-v${def.version}-${hash(`${asset.path}\0${asset.fingerprint}`)}.json`);
  }

  get = <T>(assetId: string, key: string): T | undefined => {
    const asset = this.project().assets[assetId];
    return asset && this.#read<T>(asset, key);
  };

  #read<T>(asset: Asset, key: string): T | undefined {
    const id = this.#key(asset, key);
    if (this.#memo.has(id)) return this.#memo.get(id) as T;
    const job = this.registry.jobAnalyzers.get(key);
    if (job) {
      const file = this.cacheFile(asset, job);
      if (!existsSync(file)) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // A damaged cache file is a miss: the analyzer can run again.
        return undefined;
      }
      if (job.revive) {
        const revived = job.revive(value, { cacheDir: this.cacheDir });
        if (revived === undefined) return undefined;
        if (revived !== value) this.store(asset, job, revived);
        value = revived;
      }
      this.#memo.set(id, value);
      return value as T;
    }
    const analyzer = this.registry.analyzers.get(key);
    const value = analyzer?.analyze(asset);
    this.#memo.set(id, value);
    return value as T | undefined;
  }

  has(asset: Asset, key: string): boolean {
    return this.get(asset.id, key) !== undefined;
  }

  /** Deletes a cached result and the files it made; true if there was one. */
  drop(asset: Asset, def: JobAnalyzerDef): boolean {
    const value = this.get(asset.id, def.id);
    this.#memo.delete(this.#key(asset, def.id));
    rmSync(this.cacheFile(asset, def), { force: true });
    if (value !== undefined) def.discard?.(value);
    return value !== undefined;
  }

  /** Forgets every result of an analyzer held in memory (its files are deleted by the caller). */
  dropAll(def: JobAnalyzerDef) {
    for (const id of this.#memo.keys()) if (id.endsWith(`\0${def.id}`)) this.#memo.delete(id);
  }

  /**
   * Gives a copy of a file the results its original has (a transcript), so they aren't made again. Not results
   * that own files (proxies): two entries would share them, and dropping one would delete the other's.
   */
  carry(from: Asset, to: Asset) {
    for (const def of this.registry.jobAnalyzers.values()) {
      if (def.discard) continue;
      const value = this.#read(from, def.id);
      if (value !== undefined && !existsSync(this.cacheFile(to, def))) this.store(to, def, value);
    }
  }

  store(asset: Asset, def: JobAnalyzerDef, value: unknown) {
    const file = this.cacheFile(asset, def);
    mkdirSync(join(this.cacheDir, "derived"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
    this.#memo.set(this.#key(asset, def.id), value);
  }
}
