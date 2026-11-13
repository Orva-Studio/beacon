import { applyPatches, current, enablePatches, freeze, isDraft, produceWithPatches, type Objectish, type Patch } from "immer";
import type { CommandContext, Memory } from "./feature";
import type { FeatureRegistry } from "./registry";
import { formatIssues, type Clip, type Project } from "./schema";
import { ticksToSeconds } from "./ticks";

enablePatches();

export type { Patch };

/** A document with a command's patches applied (its dry run's), as a copy: the original is untouched. */
export const withPatches = (doc: Project, patches: Patch[]): Project => applyPatches(doc, patches);

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
  /** An action's word to the user, done (its plan's `note`). */
  note?: string;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Changes with the same key in a row are one undo step (a drag). */
  coalesce?: string;
  /** Who made it: an agent, by the name its connection gives; none for the user. */
  author?: string;
  /**
   * The document before and after it: undone or redone in turn, the store goes back to exactly these; out of turn,
   * what it changed is put back as they have it.
   */
  before: Project;
  after: Project;
  /** Undone or redone out of turn once: its patches no longer fit, so it always is from then on. */
  outOfTurn?: boolean;
  /** When it was last applied, and undone, in the store's count of changes. */
  seq: number;
  undoneSeq?: number;
}

/** Whose steps an undo or redo takes: the user's (no author), one agent's, or every agent's. */
export type Who = (author: string | undefined) => boolean;
export const theUser: Who = (a) => a === undefined;
export const anyAgent: Who = (a) => a !== undefined;
export const authorIs = (author: string | undefined): Who => (a) => a === author;

/** An undo or redo refused: a later step of someone else's changed the same thing. */
export class UndoBlocked extends Error {
  constructor(message: string, readonly by: string | undefined) {
    super(message);
    this.name = "UndoBlocked";
  }
}

/** A step begun (`ProjectStore.begin`): the changes made since, and the document before them. */
interface Open {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  before: Project;
  author?: string;
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
  memory?: Memory;
  /** Who is making the change now (an agent's name), when a command doesn't say; none is the user. */
  author?: () => string | undefined;
  /** An author as people read it ("Claude Code"; none, "you"), for refusals. */
  authorName?: (author: string | undefined) => string;
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
  #seq = 0;
  #open: Open | undefined;
  #listeners = new Set<(e: StoreEvent) => void>();
  readonly #ctx: CommandContext;
  readonly #historyLimit: number;
  readonly #author: () => string | undefined;
  readonly #name: (author: string | undefined) => string;

  constructor(readonly registry: FeatureRegistry, doc: Project, opts: StoreOptions = {}) {
    registry.validate(doc);
    this.#doc = freeze(structuredClone(doc), true);
    this.#ctx = { registry, newId: opts.newId ?? randomId, data: opts.data ?? (() => undefined), ...(opts.memory ? { memory: opts.memory } : {}) };
    this.#historyLimit = opts.historyLimit ?? 500;
    this.#author = opts.author ?? (() => undefined);
    this.#name = opts.authorName ?? ((a) => a ?? "you");
  }

  get doc(): Project {
    return this.#doc;
  }

  run<R = unknown>(command: string, args?: unknown, opts: { dryRun?: boolean; label?: string; coalesce?: string; author?: string } = {}): CommandResult & { result: R } {
    const label = opts.label ?? command;
    const result = this.transaction(label, (tx) => void tx.run(command, args), opts);
    return { ...result, result: result.results[0] as R };
  }

