import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import type { CoreEvent, BeaconCore, ProjectHandle } from "./api";

/**
 * The app's automation socket (PLAN §7.1): newline-delimited JSON-RPC 2.0.
 * Requests name an `BeaconCore` method with positional params; the
 * server pushes `event` notifications (`{ project, event }`) for projects a
 * client has opened. Bytes (PNG stills) travel as `{ "$bytes": base64 }`.
 */
export const SOCKET_DIR = join(homedir(), "Library/Application Support/Beacon");

/**
 * This process's socket. One per app process, so a second app can't take
 * over the first's; agents find it in the project's lock file.
 */
export const DEFAULT_SOCKET = join(SOCKET_DIR, `app-${process.pid}.sock`);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes sockets left by app processes that are gone (a crash leaves them behind). */
function removeStaleSockets(dir: string) {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const pid = Number(name.match(/^app-(\d+)\.sock$/)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) rmSync(join(dir, name), { force: true });
  }
}

/** The running apps' sockets: `BEACON_SOCKET` when set (tests), else every live one in the app's folder. */
export function appSockets(): string[] {
  if (process.env.BEACON_SOCKET) return existsSync(process.env.BEACON_SOCKET) ? [process.env.BEACON_SOCKET] : [];
  if (!existsSync(SOCKET_DIR)) return [];
  return readdirSync(SOCKET_DIR)
    .filter((name) => {
      const pid = Number(name.match(/^app-(\d+)\.sock$/)?.[1]);
      return pid && pid !== process.pid && alive(pid);
    })
    .map((name) => join(SOCKET_DIR, name));
}

export const PROTOCOL_VERSION = 1;

/** Methods a client may call; `close` only detaches the client, the project stays open in the app. */
export const METHODS = [
  "hello",
  "open",
  "close",
  "save",
  "saveAs",
  "reveal",
  "run",
  "transaction",
  "undo",
  "redo",
  "history",
  "query",
  "frame",
  "captureFrame",
  "sheet",
  "export",
  "import",
  "analyze",
  "forget",
  "missing",
  "relink",
  "replace",
  "analysisSize",
  "forgetAll",
  "job",
  "jobs",
  "cancelJob",
  "resources",
  "fetchResource",
  "preferences",
  "setPreference",
  "favorites",
  "favoriteAdd",
  "favoriteRemove",
  "favoriteMove",
  "shortcuts",
  "shortcutSet",
  "shortcutReset",
  "commands",
  "queries",
  "schema",
  "summary",
  "checkOutput",
  "recorderDevices",
  "recorderAccess",
  "recordStart",
  "recordStatus",
  "recordStop",
  "session",
  "snapshot",
] as const;

export type Method = (typeof METHODS)[number];

export function encode(value: unknown): string {
  return JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v));
}

export function decode(text: string): any {
  return JSON.parse(text, (_, v) => (v && typeof v === "object" && typeof v.$bytes === "string" ? new Uint8Array(Buffer.from(v.$bytes, "base64")) : v));
}

/** Splits a byte stream into lines. */
export class LineReader {
  #buf = "";
  readonly #decoder = new TextDecoder();
  constructor(readonly onLine: (line: string) => void) {}
  push(chunk: Uint8Array) {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
  }
}

interface Client {
  reader: LineReader;
  watching: Map<ProjectHandle, () => void>;
  /** Bun's socket write may take part of the data; the rest waits for drain. */
  pending: Uint8Array[];
}

export interface CoreServer {
  path: string;
  stop(): void;
}

/**
 * Serves a core (the app's own) on a unix socket only this user can reach.
 * `canOpen` decides which project paths a client may attach to; `projects` lists them, for `hello`.
 */
export function serveCore(core: BeaconCore, opts: { path?: string; canOpen?: (path: string) => boolean; projects?: () => string[] } = {}): CoreServer {
  const path = opts.path ?? DEFAULT_SOCKET;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeStaleSockets(dirname(path));
  // A path given explicitly (BEACON_SOCKET, tests) is the caller's to reuse.
  if (existsSync(path)) rmSync(path);

  const send = (s: Socket<Client>, msg: unknown) => {
    const bytes = new TextEncoder().encode(`${encode(msg)}\n`);
    if (s.data.pending.length) return void s.data.pending.push(bytes);
    const n = s.write(bytes);
    if (n < bytes.length) s.data.pending.push(bytes.subarray(Math.max(0, n)));
  };

  const handle = async (s: Socket<Client>, req: { id?: number | string; method: string; params?: unknown[] }) => {
    // JSON turns omitted optional arguments into null.
    const params = (Array.isArray(req.params) ? req.params : []).map((p) => (p === null ? undefined : p));
    try {
      if (!(METHODS as readonly string[]).includes(req.method)) throw new Error(`unknown method "${req.method}"`);
      const method = req.method as Method;
      let result: unknown;
      if (method === "hello") result = { protocol: PROTOCOL_VERSION, pid: process.pid, projects: opts.projects?.() ?? [] };
      else if (method === "open") {
        const p = String(params[0]);
        if (opts.canOpen && !opts.canOpen(p)) throw new Error(`${p} is not open in the app`);
        const h = await core.open(p);
        if (!s.data.watching.has(h)) s.data.watching.set(h, core.watch(h, (event: CoreEvent) => send(s, { jsonrpc: "2.0", method: "event", params: { project: h, event } })));
        result = h;
      } else if (method === "close") {
        const h = String(params[0]);
        s.data.watching.get(h)?.();
        s.data.watching.delete(h);
        result = null;
      } else if (method === "export" || method === "analyze" || method === "fetchResource") {
        const job = await (core[method] as (...a: unknown[]) => Promise<{ id: string }>)(...params);
        result = { id: job.id };
      } else {
        result = await (core[method] as (...a: unknown[]) => unknown).apply(core, params);
      }
      if (req.id !== undefined) send(s, { jsonrpc: "2.0", id: req.id, result: result ?? null });
    } catch (e) {
      if (req.id !== undefined) send(s, { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    }
  };

  const server = Bun.listen<Client>({
    unix: path,
    socket: {
      open(s) {
        s.data = { reader: new LineReader((line) => {
          let req;
          try {
            req = decode(line);
          } catch {
            return send(s, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
          }
          void handle(s, req);
        }), watching: new Map(), pending: [] };
      },
      data(s, chunk) {
        s.data.reader.push(chunk);
      },
      drain(s) {
        while (s.data.pending.length) {
          const next = s.data.pending[0]!;
          const n = s.write(next);
          if (n < next.length) {
            s.data.pending[0] = next.subarray(Math.max(0, n));
            return;
          }
          s.data.pending.shift();
        }
      },
      close(s) {
        for (const off of s.data?.watching.values() ?? []) off();
      },
    },
  });
  chmodSync(path, 0o600);
  return {
    path,
    stop() {
      server.stop(true);
      rmSync(path, { force: true });
    },
  };
}
