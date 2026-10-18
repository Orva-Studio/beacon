import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Socket } from "bun";
import { lockOwner } from "./persist";
import type {
  AppEvent,
  CommandInfo,
  CoreEvent,
  ExportOptions,
  Job,
  JobInfo,
  NewProjectOptions,
  BeaconCore,
  ProjectHandle,
  QueryInfo,
  SchemaInfo,
} from "./api";
import { appSockets, decode, encode, FORWARDED, LineReader, PROTOCOL_VERSION, type Method } from "./socket";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

function settle(p: Pending, job: JobInfo) {
  if (job.state === "done") p.resolve(job.result);
  else p.reject(new Error(job.error ?? "job failed"));
}

/** The methods `FORWARDED` names, made in the constructor. */
export interface RemoteCore extends Pick<BeaconCore, (typeof FORWARDED)[number]> {}

/**
 * The core of a running app, over its unix socket (PLAN §7.1): edits land
 * in the app's document and undo history and show on its timeline live.
 */
export class RemoteCore implements BeaconCore {
  #socket!: Socket<undefined>;
  /** Bun's socket write may take part of the data (a large request); the rest waits for drain. */
  #out: Uint8Array[] = [];
  #next = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<ProjectHandle, Set<(e: CoreEvent) => void>>();
  readonly #appListeners = new Set<(e: AppEvent) => void>();
  /** Jobs this client started, finished when their job event says so. */
  readonly #jobs = new Map<string, Pending>();
  /** Jobs that ended before their start call returned. */
  readonly #ended = new Map<string, JobInfo>();
  /** Export and analyze calls awaiting their job id; other clients' and the app's jobs aren't kept otherwise. */
  #starting = 0;
  #closed?: Error;
  #commands: CommandInfo[] = [];
  #queries: QueryInfo[] = [];
  #schema!: SchemaInfo;