  /**
   * Runs several commands as one undo step. If any command or the final
   * validation throws, nothing is applied.
   */
  transaction(label: string, fn: (tx: Tx) => void, opts: { dryRun?: boolean; coalesce?: string; author?: string } = {}): CommandResult {
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
    const result: CommandResult = { label, patches, inverse, results, diff: describePatches(this.#doc, next, patches), dryRun };
    if (dryRun || !patches.length) return result;

    const before = this.#doc;
    this.#doc = next;
    if (this.#open) {
      this.#open.patches.push(...patches);
      this.#open.inverse.unshift(...inverse);
    } else {
      const author = opts.author ?? this.#author();
      const last = this.#undo.at(-1);
      // A drag is one step while nothing else came between its changes.
      if (opts.coalesce && last?.coalesce === opts.coalesce && last.author === author && !last.outOfTurn && last.after === before && !this.#redo.some((e) => authorIs(author)(e.author))) {
        last.patches = [...last.patches, ...patches];
        last.inverse = [...inverse, ...last.inverse];
        last.after = next;
        // Later than anything undone in between: redo's check for someone's newer change goes by it.
        last.seq = ++this.#seq;
      } else this.#push({ label, patches, inverse, ...(opts.coalesce ? { coalesce: opts.coalesce } : {}), ...(author !== undefined ? { author } : {}), before });
    }
    this.#emit({ kind: "apply", label, patches, doc: next });
    return result;
  }

  /**
   * Starts one undo step that the changes until `commit` make together (a script, a transaction of actions): each is
   * applied and told as it is made, and `abort` takes them all back.
   */
  begin(label: string, opts: { author?: string } = {}): void {
    if (this.#open) throw new Error(`"${this.#open.label}" is still being made`);
    const author = opts.author ?? this.#author();
    this.#open = { label, patches: [], inverse: [], before: this.#doc, ...(author !== undefined ? { author } : {}) };
  }

  /** The step begun, made one undo step; its result as a transaction's (no patches: nothing changed). */
  commit(): CommandResult {
    const open = this.#take();
    const result: CommandResult = { label: open.label, patches: open.patches, inverse: open.inverse, results: [], diff: [], dryRun: false };
    if (!open.patches.length) return result;
    this.#push({ label: open.label, patches: open.patches, inverse: open.inverse, before: open.before, ...(open.author !== undefined ? { author: open.author } : {}) });
    return { ...result, diff: describePatches(open.before, this.#doc, open.patches) };
  }

  /** The step begun, taken back as if never made; its result says what it would have changed. */
  abort(): CommandResult {
    const open = this.#take();
    const result: CommandResult = { label: open.label, patches: open.patches, inverse: open.inverse, results: [], diff: [], dryRun: true };
    if (!open.patches.length) return result;
    const after = this.#doc;
    this.#doc = open.before;
    this.#emit({ kind: "undo", label: open.label, patches: open.inverse, doc: this.#doc });
    return { ...result, diff: describePatches(open.before, after, open.patches) };
  }

  #push(entry: Omit<HistoryEntry, "after" | "seq">) {
    this.#undo.push({ ...entry, after: this.#doc, seq: ++this.#seq });
    if (this.#undo.length > this.#historyLimit) this.#undo.shift();
    // Only the author's own new change ends what they can redo; someone else's leaves it (the user, 2026-11-05).
    this.#redo = this.#redo.filter((e) => !authorIs(entry.author)(e.author));
  }

  #take(): Open {
    const open = this.#open;
    if (!open) throw new Error("no step begun");
    this.#open = undefined;
    return open;
  }

  /** Whether the user (or `who`) has a step to undo. */
  canUndoBy(who: Who = theUser): boolean {
    return this.#undo.some((e) => who(e.author));
  }

  canRedoBy(who: Who = theUser): boolean {
    return this.#redo.some((e) => who(e.author));
  }

  get canUndo(): boolean {
    return this.canUndoBy();
  }

  get canRedo(): boolean {
    return this.canRedoBy();
  }

  /** Labels, oldest first. */
  get history(): { undo: string[]; redo: string[] } {
    return { undo: this.#undo.map((e) => e.label), redo: this.#redo.map((e) => e.label).reverse() };
  }

  /** Each step's label and who made it (none: the user), oldest first; redo's in the order it would redo them, last first. */
  get steps(): { undo: { label: string; author?: string }[]; redo: { label: string; author?: string }[] } {
    const step = (e: HistoryEntry) => ({ label: e.label, ...(e.author !== undefined ? { author: e.author } : {}) });
    return { undo: this.#undo.map(step), redo: this.#redo.map(step).reverse() };
  }

  /**
   * Undoes the newest step of `who` (the user by default), even with someone else's steps after it: then by the
   * things it changed (each clip, track, effect… put back as it was before it), refused when a later step of someone
   * else's changed one of them.
   */
  undo(who: Who = theUser): HistoryEntry | undefined {
    if (this.#open) throw new Error(`can't undo while "${this.#open.label}" is being made`);
    const i = this.#undo.findLastIndex((e) => who(e.author));
    if (i < 0) return undefined;
    const entry = this.#undo[i]!;
    let patches: Patch[];
    if (!entry.outOfTurn && entry.after === this.#doc) {
      patches = entry.inverse;
      this.#doc = entry.before;
    } else patches = this.#putBack(entry, entry.before, this.#undo.slice(i + 1));
    this.#undo.splice(i, 1);
    entry.undoneSeq = ++this.#seq;
    this.#redo.push(entry);
    this.#emit({ kind: "undo", label: entry.label, patches, doc: this.#doc });
    return entry;
  }

  redo(who: Who = theUser): HistoryEntry | undefined {
    if (this.#open) throw new Error(`can't redo while "${this.#open.label}" is being made`);
    const i = this.#redo.findLastIndex((e) => who(e.author));
    if (i < 0) return undefined;
    const entry = this.#redo[i]!;
    let patches: Patch[];
    if (!entry.outOfTurn && entry.before === this.#doc) {
      patches = entry.patches;
      this.#doc = entry.after;
    } else patches = this.#putBack(entry, entry.after, this.#undo.filter((e) => e.seq > (entry.undoneSeq ?? 0)));
    this.#redo.splice(i, 1);
    entry.seq = ++this.#seq;
    this.#undo.push(entry);
    this.#emit({ kind: "redo", label: entry.label, patches, doc: this.#doc });
    return entry;
  }

  /**
   * Out of turn: what `entry` changed set back to how `source` has it, unless one of `later` (someone else's steps
   * since) changed the same thing. Its patches no longer fit the document after this, so it is undone and redone
   * this way from then on.
   */
  #putBack(entry: HistoryEntry, source: Project, later: HistoryEntry[]): Patch[] {
    const things = touched(entry.before, entry.patches);
    for (const l of later) {
      if (l.author === entry.author) continue;
      const clash = touched(l.before, l.patches).find((t) => things.some((u) => clashes(t, u)));
      if (clash) {
        const who = this.#name(l.author);
        const own = l.author === undefined ? "your" : `${who}'s`;
        throw new UndoBlocked(`${capitalise(who)} changed ${clash.what} since: undo ${own} change first`, l.author);
      }
    }
    const [next, patches] = produceWithPatches(this.#doc, (draft) => {
      for (const t of outermost(things)) putThing(draft as unknown as Objectish, t.path, thingIn(source as unknown as Objectish, t.path), source as unknown as Objectish);
      for (const f of this.registry.features.values()) f.normalize?.(draft, this.#ctx);
    });
    if (patches.length) this.registry.validateChanged(next, patches);
    this.#doc = next;
    entry.outOfTurn = true;
    return patches;
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

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A place in the document that stays put as others change it: array items with an `id` named by it, not their index. */
type Segment = string | number | { id: string };

/**
 * A thing a step changed: an item with an id (a clip, track, effect…) added or removed, or one field of it (a
 * clip's start, its props), or, outside any item, the value at a path; `owner` is the item it belongs to.
 */
interface Thing {
  path: Segment[];
  owner: Segment[];
  what: string;
}

const keyOf = (path: Segment[]) => JSON.stringify(path);
const within = (a: Segment[], b: Segment[]) => a.length <= b.length && a.every((s, i) => keyOf([s]) === keyOf([b[i]!]));
/** The same item, or one inside the other (a track removed, a clip on it changed): the user's "the same clip". */
const clashes = (a: Thing, b: Thing) => keyOf(a.owner) === keyOf(b.owner) || within(a.path, b.path) || within(b.path, a.path);
/** Things inside another of the set go with it. */
const outermost = (things: Thing[]) => things.filter((t) => !things.some((u) => u !== t && u.path.length < t.path.length && within(u.path, t.path)));

const hasId = (v: unknown): v is { id: string } => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";

/**
 * What each patch changed, read against the document as it stands just before that patch. An item put in, taken
 * out or set by its index in a list of items with ids (how Immer writes an insert or removal: every later item
 * shifted) is read from the whole list before and after the step instead, so the item inserted is found and its
 * shifted neighbours aren't taken as changed.
 */
function touched(before: Project, patches: Patch[]): Thing[] {
  const things = new Map<string, Thing>();
  const lists = new Map<string, Segment[]>();
  let doc = before as unknown as Objectish;
  for (const p of patches) {
    const list = byIndex(doc, p);
    if (list) lists.set(keyOf(list), list);
    else for (const t of listed(doc, p) ?? [thingOf(doc, p)]) things.set(keyOf(t.path), t);
    doc = applyPatches(doc, [p]);
  }
  for (const list of lists.values()) for (const t of listChanges(before as unknown as Objectish, doc, list)) things.set(keyOf(t.path), t);
  return [...things.values()];
}

/** The list (by ids) a patch sets an item of by its index, or its length; undefined for any other patch. */
function byIndex(doc: Objectish, p: Patch): Segment[] | undefined {
  const last = p.path.at(-1);
  if (typeof last !== "number" && last !== "length") return undefined;
  const parent = valueAt(doc, p.path.slice(0, -1));
  if (!Array.isArray(parent) || !parent.every(hasId) || (p.op !== "remove" && last !== "length" && !hasId(p.value))) return undefined;
  return segmentsOf(doc, p.path.slice(0, -1));
}

/** A list's items added, removed or changed between two documents, by id; the whole list when its order changed. */
function listChanges(before: Objectish, after: Objectish, list: Segment[]): Thing[] {
  const items = (doc: Objectish) => new Map(((thingIn(doc, list) ?? []) as { id: string }[]).map((x) => [x.id, x]));
  const was = items(before);
  const now = items(after);
  const kind = String([...list].reverse().find((s) => typeof s === "string") ?? "");
  const what = kind === "clips" ? "this clip" : kind === "tracks" ? "this track" : `this ${kind.replace(/s$/, "")}`;
  const kept = (m: Map<string, unknown>, other: Map<string, unknown>) => [...m.keys()].filter((id) => other.has(id)).join();
  if (kept(was, now) !== kept(now, was)) return [{ path: list, owner: list, what: "the order" }];
  return [...new Set([...was.keys(), ...now.keys()])]
    .filter((id) => was.get(id) !== now.get(id) && JSON.stringify(was.get(id)) !== JSON.stringify(now.get(id)))
    .map((id) => ({ path: [...list, { id }], owner: [...list, { id }], what }));
}

/**
 * A list of items set whole (a command filtering a track's clips): the items it added, removed or changed, by id, so
 * an edit to one clip doesn't seem to touch its neighbours; the whole list when only their order changed.
 */
function listed(doc: Objectish, p: Patch): Thing[] | undefined {
  if (p.op === "remove" || !Array.isArray(p.value) || !p.value.every(hasId)) return undefined;
  const old = valueAt(doc, p.path);
  if (old !== undefined && !(Array.isArray(old) && old.every(hasId))) return undefined;
  const base = segmentsOf(doc, p.path);
  if (!base) return undefined;
  const was = new Map(((old ?? []) as { id: string }[]).map((x) => [x.id, x]));
  const now = new Map((p.value as { id: string }[]).map((x) => [x.id, x]));
  const kind = String(p.path.at(-1) ?? "");
  const what = kind === "clips" ? "this clip" : kind === "tracks" ? "this track" : `this ${kind.replace(/s$/, "")}`;
  const item = (id: string): Thing => ({ path: [...base, { id }], owner: [...base, { id }], what });
  const ids = [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id));
  const kept = (m: Map<string, unknown>, other: Map<string, unknown>) => [...m.keys()].filter((id) => other.has(id)).join();
  if (kept(was, now) !== kept(now, was)) return [{ path: base, owner: base, what: "the order" }];
  return ids.map(item);
}

/** A path with its items named by id; undefined through a list whose items have none. */
function segmentsOf(doc: Objectish, path: (string | number)[]): Segment[] | undefined {
  const out: Segment[] = [];
  let v: unknown = doc;
  for (const key of path) {
    if (Array.isArray(v) && typeof key === "number") {
      if (!hasId(v[key])) return undefined;
      out.push({ id: v[key].id });
    } else out.push(key);
    v = (v as Record<string | number, unknown> | undefined)?.[key];
  }
  return out;
}

function thingOf(doc: Objectish, p: Patch): Thing {
  const path: Segment[] = [];
  let item = -1;
  let v: unknown = doc;
  let kind = "";
  for (const [i, key] of p.path.entries()) {
    if (Array.isArray(v) && typeof key === "number") {
      const el = i === p.path.length - 1 && p.op === "add" ? p.value : v[key];
      if (!hasId(el)) break;
      path.push({ id: el.id });
      item = path.length - 1;
      kind = String(p.path[i - 1] ?? "");
      v = el;
      continue;
    }
    path.push(key);
    v = (v as Record<string | number, unknown> | undefined)?.[key];
  }
  // Inside an item, one field of it is the thing (a clip's start, its whole props).
  if (item >= 0) path.splice(item + 2);
  const owner = item >= 0 ? path.slice(0, item + 1) : path;
  const what = kind === "clips" ? "this clip" : kind === "tracks" ? "this track" : kind ? `this ${kind.replace(/s$/, "")}` : "this";
  return { path, owner, what };
}

/** Where a path's items are now (by id), or undefined when one of them is gone. */
function resolve(doc: Objectish, path: Segment[]): (string | number)[] | undefined {
  const out: (string | number)[] = [];
  let v: unknown = doc;
  for (const s of path) {
    if (typeof s === "object") {
      if (!Array.isArray(v)) return undefined;
      const i = v.findIndex((x) => hasId(x) && x.id === s.id);
      if (i < 0) return undefined;
      out.push(i);
      v = v[i];
    } else {
      out.push(s);
      v = (v as Record<string | number, unknown> | undefined)?.[s];
    }
  }
  return out;
}

/** What is at `path` in `doc`; undefined when it (or an item on the way) isn't there. */
function thingIn(doc: Objectish, path: Segment[]): unknown {
  const at = resolve(doc, path);
  return at && valueAt(doc, at);
}

/** The thing at `path` set to `value` (gone when undefined); an item put back among its old neighbours. */
function putThing(draft: Objectish, path: Segment[], value: unknown, source: Objectish) {
  const parentPath = resolve(draft, path.slice(0, -1));
  if (!parentPath) throw new UndoBlocked("what it changed isn't there any more", undefined);
  const parent = valueAt(draft, parentPath) as Record<string | number, unknown> | unknown[];
  const last = path.at(-1)!;
  if (typeof last !== "object") {
    if (value === undefined) delete (parent as Record<string | number, unknown>)[last];
    else (parent as Record<string | number, unknown>)[last] = value;
    return;
  }
  if (!Array.isArray(parent)) throw new UndoBlocked("what it changed isn't there any more", undefined);
  const at = parent.findIndex((x) => hasId(x) && x.id === last.id);
  if (value === undefined) {
    if (at >= 0) parent.splice(at, 1);
  } else if (at >= 0) parent[at] = value;
  else {
    const was = (thingIn(source, path.slice(0, -1)) as unknown[] | undefined) ?? [];
    const k = was.findIndex((x) => hasId(x) && x.id === last.id);
    const placeAfter = was.slice(0, Math.max(0, k)).reverse().map((x) => (hasId(x) ? parent.findIndex((y) => hasId(y) && y.id === x.id) : -1)).find((j) => j >= 0);
    parent.splice(placeAfter === undefined ? Math.min(Math.max(0, k), parent.length) : placeAfter + 1, 0, value);
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

/**
 * Each patch read against the document as it stands just before that patch, except clips: one line per clip
 * added, removed or changed (its fields, in seconds), as an insert shifts every later clip's index.
 */
function describePatches(before: Project, after: Project, patches: Patch[]): string[] {
  let doc = before;
  let clips = false;
  const lines: string[] = [];
  for (const p of patches) {
    if (p.path[0] === "tracks" && (p.path.length <= 2 || p.path[2] === "clips")) {
      clips = true;
      continue;
    }
    const path = p.path.join("/");
    const was = valueAt(doc, p.path);
    doc = applyPatches(doc, [p]);
    if (p.op === "add") lines.push(`add ${path}: ${brief(p.value)}`);
    else if (p.op === "remove") lines.push(`remove ${path} (was ${brief(was)})`);
    else lines.push(`set ${path}: ${brief(was)} -> ${brief(p.value)}`);
  }
  return clips ? [...describeClips(before, after), ...lines] : lines;
}

const secs = (t: number) => Math.round(ticksToSeconds(t) * 1000) / 1000;
const span = (c: Clip) => `${c.type} ${secs(c.start)}-${secs(c.start + c.duration)}s`;
const TIMES = new Set(["start", "duration", "mediaStart"]);

/** Past this many clips of one kind on one track, added, removed or shifted alike, they make one line. */
const GROUP = 6;

/** Unchanged clips keep their object through Immer, so identity tells which changed. */
function describeClips(before: Project, after: Project): string[] {
  const index = (doc: Project) => new Map(doc.tracks.flatMap((t) => t.clips.map((c) => [c.id, { clip: c, track: t.id }] as const)));
  const was = index(before);
  const now = index(after);
  const lines: string[] = [];
  const runs = new Map<string, { line: (n: number, from: number, to: number) => string; lines: string[]; from: number; to: number }>();
  const run = (key: string, line: (n: number, from: number, to: number) => string, one: string, c: Clip) => {
    const r = runs.get(key) ?? { line, lines: [], from: Infinity, to: -Infinity };
    r.lines.push(one);
    r.from = Math.min(r.from, secs(c.start));
    r.to = Math.max(r.to, secs(c.start + c.duration));
    runs.set(key, r);
  };
  for (const t of before.tracks) if (!after.tracks.some((x) => x.id === t.id)) lines.push(`remove track ${t.id}`);
  for (const t of after.tracks) if (!before.tracks.some((x) => x.id === t.id)) lines.push(`add track ${t.id}`);
  for (const [id, { clip, track }] of was) {
    if (!now.has(id)) run(`remove ${clip.type} ${track}`, (n, a, b) => `remove ${n} ${clip.type} clips on ${track}, ${a}-${b}s`, `remove clip ${id} (was ${span(clip)} on ${track})`, clip);
  }
  for (const [id, { clip, track }] of now) {
    const old = was.get(id);
    if (!old) {
      run(`add ${clip.type} ${track}`, (n, a, b) => `add ${n} ${clip.type} clips on ${track}, ${a}-${b}s`, `add clip ${id}: ${span(clip)} on ${track}`, clip);
      continue;
    }
    if (old.clip === clip && old.track === track) continue;
    const fields: string[] = old.track === track ? [] : [`track ${old.track} -> ${track}`];
    for (const k of new Set([...Object.keys(old.clip), ...Object.keys(clip)]) as Set<keyof Clip>) {
      const a = old.clip[k];
      const b = clip[k];
      if (a === b || JSON.stringify(a) === JSON.stringify(b)) continue;
      if (TIMES.has(k)) fields.push(`${k} ${a === undefined ? "none" : secs(a as number)} -> ${b === undefined ? "none" : secs(b as number)}`);
      else if (k === "props") {
        const pa = a as Clip["props"];
        const pb = b as Clip["props"];
        for (const g of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
          const ga = pa[g] as Record<string, unknown> | undefined;
          const gb = pb[g] as Record<string, unknown> | undefined;
          if (ga === gb || JSON.stringify(ga) === JSON.stringify(gb)) continue;
          if (!ga || !gb) fields.push(`props.${g} ${brief(ga)} -> ${brief(gb)}`);
          else for (const f of new Set([...Object.keys(ga), ...Object.keys(gb)])) if (JSON.stringify(ga[f]) !== JSON.stringify(gb[f])) fields.push(`props.${g}.${f} ${brief(ga[f])} -> ${brief(gb[f])}`);
        }
      } else if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) fields.push(`${k} ${a.length} -> ${b.length}`);
      else fields.push(`${k} ${brief(a)} -> ${brief(b)}`);
    }
    if (!fields.length) continue;
    const one = `set clip ${id}: ${fields.join(", ")}`;
    const shift = old.track === track && fields.length === 1 && fields[0]!.startsWith("start ") ? secs(clip.start) - secs(old.clip.start) : undefined;
    if (shift === undefined) lines.push(one);
    else {
      const by = Math.round(shift * 1000) / 1000;
      run(`shift ${track} ${by}`, (n, a, b) => `move ${n} clips on ${track} by ${by}s (now ${a}-${b}s)`, one, clip);
    }
  }
  for (const r of runs.values()) {
    if (r.lines.length > GROUP) lines.push(r.line(r.lines.length, r.from, r.to));
    else lines.push(...r.lines);
  }
  return lines;
}
