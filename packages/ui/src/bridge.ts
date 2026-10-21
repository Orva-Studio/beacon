import type { CoreEvent, JobInfo, LocalCore } from "@beacon/core";
import type { AppSettings, Session, ShortcutInfo } from "@beacon/model";
import { appWideMessage } from "./payloads";
import type { AppRPC } from "./rpc";

/**
 * What a project's core events tell the window, for the app's main process and for the UI harness that stands
 * in for it: one translation, so the harness's flows test the app's. Runs in those processes, not the page.
 */

type Messages = AppRPC["webview"]["messages"];
/** A message to the window: the app's RPC, or the harness's socket. */
export type Send = <K extends keyof Messages>(type: K, data: Messages[K]) => void;

type Core = Pick<LocalCore, "watch" | "doc" | "derived">;

/** What the app does besides telling the window; the harness leaves most of it out. */
export interface BridgeHooks {
  /** Every event, first (the app's diagnostics count them). */
  every?(e: CoreEvent): void;
  /** The document changed (an edit, undo or redo), after the window was sent its patches. */
  changed?(e: Extract<CoreEvent, { kind: "apply" | "undo" | "redo" }>): void;
  session?(changes: Partial<Session>): void;
  /** Every other event (saved, needs, narrated, error), and every job event after its progress was sent. */
  other?(e: CoreEvent): void;
}

/** What the app does with app-wide changes besides telling the window. */
export interface AppBridgeHooks {
  /** Keys rebound: the app's menus show them first. Without it the window is told. */
  shortcuts?(shortcuts: ShortcutInfo[]): void;
  /** Settings changed: the app applies them first. Without it the window is told. */
  settings?(settings: AppSettings): void;
  /** Every job's progress, whichever project it is for (exports, downloads). */
  job?(job: JobInfo): void;
}

/** App-wide changes told to one window, with or without a project open: favourites, preferences, keys, settings. */
export function appBridge(core: Pick<LocalCore, "watchApp" | "preferences">, send: Send, hooks: AppBridgeHooks = {}): () => void {
  return core.watchApp((e) => {
    if (e.kind === "favorites" || e.kind === "preference") {
      void appWideMessage(core, e).then((m) => m && (m.type === "favorites" ? send("favorites", m.data) : send("preferences", m.data)));
    } else if (e.kind === "shortcuts") {
      if (hooks.shortcuts) hooks.shortcuts(e.shortcuts);
      else send("shortcuts", { shortcuts: e.shortcuts });
    } else if (e.kind === "settings") {
      if (hooks.settings) hooks.settings(e.settings);
      else send("appSettings", e.settings);
    } else if (e.kind === "job") hooks.job?.(e.job);
  });
}

export interface ProjectBridge {
  unwatch(): void;
  /** The revision the window's document is at: patches number on from it. */
  rev(): number;
  /** Waveforms the window doesn't have yet; `all`, every one (a window starting afresh). */
  sendWaveforms(all?: boolean): void;
  /** Media whose proxy is being made: waiting (`queued`) or under way (`jobs`), by asset, 0-1. */
  readonly proxies: { queued: Record<string, number>; jobs: Record<string, number> };
}

export function projectBridge(core: Core, h: string, send: Send, hooks: BridgeHooks = {}): ProjectBridge {
  let rev = 0;
  const transcribing: Record<string, number> = {};
  const analyzing: Record<string, number> = {};
  const analysisFailed: Record<string, string> = {};
  const judging: Record<string, number> = {};
  const judgeFailed: Record<string, string> = {};
  const proxies: ProjectBridge["proxies"] = { queued: {}, jobs: {} };
  const sendPreparing = () => send("media", { preparing: { ...proxies.queued, ...proxies.jobs } });
  // The file each asset's waveform in the window is of (the window merges them), so only new or replaced media is sent.
  const waveformsSent = new Map<string, string>();
  const sendWaveforms = (all = false) => {
    if (all) waveformsSent.clear();
    const waveforms: Record<string, Record<number, number[]>> = {};
    for (const [id, asset] of Object.entries(core.doc(h).assets)) {
      const file = `${asset.path}\0${asset.fingerprint}`;
      if (waveformsSent.get(id) === file) continue;
      const w = core.derived<{ streams: Record<number, number[]> }>(h, id, "waveform");
      if (w) (waveforms[id] = w.streams), waveformsSent.set(id, file);
    }
    if (Object.keys(waveforms).length) send("media", { waveforms });
  };
  const unwatch = core.watch(h, (e) => {
    hooks.every?.(e);
    if (e.kind === "apply" || e.kind === "undo" || e.kind === "redo") {
      send("patches", { patches: e.patches, label: e.label, kind: e.kind, rev: ++rev });
      // Media added, replaced or relinked may have its waveform cached already, with no job to say so.
      if (e.patches.some((p) => p.path[0] === "assets")) sendWaveforms();
      hooks.changed?.(e);
    } else if (e.kind === "session") {
      send("session", { changes: e.changes });
      hooks.session?.(e.changes);
    } else if (e.kind === "preparing") {
      proxies.queued = e.assets;
      sendPreparing();
    } else if (e.kind === "derived" && e.key === "proxy") {
      send("media", { proxies: { [e.asset]: e.present } });
    } else if (e.kind === "job") {
      const { job } = e;
      if (job.kind === "transcript" && job.asset) {
        if (job.state === "running") transcribing[job.asset] = job.progress;
        else delete transcribing[job.asset];
        send("media", { transcribing: { ...transcribing } });
      }
      if (job.kind === "retakes" && job.asset) {
        if (job.state === "running") {
          judging[job.asset] = job.progress;
          delete judgeFailed[job.asset];
        } else delete judging[job.asset];
        if (job.state === "failed") judgeFailed[job.asset] = job.error ?? "failed";
        send("media", { judging: { ...judging }, judgeFailed: { ...judgeFailed } });
      }
      if (job.kind === "proxy" && job.asset) {
        if (job.state === "running") proxies.jobs[job.asset] = job.progress;
        else delete proxies.jobs[job.asset];
        sendPreparing();
      }
      // A cancelled job ends as failed, but nothing went wrong.
      if (job.state === "failed" && job.error !== "cancelled" && job.asset && (job.kind === "transcript" || job.kind === "proxy")) send("media", { jobFailed: { [job.asset]: `${job.kind === "transcript" ? "Transcribing" : "Making a proxy"} failed${job.error ? `: ${job.error}` : ""}` } });
      // Any analysis of a medium (an effect's matte): its progress while it runs, and why it failed.
      if (job.asset) {
        const key = `${job.kind}:${job.asset}`;
        if (job.state === "running") analyzing[key] = job.progress;
        else delete analyzing[key];
        if (job.state === "failed" && job.error !== "cancelled") analysisFailed[key] = job.error ?? "failed";
        else if (job.state === "running") delete analysisFailed[key];
        send("media", { analyzing: { ...analyzing }, analysisFailed: { ...analysisFailed } });
      }
      if (job.state === "done" && job.kind === "waveform") sendWaveforms();
      hooks.other?.(e);
    } else if (e.kind === "importing") {
      const { kind: _, ...files } = e;
      send("importing", files);
    } else hooks.other?.(e);
  });
  return { unwatch, rev: () => rev, sendWaveforms, proxies };
}