  private constructor(readonly path: string) {
    for (const method of FORWARDED) Object.assign(this, { [method]: (...params: unknown[]) => this.#call(method, ...params) });
  }

  static async connect(path: string): Promise<RemoteCore> {
    const r = new RemoteCore(path);
    const reader = new LineReader((line) => r.#receive(decode(line)));
    r.#socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_, chunk) => reader.push(chunk),
        drain: (s) => {
          while (r.#out.length) {
            const next = r.#out[0]!;
            const n = s.write(next);
            if (n < next.length) return void (r.#out[0] = next.subarray(Math.max(0, n)));
            r.#out.shift();
          }
        },
        close: () => r.#fail(new Error("the Beacon app closed the connection")),
        error: (_, e) => r.#fail(e),
      },
    });
    const hello = await r.#call<{ protocol: number }>("hello");
    if (hello.protocol !== PROTOCOL_VERSION) {
      r.disconnect();
      throw new Error(`the Beacon app speaks protocol ${hello.protocol}, this client ${PROTOCOL_VERSION}; update one of them`);
    }
    [r.#commands, r.#queries, r.#schema] = await Promise.all([r.#call<CommandInfo[]>("commands"), r.#call<QueryInfo[]>("queries"), r.#call<SchemaInfo>("schema")]);
    return r;
  }

  disconnect() {
    this.#socket.end();
  }

  #fail(e: Error) {
    this.#closed ??= e;
    for (const p of [...this.#pending.values(), ...this.#jobs.values()]) p.reject(e);
    this.#pending.clear();
    this.#jobs.clear();
  }

  #receive(msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { project?: ProjectHandle; event: CoreEvent } }) {
    if (msg.method === "appEvent" && msg.params) {
      const event = msg.params.event as AppEvent;
      // Every job's end comes here, a download's (which has no project) too.
      if (event.kind === "job" && event.job.state !== "running") {
        const j = this.#jobs.get(event.job.id);
        if (j) {
          this.#jobs.delete(event.job.id);
          settle(j, event.job);
        } else if (this.#starting) this.#ended.set(event.job.id, event.job);
      }
      for (const l of this.#appListeners) l(event);
      return;
    }
    if (msg.method === "event" && msg.params?.project) {
      for (const l of this.#listeners.get(msg.params.project) ?? []) l(msg.params.event);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  #call<T = unknown>(method: Method, ...params: unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const bytes = new TextEncoder().encode(`${encode({ jsonrpc: "2.0", id, method, params })}\n`);
      if (this.#out.length) return void this.#out.push(bytes);
      const n = this.#socket.write(bytes);
      if (n < bytes.length) this.#out.push(bytes.subarray(Math.max(0, n)));
    });
  }

  #job(id: string): Job {
    const done = new Promise((resolve, reject) => {
      const ended = this.#ended.get(id);
      this.#ended.delete(id);
      if (ended) settle({ resolve, reject }, ended);
      else this.#jobs.set(id, { resolve, reject });
    });
    done.catch(() => {});
    return { id, done };
  }

  async create(_: NewProjectOptions): Promise<ProjectHandle> {
    throw new Error("create projects headlessly or in the app; the app's socket only attaches to open projects");
  }
  recorderPreview = (): Promise<void> => Promise.reject(new Error("the recorder's preview is only shown in the app"));
  recorderSetOutput = (): Promise<never> => Promise.reject(new Error("the sound output is set in the app"));
  recordSyncCheck = (): Promise<never> => Promise.reject(new Error("the sync check runs in the app"));
  async fetchResource(id: string): Promise<Job> {
    return this.#start("fetchResource", id);
  }

  async export(h: ProjectHandle, opts: ExportOptions): Promise<Job> {
    return this.#start("export", h, opts);
  }

  async analyze(h: ProjectHandle, key: string, assetId: string): Promise<Job> {
    return this.#start("analyze", h, key, assetId);
  }

  async #start(method: "export" | "analyze" | "fetchResource", ...params: unknown[]): Promise<Job> {
    this.#starting++;
    try {
      return this.#job((await this.#call<{ id: string }>(method, ...params)).id);
    } finally {
      if (--this.#starting === 0) this.#ended.clear();
    }
  }

  commands = () => this.#commands;
  queries = () => this.#queries;
  schema = () => this.#schema;

  watchApp(fn: (e: AppEvent) => void): () => void {
    this.#appListeners.add(fn);
    return () => this.#appListeners.delete(fn);
  }

  watch(h: ProjectHandle, fn: (e: CoreEvent) => void): () => void {
    let set = this.#listeners.get(h);
    if (!set) this.#listeners.set(h, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
}

/**
 * The running app's core when it holds the project's lock (it has the
 * project open), so agents edit live; undefined when the project is free.
 */
export async function appCoreFor(project: string): Promise<RemoteCore | undefined> {
  const owner = lockOwner(resolve(project));
  if (!owner?.socket || owner.pid === process.pid || !existsSync(owner.socket)) return undefined;
  return RemoteCore.connect(owner.socket);
}

/** How long an app has to answer `hello` before discovery moves on without it (a frozen app still has its socket). */
const PROBE_MS = 1000;

/** The projects one app has open, from its `hello` alone; undefined when it doesn't answer in time. */
async function probe(path: string): Promise<string[] | undefined> {
  let socket: Socket | undefined;
  let done: (projects: string[] | undefined) => void = () => {};
  const answer = new Promise<string[] | undefined>((resolve) => (done = resolve));
  const timer = setTimeout(() => done(undefined), PROBE_MS);
  const reader = new LineReader((line) => {
    const msg = decode(line) as { result?: { protocol?: number; projects?: string[] } };
    done(msg.result?.protocol === PROTOCOL_VERSION ? (msg.result.projects ?? []) : undefined);
  });
  try {
    socket = await Bun.connect({ unix: path, socket: { data: (_, chunk) => reader.push(chunk), close: () => done(undefined), error: () => done(undefined) } });
    socket.write(`${encode({ jsonrpc: "2.0", id: 1, method: "hello", params: [] })}\n`);
    return await answer;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    socket?.end();
  }
}

/** The projects open in running Beacon apps, which `project_open` can connect to; an app that doesn't answer is skipped. */
export async function appProjects(): Promise<string[]> {
  return (await Promise.all(appSockets().map(probe))).flatMap((p) => p ?? []);
}
