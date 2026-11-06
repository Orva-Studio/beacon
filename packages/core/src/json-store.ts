import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";

/** A JSON file's contents; undefined when missing or unreadable. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Writes through a rename, so a crash never leaves the file half written. */
export function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/**
 * One app-wide JSON file: what its schema accepts, made whole by `fromSaved` (which also gets undefined for a file
 * missing, unreadable or not accepted). It remembers what it last read or wrote, so `reload` can tell a change another
 * process (an agent's core) or a hand edit made.
 */
export class JsonStore<T, S = T> {
  #known: T;

  constructor(
    readonly file: string,
    readonly schema: ZodType<S>,
    readonly fromSaved: (saved: S | undefined) => T,
  ) {
    this.#known = this.load();
  }

  /** The file as it is now, without touching what `reload` compares with. */
  load(): T {
    const saved = this.schema.safeParse(readJson(this.file));
    return this.fromSaved(saved.success ? saved.data : undefined);
  }

  /** What was last read or written. */
  get value(): T {
    return this.#known;
  }

  write(value: T) {
    writeAtomic(this.file, JSON.stringify(value, null, 2));
    this.#known = value;
  }

  /** Reads the file again; true when it differs from what was last read or written. */
  reload(): boolean {
    const next = this.load();
    const changed = !Bun.deepEquals(next, this.#known);
    this.#known = next;
    return changed;
  }
}
