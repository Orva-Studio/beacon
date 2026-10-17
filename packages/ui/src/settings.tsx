import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type Project } from "@beacon/model";
import { Button, Check, Modal, Select, SettingsRow as Row } from "./controls";
import { CanvasSettings } from "./canvas-settings";
import { syncKey, type AppSettings, type CameraSync, type RecordDevices, type SettingsSheet, type SettingsTab } from "./rpc";
import { CameraSyncControl, type SyncCheckHost } from "./sync-check";
import { replica, useView } from "./store";
import { TranscriptsSettings, type TranscriptsHost } from "./transcripts-settings";
import { ShortcutsSettings, type ShortcutsHost } from "./shortcuts-settings";

export interface SettingsHost extends SyncCheckHost, TranscriptsHost, ShortcutsHost {
  run(command: string, args?: unknown, label?: string): void;
  setAppSettings(settings: AppSettings): void;
  proxySpace(): Promise<number>;
  deleteAllProxies(): Promise<number>;
  chooseFolder(start: string): Promise<string | null>;
}

const space = (bytes: number) =>
  bytes === 0 ? "No proxy videos" : `${bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1)} GB`} used`;

const LOUDNESS = DEFAULT_SETTINGS.loudnessTarget!;

/** The app settings in a Settings sheet, without what it opened with (tab, devices…). */
const pick = ({ tab: _, devices: __, resources: ___, preferences: ____, ...app }: SettingsSheet): AppSettings => app;

/**
 * Beacon > Settings… (⌘,). General is app-wide; Project changes the open project through
 * `project.settings.set`, so it is undoable and agents can do the same.
 */
export function SettingsWindow({ app: { tab: opening, devices, resources, preferences, ...app }, project, host }: { app: SettingsSheet; project?: Project; host: SettingsHost }) {
  const [tab, setTab] = useState<SettingsTab>(opening ?? "general");
  const [settings, setSettings] = useState<AppSettings>(app);
  // Changed elsewhere while open (an agent, Check Sync): shown here.
  const sheet = useView((v) => v.settings);
  useEffect(() => {
    if (sheet) setSettings(({ ...mine }) => ({ ...mine, ...pick(sheet) }));
  }, [sheet]);
  const [proxySpace, setProxySpace] = useState<number | "deleting">();
  useEffect(() => void host.proxySpace().then(setProxySpace), [host]);
  const update = (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    host.setAppSettings(next);
  };
  const close = () => replica.settings(undefined);
  const transcriber = preferences?.find((p) => p.id === "transcriber");
  const s = project?.settings;
  const tabs = (["general", "recording", "shortcuts", "project"] as const).map((t) => (
    <button key={t} className={`rounded-md px-3 py-1 capitalize ${tab === t ? "bg-control text-text-strong" : "text-text-muted hover:text-text-strong"}`} onClick={() => setTab(t)}>
      {t}
    </button>
  ));
  return (
    <Modal title="Settings" header={tabs} width={580} onClose={close}>
      {tab === "general" && (
        <div className="flex flex-col gap-3">
          <Row label="Export Color Space" hint="BT.709 is the video standard; with sRGB, QuickTime shows it as the editor does.">
            <div className="w-56">
              <Select value={settings.exportColorSpace} onChange={(e) => update({ exportColorSpace: e.target.value as AppSettings["exportColorSpace"] })}>
                <option value="bt709">BT.709</option>
                <option value="srgb">sRGB</option>
              </Select>
            </div>
          </Row>
          <Row label="Save Snapshots To" hint="Snapshot (the camera in the timeline's toolbar) saves the frame at the playhead as a PNG here and adds it to the Media Bin.">
            <div className="flex min-w-0 items-center gap-2" data-snapshot-folder>
              <span className="min-w-0 flex-1 truncate text-text" title={settings.snapshotFolder ?? "The project's media folder"}>
                {settings.snapshotFolder ? settings.snapshotFolder.replace(/^\/Users\/[^/]+/, "~") : "The project's media folder"}
              </span>
              <Button onClick={async () => {
                const folder = await host.chooseFolder(settings.snapshotFolder ?? "~/Pictures");
                if (folder) update({ snapshotFolder: folder });
              }}>
                Choose…
              </Button>
              {settings.snapshotFolder && (
                <Button look="quiet" title="Save snapshots in the project's media folder again" onClick={() => update({ snapshotFolder: undefined })}>
                  Use Project
                </Button>
              )}
            </div>
          </Row>
          <Row label="Make Proxies For" hint="Quick-to-seek copies made in the background, so scrubbing is fast. Unticked: only from Proxy Video in Media's menu.">
            <div className="flex flex-col gap-1.5" data-auto-proxy>
              {(
                [
                  ["recording", "Screen recordings"],
                  ["video", "Video files"],
                ] as const
              ).map(([kind, label]) => (
                <Check key={kind} label={label} checked={settings.autoProxy[kind]} onChange={(on) => update({ autoProxy: { ...settings.autoProxy, [kind]: on } })} />
              ))}
            </div>
          </Row>
          <Row label="Build Proxies" hint="Quietly: one at a time at background priority, so the fans stay off. Fast: two at once.">
            <div className="w-56">
              <Select data-proxy-mode value={settings.proxyMode} onChange={(e) => update({ proxyMode: e.target.value as AppSettings["proxyMode"] })}>
                <option value="quiet">Quietly</option>
                <option value="fast">Fast</option>
              </Select>
            </div>
          </Row>
          {transcriber && <TranscriptsSettings pref={transcriber} model={resources?.find((r) => r.id === "whisper-model")} close={close} host={host} />}
          <Row label="Proxy Videos" hint="Every project's; open projects make theirs again when next opened.">
            <div className="flex items-center gap-3" data-proxy-space>
              <Button
                disabled={proxySpace === "deleting" || !proxySpace}
                onClick={() => {
                  setProxySpace("deleting");
                  void host.deleteAllProxies().then(setProxySpace);
                }}
              >
                Delete All Proxy Videos
              </Button>
              <span className="text-text-muted">{proxySpace === undefined ? "" : proxySpace === "deleting" ? "Deleting…" : space(proxySpace)}</span>
            </div>
          </Row>
        </div>
      )}
      {tab === "recording" && <RecordingSettings devices={devices} settings={settings} update={update} host={host} />}
      {tab === "shortcuts" && <ShortcutsSettings host={host} />}
      {tab === "project" &&
        (s ? (
          <CanvasSettings
            value={{ width: s.width, height: s.height, fps: s.fps.num / s.fps.den, background: s.background, normalize: s.loudnessTarget !== undefined }}
            onChange={({ width, height, fps, background, normalize }, label) =>
              host.run(
                "project.settings.set",
                {
                  ...(width !== undefined ? { width, height } : {}),
                  ...(fps !== undefined ? { fps: { num: fps, den: 1 } } : {}),
                  ...(background !== undefined ? { background } : {}),
                  ...(normalize !== undefined ? { loudnessTarget: normalize ? LOUDNESS : null } : {}),
                },
                label,
              )
            }
          />
        ) : (
          <p className="text-text-faint">Open a project to change its settings.</p>
        ))}
      <div className="mt-5 flex justify-end">
        <Button look="primary" onClick={close}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

export function SettingsUi({ host }: { host: SettingsHost }) {
  const app = useView((v) => v.settings);
  const project = useView((v) => v.project);
  return app ? <SettingsWindow app={app} project={project} host={host} /> : null;
}

/**
 * Settings › Recording: a camera and microphone pair's delay, typed or measured by Check Sync, saved for the pair.
 * It replaces delaying the microphone live: moving the camera earlier keeps the voice in step with the screen too.
 */
function RecordingSettings({ devices, settings, update, host }: { devices?: RecordDevices; settings: AppSettings; update: (patch: Partial<AppSettings>) => void; host: SyncCheckHost }) {
  const [camera, setCamera] = useState(devices?.camera ?? devices?.cameras[0]?.id);
  const [microphone, setMicrophone] = useState(devices?.microphone ?? devices?.microphones[0]?.id);
  if (!devices?.cameras.length || !devices.microphones.length) return <div className="text-text-faint">Connect a camera and a microphone to set how they line up.</div>;
  const key = syncKey(camera, microphone);
  const save = (sync: CameraSync) => update({ cameraSync: { ...settings.cameraSync, [key]: sync } });
  return (
    <div className="flex flex-col gap-3" data-recording-settings>
      <Row label="Camera">
        <Select value={camera} onChange={(e) => setCamera(e.target.value)}>
          {devices.cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Microphone">
        <Select value={microphone} onChange={(e) => setMicrophone(e.target.value)}>
          {devices.microphones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Sync" hint="A camera through a capture card shows its picture late. Each take recorded with this pair moves its camera clip earlier by this much, so lips match the voice.">
        <div className="min-w-0 flex-1">
          <CameraSyncControl
            key={key}
            sync={settings.cameraSync?.[key]}
            onChange={save}
            host={host}
            devices={{
              camera: devices.cameras.find((c) => c.id === camera) ?? { id: camera!, name: camera! },
              microphone: devices.microphones.find((m) => m.id === microphone) ?? { id: microphone!, name: microphone! },
              displays: devices.displays,
              display: devices.display,
              outputs: devices.outputs,
            }}
          />
        </div>
      </Row>
    </div>
  );
}
