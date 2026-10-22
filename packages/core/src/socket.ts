import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import type { AppEvent, CoreEvent, BeaconCore, ProjectHandle } from "./api";
import { alive } from "./persist";
import { LineReader } from "@beacon/media";

/**
 * The app's automation socket (PLAN §7.1): newline-delimited JSON-RPC 2.0.
 * Requests name an `BeaconCore` method with positional params; the
 * server pushes `event` notifications (`{ project, event }`) for projects a
 * client has opened, and `appEvent` notifications (`{ event }`) to every
 * client. Bytes (PNG stills) travel as `{ "$bytes": base64 }`.
 */
const SOCKET_DIR = join(homedir(), "Library/Application Support/Beacon");

/**
 * This process's socket. One per app process, so a second app can't take
 * over the first's; agents find it in the project's lock file.
 */
export const DEFAULT_SOCKET = join(SOCKET_DIR, `app-${process.pid}.sock`);

/** A windowless process's control socket (an MCP server's), beside the apps'. */
export const CONTROL_SOCKET = join(SOCKET_DIR, `mcp-${process.pid}.sock`);


/** Removes sockets left by app processes that are gone (a crash leaves them behind). */
function removeStaleSockets(dir: string) {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const pid = Number(name.match(/^(?:app|mcp)-(\d+)\.sock$/)?.[1]);
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

/**
 * Core methods that go over the socket as they are: called with their arguments, answered with their result.
 * `RemoteCore` is built from this list, so a method added to `BeaconCore` needs only its name here.
 */
export const FORWARDED = [
  "open", "close", "save", "saveAs", "reveal", "run", "transaction", "undo", "redo", "history", "query", "frame", "captureFrame", "sheet",
  "import", "forget", "missing", "relink", "replace", "analysisSize", "forgetAll", "job", "jobs", "cancelJob", "resources", "preferences", "secrets",
  "setPreference", "favorites", "favoriteAdd", "favoriteRemove", "favoriteMove", "shortcuts", "shortcutSet", "shortcutReset", "settings",
  "setSettings", "uiOpen", "summary", "checkOutput", "recorderDevices", "recorderAccess", "recordStart", "recordStatus", "recordStop",
  "session", "snapshot",
] as const satisfies readonly (keyof BeaconCore)[];

/** Methods a client may call: the forwarded ones, those that start a job (answered with its id), the registry's, `hello` and `show`. */
const METHODS = ["hello", "show", ...FORWARDED, "export", "analyze", "fetchResource", "commands", "queries", "schema"] as const;

export type Method = (typeof METHODS)[number];

export function encode(value: unknown): string {
  return JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v));
}

export function decode(text: string): any {
  return JSON.parse(text, (_, v) => (v && typeof v === "object" && typeof v.$bytes === "string" ? new Uint8Array(Buffer.from(v.$bytes, "base64")) : v));
}


