import { useEffect, useState } from "react";
import { Button, Check, DeviceSelect, Modal, Select, SettingsRow as Row } from "./controls";
import { AiSettings, type WaitingChoice } from "./ai-settings";
import { syncKey, withPatch, type AppSettings, type CameraSync, type RecordDevices, type SettingsPatch, type SettingsSheet, type SettingsTab } from "./rpc";
import { CameraSyncControl, type SyncCheckHost } from "./sync-check";
import { replica, useView } from "./store";
import { TranscriptsSettings, type TranscriptsHost } from "./transcripts-settings";
import { ShortcutsSettings, type ShortcutsHost } from "./shortcuts-settings";

export interface SettingsHost extends SyncCheckHost, TranscriptsHost, ShortcutsHost {
  run(command: string, args?: unknown, label?: string): void;
  setAppSettings(patch: SettingsPatch): void;
  proxySpace(): Promise<number>;
  deleteAllProxies(): Promise<number>;
  chooseFolder(start: string): Promise<string | null>;
}

const space = (bytes: number) =>
  bytes === 0 ? "No proxy videos" : `${bytes < 1e6 ? `${Math.ceil(bytes / 1e3)} KB` : bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1)} GB`} used`;


/** The app settings in a Settings sheet, without what it opened with (tab, devices…). */
const pick = ({ tab: _, devices: __, resources: ___, preferences: ____, secrets: _____, ...app }: SettingsSheet): AppSettings => app;

/** Settings' sections, down its sidebar. */
const SECTIONS: { id: SettingsTab; title: string }[] = [
  { id: "general", title: "General" },
  { id: "recording", title: "Recording" },
  { id: "transcripts", title: "Transcripts" },
  { id: "ai", title: "AI" },
  { id: "shortcuts", title: "Shortcuts" },
];

/** Settings' height: the same for every section, which scrolls inside it, so switching never resizes the window. */
const HEIGHT = 500;

/**
 * Beacon > Settings… (⌘,): app-wide, in sections down a sidebar as System Settings has them. The project's own
 * settings are Project Settings (`project-settings.tsx`).
 */
function SettingsWindow({ app: { tab: opening, devices, resources, preferences, secrets, ...app }, host }: { app: SettingsSheet; host: SettingsHost }) {
  const [tab, setTab] = useState<SettingsTab>(opening ?? "general");
  const [settings, setSettings] = useState<AppSettings>(app);
  // Changed elsewhere while open (an agent, Check Sync): shown here.
  const sheet = useView((v) => v.settings);
  useEffect(() => {
    if (sheet) setSettings(({ ...mine }) => ({ ...mine, ...pick(sheet) }));
  }, [sheet]);
  const [proxySpace, setProxySpace] = useState<number | "deleting">();
  useEffect(() => void host.proxySpace().then(setProxySpace), [host]);
  // Only what changed is sent, so a change made elsewhere meanwhile (an agent) isn't written back over.
  const update = (patch: SettingsPatch) => {
    setSettings((mine) => withPatch(mine, patch));
    host.setAppSettings(patch);
  };
  const close = () => replica.settings(undefined);
  const [prefs, setPrefs] = useState(preferences);
  const transcriber = prefs?.find((p) => p.id === "transcriber");
  const judge = prefs?.find((p) => p.id === "retake-judge");
  const [waiting, setWaiting] = useState<WaitingChoice>();
  const [keys, setKeys] = useState(secrets);
  // A choice whose key isn't set: the key is added in AI, which then makes the choice and comes back here.
  const askKey = (from: SettingsTab) => (pref: string, value: string) => {
    const secret = prefs?.find((p) => p.id === pref)?.options.find((o) => o.id === value)?.secret?.id;
    if (!secret) return;
    setWaiting({ pref, value, secret, back: () => (setWaiting(undefined), setTab(from)) });
    setTab("ai");
  };
  return (
    <Modal title="Settings" width={760} onClose={close}>
      <div className="flex gap-4" style={{ height: HEIGHT }} data-settings-window>
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-divider pr-3" data-settings-nav>
          {SECTIONS.map((x) => (
            <button key={x.id} className={`rounded-md px-3 py-1.5 text-left ${tab === x.id ? "bg-control text-text-strong" : "text-text-muted hover:bg-item-hover hover:text-text-strong"}`} onClick={() => setTab(x.id)} data-section={x.id}>
              {x.title}
            </button>
          ))}
        </nav>
        <div className={`min-w-0 flex-1 pr-1 ${tab === "shortcuts" ? "flex flex-col" : "overflow-y-auto"}`} data-settings-section={tab}>
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
                    <Button look="quiet" title="Save snapshots in the project's media folder again" onClick={() => update({ snapshotFolder: null })}>
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
          {tab === "transcripts" && (
            <div className="flex flex-col gap-3">
              {transcriber && (
                <TranscriptsSettings
                  pref={transcriber}
                  label="Transcriber"
                  offline="Apple's transcriber works offline, and Whisper on this Mac once its speech model is downloaded."
                  model={resources?.find((r) => r.id === "whisper-model")}
                  close={close}
                  host={host}
                  changed={setPrefs}
                  askKey={askKey("transcripts")}
                />
              )}
              {judge && <TranscriptsSettings pref={judge} label="Best Take" sends="The words of each line said more than once are sent to OpenAI (not the audio)" offline="Beacon's own scoring works offline." close={close} host={host} changed={setPrefs} askKey={askKey("transcripts")} />}
            </div>
          )}
          {tab === "ai" && prefs && keys && (
            <AiSettings prefs={prefs} secrets={keys} host={host} changed={setPrefs} keySet={(id, set) => setKeys((all) => all?.map((k) => (k.id === id ? { ...k, set } : k)))} waiting={waiting} />
          )}
          {tab === "shortcuts" && <ShortcutsSettings host={host} />}
        </div>
      </div>
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
  return app ? <SettingsWindow app={app} host={host} /> : null;
}

/**
 * Settings › Recording: a camera and microphone pair's delay, typed or measured by Check Sync, saved for the pair.
 * It replaces delaying the microphone live: moving the camera earlier keeps the voice in step with the screen too.
 */
function RecordingSettings({ devices, settings, update, host }: { devices?: RecordDevices; settings: AppSettings; update: (patch: SettingsPatch) => void; host: SyncCheckHost }) {
  const [camera, setCamera] = useState(devices?.camera ?? devices?.cameras[0]?.id);
  const [microphone, setMicrophone] = useState(devices?.microphone ?? devices?.microphones[0]?.id);
  if (!devices?.cameras.length || !devices.microphones.length) return <div className="text-text-faint">Connect a camera and a microphone to set how they line up.</div>;
  const key = syncKey(camera, microphone);
  const save = (sync: CameraSync) => update({ cameraSync: { ...settings.cameraSync, [key]: sync } });
  return (
    <div className="flex flex-col gap-3" data-recording-settings>
      <Row label="Camera">
        <DeviceSelect devices={devices.cameras} value={camera} onChange={setCamera} />
      </Row>
      <Row label="Microphone">
        <DeviceSelect devices={devices.microphones} value={microphone} onChange={setMicrophone} />
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
