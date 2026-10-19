import { applyPatches, current, enablePatches, freeze, isDraft, produceWithPatches, type Objectish, type Patch } from "immer";
import type { CommandContext } from "./feature";
import type { FeatureRegistry } from "./registry";
import { formatIssues, type Project } from "./schema";

enablePatches();

export type { Patch };

export class CommandError extends Error {
  constructor(readonly command: string, message: string) {
    super(`${command}: ${message}`);
    this.name = "CommandError";
  }
}

export interface CommandResult {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Return values of each command run, in order. */
  results: unknown[];
  /** One readable line per patch, for agents and logs. */
  diff: string[];
  dryRun: boolean;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Changes with the same key in a row are one undo step (a drag). */
  coalesce?: string;
}

export interface Tx {
  run<R = unknown>(command: string, args?: unknown): R;
}

export interface StoreEvent {
  kind: "apply" | "undo" | "redo";
  label: string;
  patches: Patch[];
  doc: Project;
}

export interface StoreOptions {
  newId?: (prefix: string) => string;
  historyLimit?: number;
  data?: <T>(assetId: string, key: string) => T | undefined;
}

export function randomId(prefix: string, hexDigits = 12): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, hexDigits)}`;
}

/**
 * The project document plus its only mutation path: commands, run inside a
 * transaction, validated, recorded for undo and broadcast as patches.
 * Documents are frozen; every change produces a new one.
 */
export class ProjectStore {
  #doc: Project;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #listeners = new Set<(e: StoreEvent) => void>();
  readonly #ctx: CommandContext;
  readonly #historyLimit: number;

  constructor(readonly registry: FeatureRegistry, doc: Project, opts: StoreOptions = {}) {
    registry.validate(doc);
    this.#doc = freeze(structuredClone(doc), true);
    this.#ctx = { registry, newId: opts.newId ?? randomId, data: opts.data ?? (() => undefined) };
    this.#historyLimit = opts.historyLimit ?? 500;
  }

  get doc(): Project {
    return this.#doc;
  }

  run<R = unknown>(command: string, args?: unknown, opts: { dryRun?: boolean; label?: string; coalesce?: string } = {}): CommandResult & { result: R } {
    const label = opts.label ?? command;
    const result = this.transaction(label, (tx) => void tx.run(command, args), opts);
    return { ...result, result: result.results[0] as R };
  }

  /**
   * Runs several commands as one undo step. If any command or the final
   * validation throws, nothing is applied.
   */
  transaction(label: string, fn: (tx: Tx) => void, opts: { dryRun?: boolean; coalesce?: string } = {}): CommandResult {
    const results: unknown[] = [];
    const [next, patches, inverse] = produceWithPatches(this.#doc, (draft) => {
      fn({
        run: <R>(command: string, args?: unknown): R => {
          const def = this.registry.command(command);
          const parsed = def.args.safeParse(args ?? {});
          if (!parsed.success) {
            throw new CommandError(command, formatIssues(parsed.error));
          }
          const r = def.apply(draft, parsed.data, this.#ctx) as R;
          results.push(r);
          return r;
        },
      });
      if (results.length) for (const f of this.registry.features.values()) f.normalize?.(draft, this.#ctx);
      // Drafts are revoked when the producer returns.
      for (const [i, r] of results.entries()) if (isDraft(r)) results[i] = current(r);
    });
    if (patches.length) this.registry.validateChanged(next, patches);
    const dryRun = opts.dryRun ?? false;
    const result: CommandResult = { label, patches, inverse, results, diff: describePatches(this.#doc, patches), dryRun };
    if (dryRun || !patches.length) return result;

    this.#doc = next;
    const last = this.#undo.at(-1);
    if (opts.coalesce && last?.coalesce === opts.coalesce && !this.#redo.length) {
      last.patches = [...last.patches, ...patches];
      last.inverse = [...inverse, ...last.inverse];
    } else this.#undo.push({ label, patches, inverse, ...(opts.coalesce ? { coalesce: opts.coalesce } : {}) });
    if (this.#undo.length > this.#historyLimit) this.#undo.shift();
    this.#redo = [];
    this.#emit({ kind: "apply", label, patches, doc: next });
    return result;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Labels, oldest first. */
  get history(): { undo: string[]; redo: string[] } {
    return { undo: this.#undo.map((e) => e.label), redo: this.#redo.map((e) => e.label).reverse() };
  }

  undo(): HistoryEntry | undefined {
    const entry = this.#undo.pop();
    if (!entry) return undefined;
    this.#doc = applyPatches(this.#doc, entry.inverse);
    this.#redo.push(entry);
    this.#emit({ kind: "undo", label: entry.label, patches: entry.inverse, doc: this.#doc });
    return entry;
  }

  redo(): HistoryEntry | undefined {
    const entry = this.#redo.pop();
    if (!entry) return undefined;
    this.#doc = applyPatches(this.#doc, entry.patches);
    this.#undo.push(entry);
    this.#emit({ kind: "redo", label: entry.label, patches: entry.patches, doc: this.#doc });
    return entry;
  }

  subscribe(listener: (e: StoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // The change is already committed, so a failing listener must not look like a failed command.
  #emit(e: StoreEvent) {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

function valueAt(doc: Objectish, path: (string | number)[]): unknown {
  let v: unknown = doc;
  for (const key of path) v = (v as Record<string | number, unknown> | undefined)?.[key];
  return v;
}

function brief(value: unknown): string {
  const s = JSON.stringify(value) ?? "undefined";
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Each patch read against the document as it stands just before that patch. */
function describePatches(before: Project, patches: Patch[]): string[] {
  let doc = before;
  return patches.map((p) => {
    const path = p.path.join("/");
    const was = valueAt(doc, p.path);
    doc = applyPatches(doc, [p]);
    if (p.op === "add") return `add ${path}: ${brief(p.value)}`;
    if (p.op === "remove") return `remove ${path} (was ${brief(was)})`;
    return `set ${path}: ${brief(was)} -> ${brief(p.value)}`;
  });
}
