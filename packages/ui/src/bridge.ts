import type { CoreEvent, LocalCore } from "@beacon/core";
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

type Core = Pick<LocalCore, "watch" | "doc" | "derived" | "preferences">;

/** What the app does besides telling the window; the harness leaves most of it out. */
export interface BridgeHooks {
  /** Every event, first (the app's diagnostics count them). */
  every?(e: CoreEvent): void;
  /** The document changed (an edit, undo or redo), after the window was sent its patches. */
  changed?(e: Extract<CoreEvent, { kind: "apply" | "undo" | "redo" }>): void;
  session?(changes: Partial<Session>): void;
  /** Keys rebound: the app's menus show them first. Without it the window is told. */
  shortcuts?(shortcuts: ShortcutInfo[]): void;
  /** Settings changed: the app applies them first. Without it the window is told. */
  settings?(settings: AppSettings): void;
  /** Every other event (saved, needs, narrated, error), and every job event after its progress was sent. */
  other?(e: CoreEvent): void;
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
    } else if (e.kind === "favorites" || e.kind === "preference") {
      void appWideMessage(core, e).then((m) => m && (m.type === "favorites" ? send("favorites", m.data) : send("preferences", m.data)));
    } else if (e.kind === "shortcuts") {
      if (hooks.shortcuts) hooks.shortcuts(e.shortcuts);
      else send("shortcuts", { shortcuts: e.shortcuts });
    } else if (e.kind === "settings") {
      if (hooks.settings) hooks.settings(e.settings);
      else send("appSettings", e.settings);
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
      if (job.kind === "proxy" && job.asset) {
        if (job.state === "running") proxies.jobs[job.asset] = job.progress;
        else delete proxies.jobs[job.asset];
        sendPreparing();
      }
      if (job.state === "done" && job.kind === "waveform") sendWaveforms();
      hooks.other?.(e);
    } else hooks.other?.(e);
  });
  return { unwatch, rev: () => rev, sendWaveforms, proxies };
}
