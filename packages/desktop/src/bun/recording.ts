import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BrowserView, BrowserWindow, GlobalShortcut, Tray } from "electrobun/main";
import { syncKey, type LocalCore, type RecordResult } from "@beacon/core";
import { panelHeight, type PanelState, type RecordSources, type Send, type SettingsPatch } from "@beacon/ui";

/** What recording needs of the app: its core and its window. */
export interface RecordingApp {
  core: LocalCore;
  message: Send;
  status(text: string): void;
  /** The open project, if one is. */
  project(): string | undefined;
  window: Pick<BrowserWindow, "hide" | "show" | "activate">;
  setSettings(patch: SettingsPatch): void;
}

/**
 * Recording: the Record dialog's devices and Check Sync, voice narration over the playing timeline, and a take
 * with its panel and menu-bar item, while Beacon hides.
 */
export function createRecording({ core, message, status, project, window, setSettings }: RecordingApp) {
  /** The Record dialog's last sources, offered next time. */
  const recordPrefs = (): RecordSources => (core.readConfig("record.json") as RecordSources | undefined) ?? { screen: { fps: 60 }, microphone: {}, systemAudio: true };

  /** A 1 kHz beep, 150 ms, for Check Sync to play through the speakers as the screen flashes. */
  function beepFile(): string {
    const path = join(core.cacheDir, "sync-check", "beep.wav");
    if (existsSync(path)) return path;
    const rate = 48_000;
    const n = Math.round(rate * 0.15);
    const wav = Buffer.alloc(44 + n * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + n * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      // 5 ms ramps: no clicks, which would read as a beep starting early.
      const ramp = Math.min(1, i / (rate * 0.005), (n - i) / (rate * 0.005));
      wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * ramp * 0.8 * 32767), 44 + i * 2);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, wav);
    return path;
  }

  /**
   * The Mac's sound through `output` (speakers, when it was going to headphones), at least 75% and unmuted, while
   * `run` runs, so the microphone hears the sync check's beeps over the room; then as it was.
   */
  async function loudly<T>(output: string | undefined, run: () => Promise<T>): Promise<T> {
    const before = output ? (await core.recorderDevices()).outputs.find((o) => o.default)?.id : undefined;
    const switched = !!output && output !== before;
    if (switched) await core.recorderSetOutput(output);
    try {
      return await raised(run);
    } finally {
      if (switched && before) await core.recorderSetOutput(before).catch(() => {});
    }
  }

  async function raised<T>(run: () => Promise<T>): Promise<T> {
    const read = Bun.spawnSync(["/usr/bin/osascript", "-e", "get volume settings"]).stdout.toString();
    const volume = Number(/output volume:(\d+)/.exec(read)?.[1]);
    const muted = /output muted:true/.test(read);
    const raise = Number.isFinite(volume) && (volume < 75 || muted);
    if (raise) Bun.spawnSync(["/usr/bin/osascript", "-e", `set volume output volume ${Math.max(volume, 75)}`, "-e", "set volume without output muted"]);
    try {
      return await run();
    } finally {
      if (raise) Bun.spawnSync(["/usr/bin/osascript", "-e", `set volume output volume ${volume}`, ...(muted ? ["-e", "set volume with output muted"] : [])]);
    }
  }

  /** A test beep at the check's volume, through its speakers. */
  async function testBeep({ output }: { output?: string }) {
    await loudly(output, async () => {
      await Bun.spawn(["/usr/bin/afplay", beepFile()], { stdout: "ignore", stderr: "ignore" }).exited;
      await Bun.sleep(200);
    });
  }

  /** The sync check's window: black over the whole display, flashing white on cue. */
  const FLASH_HTML = `<!doctype html><html><body style="margin:0;background:#000;height:100vh;display:flex;align-items:center;justify-content:center;font:14px -apple-system,sans-serif;color:#666;cursor:none">
  <div>Checking sync: keep the camera seeing the screen</div>
  <script>window.flash=()=>{document.body.style.background="#fff";setTimeout(()=>document.body.style.background="#000",250)}</script></body></html>`;

  /**
   * Check Sync: covers the display in black and flashes it white with a beep six times while the screen, system
   * audio, camera and microphone record, then measures how late the camera is and saves it for the pair.
   */
  async function checkSync({ camera, microphone, display: wanted, output }: { camera: string; microphone: string; display?: number; output?: string }) {
    if (recording) throw new Error("Stop the recording first");
    const devices = await core.recorderDevices();
    if (devices.permissions.screen !== "granted") throw new Error("Check Sync records the screen: allow Beacon in System Settings › Privacy & Security › Screen & System Audio Recording");
    for (const kind of ["camera", "microphone"] as const) {
      if (devices.permissions[kind] !== "granted" && (await core.recorderAccess(kind)) !== "granted") throw new Error(`Allow Beacon in System Settings › Privacy & Security › ${kind === "camera" ? "Camera" : "Microphone"}`);
    }
    const display = devices.displays.find((d) => d.id === wanted) ?? devices.displays[0];
    if (!display) throw new Error("No display to flash (is the screen asleep?)");
    const beep = beepFile();
    const flash = new BrowserWindow({ title: "Beacon Sync Check", html: FLASH_HTML, frame: { x: display.x ?? 0, y: display.y ?? 0, width: display.width, height: display.height }, titleBarStyle: "hidden", activate: false });
    flash.setAlwaysOnTop(true);
    try {
      await Bun.sleep(600);
      const result = await loudly(output, () => core.recordSyncCheck({ screen: { display: display.id, fps: 60 }, systemAudio: true, camera: { id: camera }, microphone: { id: microphone } }, async () => {
        await Bun.sleep(800);
        for (let i = 0; i < 6; i++) {
          flash.webview.executeJavascript("flash()");
          Bun.spawn(["/usr/bin/afplay", beep], { stdout: "ignore", stderr: "ignore" });
          await Bun.sleep(1500);
        }
        await Bun.sleep(400);
      }));
      const key = syncKey(camera, microphone);
      setSettings({ cameraSync: { ...(await core.settings()).cameraSync, [key]: { cameraLateMs: result.cameraLateMs, checked: { at: Date.now(), flashes: result.flashes, spreadMs: result.spreadMs } } } });
      return result;
    } finally {
      flash.close();
    }
  }

  /** Whether Voice Narration plays the timeline's sound while it records, as last chosen. */
  const narrationHear = (): boolean => !!(core.readConfig("narration.json") as { hear?: boolean } | undefined)?.hear;

  /** File › Record… (⌘R) and the Record button, or Tools › Voice Narration… (`narration`). */
  async function recordDialog(mode: import("@beacon/ui").RecordMode = "take") {
    if (!project()) return status("Open a project first");
    if (recording) return status("Already recording: stop from the menu bar or ⌘⇧2");
    if (narrating) return status("Narrating: stop it first");
    message("recordSheet", { ...(await core.recorderDevices()), mode, hear: narrationHear(), sources: recordPrefs(), cameraSync: (await core.settings()).cameraSync ?? {} });
  }

  /** The narration recording over the playing timeline, while it is (Beacon stays in front). */
  let narrating: import("@beacon/ui").Narrating | undefined;

  /** Voice narration: the microphone records while the window plays the timeline from the playhead or through the range. */
  async function startNarration({ microphone, hear }: { microphone: { id?: string }; hear: boolean }) {
    if (!project()) throw new Error("Open a project first");
    if (recording || narrating) throw new Error("Already recording");
    const { permissions } = await core.recorderDevices();
    if (permissions.microphone !== "granted" && (await core.recorderAccess("microphone")) !== "granted") throw new Error("Allow Beacon in System Settings › Privacy & Security › Microphone");
    try {
      core.writeConfig("narration.json", { hear });
      core.writeConfig("record.json", { ...recordPrefs(), microphone });
    } catch {}
    // The take's levels go to the window, for the Narration panel's meter.
    await core.recordStart(project()!, { sources: { microphone }, narrate: { hear }, monitor: (e) => !("devicesChanged" in e) && previewEvent(e, (p) => message("recordPreview", p)) });
    // Set before anything else is awaited: a narration that ends at once (`narrated`) must find it to end it.
    const now: import("@beacon/ui").Narrating = { started: Date.now(), from: 0, until: 0 };
    narrating = now;
    GlobalShortcut.register(STOP_SHORTCUT, () => void stopNarration({}));
    const span = (await core.recordStatus()).narration;
    if (narrating !== now) return;
    const shown = { ...now, from: span?.from ?? 0, until: span?.until ?? 0 };
    narrating = shown;
    message("narrating", shown);
  }

  /** Stop or Discard: core then reports the narration ended (`narrated`), as it does when the range runs out. */
  async function stopNarration({ discard }: { discard?: boolean }) {
    if (!narrating) return;
    try {
      await core.recordStop(discard ? { discard } : {});
    } catch (e) {
      narrationEnded();
      throw e;
    }
  }

  /** The narration is over, however it ended: the window stops showing it. */
  function narrationEnded(result?: RecordResult) {
    if (!narrating) return;
    narrating = undefined;
    GlobalShortcut.unregister(STOP_SHORTCUT);
    message("narrating", null);
    if (result) status(result.discarded ? "Narration discarded" : `Narration recorded (${clock(result.duration)}) on a new track`);
  }

  const STOP_SHORTCUT = "CommandOrControl+Shift+2";
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  let recording: { tray: Tray; timer: ReturnType<typeof setInterval>; panel?: BrowserWindow; panelShown: boolean } | undefined;

  /**
   * The newest preview frames, for the Record dialog and the recording panel to pull (`recordFrames`): pushing each
   * one let a slow page fall behind and show the camera late.
   */
  const frames: import("@beacon/ui").RecordFrames & { at: { camera: number; screen: number } } = { seq: 0, at: { camera: 0, screen: 0 } };
  let frameWaiters: (() => void)[] = [];

  /** A frame goes to the store and wakes whoever waits; levels are pushed to `send`. */
  function previewEvent(e: import("@beacon/ui").RecordPreview, send: ((e: import("@beacon/ui").RecordPreview) => void) | undefined) {
    if (!("jpeg" in e)) return send?.(e);
    frames[e.source] = e.jpeg;
    frames.at[e.source] = ++frames.seq;
    for (const wake of frameWaiters.splice(0)) wake();
  }

  /** Frames newer than `after`, once there are some or a second has passed. */
  async function newerFrames(after: number): Promise<import("@beacon/ui").RecordFrames> {
    if (frames.seq <= after) await new Promise<void>((wake) => (frameWaiters.push(wake), setTimeout(wake, 1000)));
    return {
      seq: frames.seq,
      ...(frames.at.camera > after && frames.camera ? { camera: frames.camera } : {}),
      ...(frames.at.screen > after && frames.screen ? { screen: frames.screen } : {}),
    };
  }

  function clearFrames() {
    delete frames.camera;
    delete frames.screen;
  }

  /** The recording panel's title: the recorder leaves the window with it out of the take. */
  const PANEL_TITLE = "Beacon Recording Panel";
  const PANEL_WIDTH = 300;
  let panelState: PanelState | undefined;
  /** The panel's webview, once it has loaded: the take's frames and levels go to it. */
  let panelSend: ((e: import("@beacon/ui").RecordPreview) => void) | undefined;

  /**
   * The small window over the screen while a take records: its camera, time, levels and Stop, not recorded.
   * Resolves once its page has loaded (or after 2 s), so ScreenCaptureKit lists the window to leave out.
   */
  async function openPanel(state: PanelState, display: { width: number } | undefined) {
    panelState = state;
    let loaded!: () => void;
    const ready = new Promise<void>((r) => (loaded = r));
    const rpc = BrowserView.defineRPC<import("@beacon/ui").PanelRPC>({
      handlers: {
        requests: {
          panelInit: async () => {
            loaded();
            return panelState ?? null;
          },
        },
        messages: {
          stopRecording: () => void stopRecording(),
          hidePanel: () => showPanel(false),
        },
      },
    });
    const height = Math.round(panelHeight(state));
    const panel = new BrowserWindow({
      title: PANEL_TITLE,
      url: "views://recordpanel/index.html",
      rpc,
      frame: { x: Math.max(0, (display?.width ?? 1440) - PANEL_WIDTH - 24), y: 48, width: PANEL_WIDTH, height },
      titleBarStyle: "hidden",
      transparent: true,
      activate: false,
    });
    panel.setAlwaysOnTop(true);
    panel.setVisibleOnAllWorkspaces(true);
    panelSend = (e) => panel.webview.rpc?.send.recordPreview(e);
    await Promise.race([ready, Bun.sleep(2000)]);
    return panel;
  }

  /** Record: Beacon hides while the take records; a menu-bar item shows the time and stops it, as ⌘⇧2 does. */
  async function startRecording({ sources }: { sources: RecordSources }) {
    if (!project()) throw new Error("Open a project first");
    if (recording) throw new Error("Already recording");
    // Asked while the window is up, so macOS's prompt has somewhere to show.
    const devices = await core.recorderDevices();
    const { permissions } = devices;
    for (const kind of ["camera", "microphone"] as const) {
      if (!sources[kind] || permissions[kind] === "granted") continue;
      if ((await core.recorderAccess(kind)) !== "granted") throw new Error(`Allow Beacon in System Settings › Privacy & Security › ${kind === "camera" ? "Camera" : "Microphone"}`);
    }
    try {
      core.writeConfig("record.json", sources);
    } catch {}
    window.hide();
    const panelSources = { screen: !!sources.screen, camera: !!sources.camera, microphone: !!sources.microphone, systemAudio: !!sources.systemAudio };
    // Opened first, so the recorder can leave it out of the take by its title.
    const display = devices.displays.find((d) => d.id === sources.screen?.display) ?? devices.displays[0];
    clearFrames();
    const panel = await openPanel({ started: Date.now(), ...panelSources }, display);
    try {
      await core.recordStart(project()!, {
        sources: sources.screen ? { ...sources, screen: { ...sources.screen, exclude: PANEL_TITLE } } : sources,
        monitor: (e) => !("devicesChanged" in e) && previewEvent(e, panelSend),
      });
    } catch (e) {
      panel.close();
      panelSend = undefined;
      panelState = undefined;
      window.show();
      throw e;
    }
    // The take begins once its sources deliver, a moment after the panel opened.
    if (panelState) {
      panelState.started = Date.now();
      panel.webview.rpc?.send.recordStarted({ started: panelState.started });
    }
    const tray = new Tray({ title: "● 0:00" });
    tray.on("tray-clicked", (e) => {
      const action = (e as { data?: { action?: string } }).data?.action;
      if (action === "stopRecording") void stopRecording();
      else if (action === "showPanel") showPanel(true);
      else if (action === "hidePanel") showPanel(false);
    });
    const started = Date.now();
    const timer = setInterval(() => tray.setTitle(`● ${clock((Date.now() - started) / 1000)}`), 1000);
    GlobalShortcut.register(STOP_SHORTCUT, () => void stopRecording());
    recording = { tray, timer, panel, panelShown: true };
    trayMenu();
  }

  /** The menu-bar item's menu: the panel's Show or Hide, and Stop. */
  function trayMenu() {
    const r = recording;
    if (!r) return;
    r.tray.setMenu([
      { type: "normal", label: r.panelShown ? "Hide Recording Panel" : "Show Recording Panel", action: r.panelShown ? "hidePanel" : "showPanel" },
      { type: "separator" },
      { type: "normal", label: "Stop Recording  (⌘⇧2)", action: "stopRecording" },
    ]);
  }

  /** Hidden, the panel stops covering the screen and the take carries on; the menu-bar item brings it back. */
  function showPanel(shown: boolean) {
    const r = recording;
    if (!r?.panel || r.panelShown === shown) return;
    if (shown) r.panel.showInactive();
    else r.panel.hide();
    r.panelShown = shown;
    trayMenu();
  }

  /** Stops the take, imports it at the end of the timeline and brings Beacon back. */
  async function stopRecording() {
    const r = recording;
    if (!r) return;
    recording = undefined;
    clearInterval(r.timer);
    GlobalShortcut.unregister(STOP_SHORTCUT);
    r.tray.remove();
    r.panel?.close();
    panelSend = undefined;
    panelState = undefined;
    try {
      const take = await core.recordStop();
      status(`Recorded ${basename(take.take, ".brec")} (${clock(take.duration)})`);
      if (take.assets[0]) message("recordedSheet", { asset: take.assets[0], name: basename(take.take, ".brec"), duration: take.duration });
    } catch (e) {
      status(e instanceof Error ? e.message : String(e));
    } finally {
      window.show();
      window.activate();
    }
  }

  return {
    checkSync,
    clearFrames,
    narrationEnded,
    narrationHear,
    newerFrames,
    previewEvent,
    recordDialog,
    recordPrefs,
    startNarration,
    startRecording,
    stopNarration,
    stopRecording,
    testBeep,
  };
}