type Requests = AppRPC["bun"]["requests"];
type Handlers = { [K in keyof Requests]: (params: Requests[K]["params"]) => Promise<Requests[K]["response"]> };
type Shared = "run" | "query" | "undo" | "redo" | "cancelExport" | "cancelJob" | "proxySpace" | "deleteAllProxies" | "setPreference" | "setSecret" | "favoriteAdd" | "favoriteRemove" | "favoriteMove" | "analyze" | "binFrame" | "frameImage";
type RequestCore = Pick<LocalCore, "run" | "query" | "undo" | "redo" | "cancelJob" | "analysisSize" | "forgetAll" | "setPreference" | "setSecret" | "preferences" | "favoriteAdd" | "favoriteRemove" | "favoriteMove" | "analyze" | "assetThumbnail" | "frame" | "session">;

const failed = (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const done = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return failed(e);
  }
};
const answer = async <T>(fn: () => Promise<T>) => {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return failed(e);
  }
};
const png = (bytes: Uint8Array | undefined) => (bytes?.length ? `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` : null);

/**
 * The window's requests that are core's alone, for the app and the UI harness; each adds the ones that need its
 * process (dialogs, menus, native views, recording). `project`: the open one. `status`: a background failure to show.
 */
export function coreRequests(core: RequestCore, project: () => string | undefined, status: (message: string) => void = () => {}): Pick<Handlers, Shared> {
  const open = () => {
    const h = project();
    if (!h) throw new Error("no project is open");
    return h;
  };
  // Edits with no project open (⌘Z on the start screen) do nothing, quietly.
  const edit = (fn: (h: string) => Promise<unknown>) => done(async () => {
    const h = project();
    if (h) await fn(h);
  });
  return {
    run: ({ command, args, label, coalesce }) => edit((h) => core.run(h, command, args ?? {}, { ...(label ? { label } : {}), ...(coalesce ? { coalesce } : {}) })),
    query: ({ name, args }) => answer(() => core.query(open(), name, args ?? {})),
    undo: () => edit((h) => core.undo(h)),
    redo: () => edit((h) => core.redo(h)),
    cancelExport: ({ id }) => done(() => core.cancelJob(id)),
    cancelJob: ({ id }) => done(() => core.cancelJob(id)),
    proxySpace: () => core.analysisSize("proxy"),
    deleteAllProxies: async () => (await core.forgetAll("proxy"), core.analysisSize("proxy")),
    setPreference: ({ id, value }) => answer(async () => (await core.setPreference(id, value), core.preferences())),
    setSecret: ({ id, value }) => answer(async () => (await core.setSecret(id, value), core.preferences())),
    favoriteAdd: ({ item, index }) => answer(() => core.favoriteAdd(item, index)),
    favoriteRemove: ({ item }) => answer(() => core.favoriteRemove(item)),
    favoriteMove: ({ item, index }) => answer(() => core.favoriteMove(item, index)),
    analyze: async ({ key, asset }) => {
      const h = project();
      if (h) await core.analyze(h, key, asset).catch((e: Error) => status(e.message));
    },
    binFrame: async ({ asset, time }) => {
      const h = project();
      return png(h ? await core.assetThumbnail(h, asset, 128, time).catch(() => undefined) : undefined);
    },
    frameImage: async () => {
      const h = project();
      return h ? png((await core.frame(h, (await core.session(h)).playhead)).png) : null;
    },
  };
}
