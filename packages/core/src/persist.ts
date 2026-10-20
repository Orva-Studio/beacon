import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { migrateProject, SCHEMA_VERSION, type FeatureRegistry, type Project } from "@beacon/model";

const PROJECT_FILE = "project.json";
const EDITOR_FILE = "editor.json";
const LOCK_FILE = "lock";

type Assets = Record<string, { path: string }>;

/**
 * A project read from disk, its asset paths absolute again. `stale`: written by an older schema, so
 * the caller writes it back to finish the migration.
 */
export function readProject(dir: string, registry: FeatureRegistry): { doc: Project; stale: boolean } {
  const file = join(dir, PROJECT_FILE);
  if (!existsSync(file)) throw new Error(`${dir} is not a Beacon project (no ${PROJECT_FILE})`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown; assets?: Assets };
  for (const a of Object.values(raw.assets ?? {})) if (typeof a.path === "string" && !isAbsolute(a.path)) a.path = join(dir, a.path);
  return { doc: migrateProject(raw, registry), stale: raw.schemaVersion !== SCHEMA_VERSION };
}

/** The document as stored: media inside the project folder relative to it, so a copied or moved project keeps it. */
function onDisk(dir: string, doc: Project): Project {
  const assets = Object.fromEntries(
    Object.entries(doc.assets).map(([id, a]) => [id, a.path.startsWith(dir + sep) ? { ...a, path: relative(dir, a.path) } : a]),
  );
  return { ...doc, assets };
}

/** Write temp → fsync → rename, so a crash never leaves a half-written project. */
export function writeProject(dir: string, doc: Project) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${PROJECT_FILE}.${process.pid}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(onDisk(dir, doc), null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, PROJECT_FILE));
}

/** The editor state features keep with the project (`Feature.sessionSaved`), by feature id; none if it can't be read. */
export function readEditor(dir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, EDITOR_FILE), "utf8")) as { features?: Record<string, unknown> };
    return raw.features && typeof raw.features === "object" ? raw.features : {};
  } catch {
    return {};
  }
}

export function writeEditor(dir: string, features: Record<string, unknown>) {
  const file = join(dir, EDITOR_FILE);
  if (!Object.keys(features).length) return rmSync(file, { force: true });
  writeFileSync(file, `${JSON.stringify({ features }, null, 2)}\n`);
}

/** A name typed for a project's folder, without `.beproj`; throws when it can't be one (empty, hidden, or with / or :). */
export function projectName(name: string): string {
  const clean = name.trim().replace(/\.beproj$/i, "");
  if (!clean || /[/:]/.test(clean) || clean.startsWith(".")) throw new Error(`"${name}" can't be a project name`);
  return clean;
}

/** Whether a process is running: one of another user's can't be signalled (EPERM) but is. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Owner {
  pid: number;
  host: string;
  /** The app's automation socket, when the owner is the app (PLAN §7.1). */
  socket?: string;
}

const me = (socket?: string): Owner => ({ pid: process.pid, host: hostname(), ...(socket ? { socket } : {}) });

function owner(file: string): Owner | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

const mine = (o: Owner | undefined) => o?.pid === process.pid && o.host === hostname();

/**
 * One writer per project. The lock is created exclusively; a lock that is
 * unreadable or held by a dead process on this machine is taken over by
 * renaming ours onto it, then re-read, since another process may have won.
 */
export function lock(dir: string, socket?: string) {
  const file = join(dir, LOCK_FILE);
  try {
    writeFileSync(file, JSON.stringify(me(socket)), { flag: "wx" });
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const held = owner(file);
  if (mine(held)) return;
  if (held && (held.host !== hostname() || alive(held.pid))) throw new Error(`${dir} is open in another process (pid ${held.pid} on ${held.host})`);
  const tmp = join(dir, `.${LOCK_FILE}.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(me(socket)));
  renameSync(tmp, file);
  if (!mine(owner(file))) throw new Error(`${dir} was just opened by another process`);
}

/** Removes the lock only if this process holds it. */
export function unlock(dir: string) {
  const file = join(dir, LOCK_FILE);
  if (mine(owner(file))) rmSync(file, { force: true });
}

/** The live process holding a project's lock on this machine, if any. */
export function lockOwner(dir: string): Owner | undefined {
  const held = owner(join(dir, LOCK_FILE));
  return held && held.host === hostname() && alive(held.pid) ? held : undefined;
}
