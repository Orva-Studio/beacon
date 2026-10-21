import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { enginePath } from "./engine";
import { readLines } from "./tool";

/** What `beacon-recorder devices` reports: permissions and what can be recorded. */
export interface RecorderDevices {
  permissions: { screen: string; camera: string; microphone: string };
  /** Sizes in points, `pixelWidth`/`pixelHeight` as a take records it; `x`, `y`: top-left in global points (the main display's is 0, 0). */
  displays: { id: number; width: number; height: number; pixelWidth?: number; pixelHeight?: number; x?: number; y?: number }[];
  /** `width`, `height`, `fps`: as a take records it (its active format). */
  cameras: { id: string; name: string; width?: number; height?: number; fps?: number }[];
  microphones: { id: string; name: string }[];
  /** Where sound can play: `speakers` when the room (and a microphone) hears it, not headphones or a virtual device. */
  outputs: { id: string; name: string; kind: string; speakers: boolean; default: boolean }[];
}

/** What a take records; a missing source isn't recorded, a device without an id is the default one. */
export interface RecorderSources {
  /** `exclude`: leave out the window with this number (Beacon's recording panel). */
  screen?: { display?: number; fps?: number; exclude?: number };
  systemAudio?: boolean;
  camera?: { id?: string };
  microphone?: { id?: string };
  /** Seconds added to a stream's start on import, by role (`camera`: minus how late it is, from the sync check). */
  offsets?: Record<string, number>;
}

/** An audio level in dBFS: the average and the recent peak. */
export interface RecorderLevel {
  db: number;
  peak: number;
}

/** What the Record dialog or the recording panel shows: a camera or screen frame (base64 JPEG, a few hundred pixels wide), or the audio levels. */
/** Each source a take records, and whether it still sends. */
export type RecorderLive = Partial<Record<"screen" | "camera" | "microphone" | "systemAudio", boolean>>;
/** A camera whose frames keep coming but show black or the same picture (a capture card that lost its camera). */
export type RecorderPicture = { camera?: "black" | "frozen" | null };
/** `devicesChanged`: a display, camera or microphone was connected or removed (only while previewing). */
export type RecorderPreviewEvent =
  | { source: "camera" | "screen"; jpeg: string }
  | { microphone?: RecorderLevel; systemAudio?: RecorderLevel; live?: RecorderLive; picture?: RecorderPicture }
  | { devicesChanged: true };

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
  #preview?: (e: RecorderPreviewEvent) => void;
  /** The take's listener: while a take records, its events go here, whatever the dialog's preview does. */
  #monitor?: (e: RecorderPreviewEvent) => void;

  #start(): Promise<void> {
    const path = process.env.BEACON_RECORDER_PATH ?? enginePath("beacon-recorder");
    if (!existsSync(path)) return Promise.reject(new Error(`beacon-recorder not found at ${path}; run \`bun run build:engine\``));
    const proc = Bun.spawn([path, "serve"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.#proc = proc;
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    void readLines(proc.stdout, (line) => {
      const e = JSON.parse(line) as Event;
      if (e.event === "ready") ready();
      else if (e.event === "previewFrame") (this.#monitor ?? this.#preview)?.({ source: e.source as "camera" | "screen", jpeg: e.jpeg as string });
      else if (e.event === "devicesChanged") this.#preview?.({ devicesChanged: true });
      else if (e.event === "previewLevel")
        (this.#monitor ?? this.#preview)?.({
          ...(e.microphone ? { microphone: e.microphone as RecorderLevel } : {}),
          ...(e.systemAudio ? { systemAudio: e.systemAudio as RecorderLevel } : {}),
          ...(e.live ? { live: e.live as RecorderLive } : {}),
          ...(e.picture ? { picture: e.picture as RecorderPicture } : {}),
        });
      const w = e.id !== undefined ? this.#waiting.get(e.id) : undefined;
      if (!w) return;
      this.#waiting.delete(e.id!);
      if (e.event === "error") w.reject(new Error(e.message ?? "the recorder failed"));
      else w.resolve(e);
    });
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

  /** Makes `output` (an id from `devices`) the Mac's sound output; the one it replaced. */
  async setOutput(output: string): Promise<string | undefined> {
    return ((await this.#send({ cmd: "setOutput", output })).before as string | null) ?? undefined;
  }

  /** Asks macOS for the permission (its prompt the first time); the status after. */
  async access(kind: "camera" | "microphone"): Promise<string> {
    return (await this.#send({ cmd: "access", kind })).status as string;
  }

  /** Shows the sources to `fn` until called again (with none, it stops); a take starting stops it. The screen is shown without its frame rate. */
  async preview(sources: RecorderSources, fn?: (e: RecorderPreviewEvent) => void): Promise<void> {
    this.#preview = fn;
    if (!sources.screen && !sources.systemAudio && !sources.camera && !sources.microphone) {
      if (this.#proc) await this.#send({ cmd: "previewStop" });
      return;
    }
    const { fps: _, ...screen } = sources.screen ?? {};
    await this.#send({ cmd: "preview", ...sources, ...(sources.screen ? { screen } : {}) });
  }

  /** Starts a take into `dir` (a new `.brec` folder); resolves once every source is delivering. `monitor` gets its audio levels. */
  async start(dir: string, sources: RecorderSources, monitor?: (e: RecorderPreviewEvent) => void): Promise<void> {
    this.#monitor = monitor;
    try {
      await this.#send({ cmd: "start", dir, sources, monitor: !!monitor });
    } catch (e) {
      this.#monitor = undefined;
      throw e;
    }
  }

  async status(): Promise<{ recording: boolean; dir?: string; elapsed?: number }> {
    const e = await this.#send({ cmd: "status" });
    const status = e.status as { elapsed: number } | undefined;
    return { recording: e.recording as boolean, ...(e.dir ? { dir: e.dir as string } : {}), ...(status ? { elapsed: status.elapsed } : {}) };
  }

  /** Stops the take and finishes its files; the take's summary (`recording.json`'s). */
  async stop(): Promise<{ dir: string; duration: number; errors: string[] }> {
    try {
      return (await this.#send({ cmd: "stop" })).take as { dir: string; duration: number; errors: string[] };
    } finally {
      this.#monitor = undefined;
    }
  }

  /** Ends the sidecar; a take still running is finished first. */
  async close(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    proc.stdin.end();
    await proc.exited;
  }
}
