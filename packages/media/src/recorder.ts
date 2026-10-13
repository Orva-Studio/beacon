import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { enginePath } from "./engine";

/** What `beacon-recorder devices` reports: permissions and what can be recorded. */
export interface RecorderDevices {
  permissions: { screen: string; camera: string; microphone: string };
  displays: { id: number; width: number; height: number }[];
  cameras: { id: string; name: string }[];
  microphones: { id: string; name: string }[];
}

/** What a take records; a missing source isn't recorded, a device without an id is the default one. */
export interface RecorderSources {
  screen?: { display?: number; fps?: number };
  systemAudio?: boolean;
  camera?: { id?: string };
  microphone?: { id?: string };
}

type Event = { event: string; id?: number; message?: string; [k: string]: unknown };

/**
 * The `beacon-recorder serve` sidecar (docs/formats/brec.md): started on first use and kept, one request at a
 * time per id. When this process exits its stdin closes, and the recorder finishes any take still running.
 */
export class Recorder {
  #proc?: Subprocess<"pipe", "pipe", "inherit">;
  #next = 1;
  #waiting = new Map<number, { resolve: (e: Event) => void; reject: (e: Error) => void }>();
  #ready?: Promise<void>;

  #start(): Promise<void> {
    const path = process.env.BEACON_RECORDER_PATH ?? enginePath("beacon-recorder");
    if (!existsSync(path)) return Promise.reject(new Error(`beacon-recorder not found at ${path}; run \`bun run build:engine\``));
    const proc = Bun.spawn([path, "serve"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.#proc = proc;
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line) as Event;
          if (e.event === "ready") ready();
          const w = e.id !== undefined ? this.#waiting.get(e.id) : undefined;
          if (!w) continue;
          this.#waiting.delete(e.id!);
          if (e.event === "error") w.reject(new Error(e.message ?? "the recorder failed"));
          else w.resolve(e);
        }
      }
    })();
    void proc.exited.then((code) => {
      this.#proc = undefined;
      this.#ready = undefined;
      for (const w of this.#waiting.values()) w.reject(new Error(`the recorder exited (${code})`));
      this.#waiting.clear();
      ready();
    });
    return started;
  }

  async #send(cmd: Record<string, unknown>): Promise<Event> {
    this.#ready ??= this.#start();
    await this.#ready;
    const proc = this.#proc;
    if (!proc) throw new Error("the recorder isn't running");
    const id = this.#next++;
    const reply = new Promise<Event>((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    proc.stdin.flush();
    return reply;
  }

  async devices(): Promise<RecorderDevices> {
    const { event: _, id: __, ...d } = await this.#send({ cmd: "devices" });
    return d as unknown as RecorderDevices;
  }

  /** Asks macOS for the permission (its prompt the first time); the status after. */
  async access(kind: "camera" | "microphone"): Promise<string> {
    return (await this.#send({ cmd: "access", kind })).status as string;
  }

  /** Starts a take into `dir` (a new `.brec` folder); resolves once every source is delivering. */
  async start(dir: string, sources: RecorderSources): Promise<void> {
    await this.#send({ cmd: "start", dir, sources });
  }

  async status(): Promise<{ recording: boolean; dir?: string; elapsed?: number }> {
    const e = await this.#send({ cmd: "status" });
    const status = e.status as { elapsed: number } | undefined;
    return { recording: e.recording as boolean, ...(e.dir ? { dir: e.dir as string } : {}), ...(status ? { elapsed: status.elapsed } : {}) };
  }

  /** Stops the take and finishes its files; the take's summary (`recording.json`'s). */
  async stop(): Promise<{ dir: string; duration: number; errors: string[] }> {
    return (await this.#send({ cmd: "stop" })).take as { dir: string; duration: number; errors: string[] };
  }

  /** Ends the sidecar; a take still running is finished first. */
  async close(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    proc.stdin.end();
    await proc.exited;
  }
}