/** JSON-RPC messages written to a socket in order: Bun's write may take part of the data, and the rest waits for `drain`. */
export class LineWriter {
  #out: Uint8Array[] = [];
  readonly #encoder = new TextEncoder();
  constructor(readonly write: (bytes: Uint8Array) => number) {}
  send(msg: unknown) {
    const bytes = this.#encoder.encode(`${encode(msg)}\n`);
    if (this.#out.length) return void this.#out.push(bytes);
    const n = this.write(bytes);
    if (n < bytes.length) this.#out.push(bytes.subarray(Math.max(0, n)));
  }
  drain() {
    while (this.#out.length) {
      const next = this.#out[0]!;
      const n = this.write(next);
      if (n < next.length) return void (this.#out[0] = next.subarray(Math.max(0, n)));
      this.#out.shift();
    }
  }
}

interface Client {
  reader: LineReader;
  writer: LineWriter;
  watching: Map<ProjectHandle, () => void>;
  /** Stops the app-wide events this client is sent. */
  unwatchApp: () => void;
}

export interface CoreServer {
  path: string;
  stop(): void;
}

/**
 * Serves a core (the app's own) on a unix socket only this user can reach.
 * `canOpen` decides which project paths a client may attach to; `projects` lists them, for `hello`.
 */
export function serveCore(
  core: BeaconCore,
  opts: { path?: string; canOpen?: (path: string) => boolean; projects?: () => string[]; show?: (path: string) => void } = {},
): CoreServer {
  const path = opts.path ?? DEFAULT_SOCKET;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeStaleSockets(dirname(path));
  // A path given explicitly (BEACON_SOCKET, tests) is the caller's to reuse.
  if (existsSync(path)) rmSync(path);

  const send = (s: Socket<Client>, msg: unknown) => s.data.writer.send(msg);

  const handle = async (s: Socket<Client>, req: { id?: number | string; method: string; params?: unknown[] }) => {
    // JSON turns omitted optional arguments into null.
    const params = (Array.isArray(req.params) ? req.params : []).map((p) => (p === null ? undefined : p));
    try {
      if (!(METHODS as readonly string[]).includes(req.method)) throw new Error(`unknown method "${req.method}"`);
      const method = req.method as Method;
      let result: unknown;
      if (method === "hello") result = { protocol: PROTOCOL_VERSION, projects: opts.projects?.() ?? [] };
      else if (method === "show") {
        if (!opts.show) throw new Error("this app can't show a project");
        opts.show(String(params[0]));
      }
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
        }), writer: new LineWriter((bytes) => s.write(bytes)), watching: new Map(), unwatchApp: core.watchApp((event: AppEvent) => send(s, { jsonrpc: "2.0", method: "appEvent", params: { event } })) };
      },
      data(s, chunk) {
        s.data.reader.push(chunk);
      },
      drain(s) {
        s.data.writer.drain();
      },
      close(s) {
        s.data?.unwatchApp();
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

/**
 * A windowless process's control socket (an MCP server's): `letGo(path)` asks it to close a project the app wants,
 * answered once it has (or with why not). Only this user can reach it.
 */
export function serveControl(handlers: { letGo: (path: string) => Promise<void> }, path = CONTROL_SOCKET): CoreServer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeStaleSockets(dirname(path));
  if (existsSync(path)) rmSync(path);
  const server = Bun.listen<{ reader: LineReader; writer: LineWriter }>({
    unix: path,
    socket: {
      open(s) {
        const writer = new LineWriter((bytes) => s.write(bytes));
        s.data = {
          writer,
          reader: new LineReader((line) => {
            let req: { id?: number; method?: string; params?: unknown[] };
            try {
              req = decode(line);
            } catch {
              return writer.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
            }
            const run = req.method === "letGo" ? handlers.letGo(String(req.params?.[0])) : Promise.reject(new Error(`unknown method "${req.method}"`));
            run.then(
              () => writer.send({ jsonrpc: "2.0", id: req.id, result: null }),
              (e: unknown) => writer.send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
            );
          }),
        };
      },
      data(s, chunk) {
        s.data.reader.push(chunk);
      },
      drain(s) {
        s.data.writer.drain();
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

/** One request to a lock owner's socket (an app's `show`, a windowless process's `letGo`): its answer, or its error thrown. */
export async function askOwner(socket: string, method: "show" | "letGo", path: string, ms = 10_000): Promise<void> {
  let conn: Socket | undefined;
  let done: (error?: string) => void = () => {};
  const answer = new Promise<string | undefined>((resolve) => (done = resolve));
  const timer = setTimeout(() => done("it didn't answer"), ms);
  const reader = new LineReader((line) => {
    const msg = decode(line) as { error?: { message: string } };
    done(msg.error?.message);
  });
  try {
    conn = await Bun.connect({ unix: socket, socket: { data: (_, chunk) => reader.push(chunk), close: () => done("it closed the connection"), error: () => done("it couldn't be reached") } }).catch(() => {
      throw new Error("it couldn't be reached");
    });
    conn.write(`${encode({ jsonrpc: "2.0", id: 1, method, params: [path] })}\n`);
    const error = await answer;
    if (error) throw new Error(error);
  } finally {
    clearTimeout(timer);
    conn?.end();
  }
}
