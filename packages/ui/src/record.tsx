import { useEffect, useState, type ReactNode } from "react";
import { Button, Icon, LevelMeter, Modal, Select, SettingsRow as Row, TextInput, type IconName } from "./controls";
import type { AudioLevel, RecordedSheet, RecordFrames, RecordPreview, RecordSheet, RecordSources } from "./rpc";
import { replica, useView } from "./store";

export interface RecordHost {
  startRecording(sources: RecordSources): Promise<{ ok: boolean; error?: string }>;
  /** Shows the sources (`recordPreviewEvent` gets their levels, `recordFrames` their frames); with none, stops. */
  recordPreview(sources: RecordSources): void;
  recordFrames(after: number): Promise<RecordFrames>;
  run(command: string, args?: unknown, label?: string): void;
}

/**
 * The newest camera and screen frames while `on`, pulled one request at a time: each waits for the next frame,
 * so a busy page skips frames rather than falling behind.
 */
export function useRecordFrames(pull: (after: number) => Promise<RecordFrames>, on: boolean) {
  const [frames, setFrames] = useState<{ camera?: string; screen?: string }>({});
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void (async () => {
      let after = 0;
      while (alive) {
        try {
          const f = await pull(after);
          if (!alive) break;
          after = f.seq;
          if (f.camera || f.screen) setFrames((p) => ({ ...p, ...(f.camera ? { camera: f.camera } : {}), ...(f.screen ? { screen: f.screen } : {}) }));
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => {
      alive = false;
      setFrames({});
    };
  }, [on]);
  return frames;
}

export const previewListeners = new Set<(e: RecordPreview) => void>();

/** A frame or the audio levels, for the open Record dialog or the recording panel. */
export function recordPreviewEvent(e: RecordPreview) {
  for (const l of previewListeners) l(e);
}

const COUNTDOWN = 3;

/** Where a permission that isn't granted is given. */
const SETTINGS: Record<"screen" | "camera" | "microphone", string> = {
  screen: "Screen & System Audio Recording",
  camera: "Camera",
  microphone: "Microphone",
};

/** Where to give a permission that was refused, under its source. */
function permission(kind: keyof typeof SETTINGS, status: string): ReactNode {
  if (status === "granted" || status === "not asked") return undefined;
  return (
    <span className="text-warning" data-permission={kind}>
      Allow Beacon in System Settings › Privacy & Security › {SETTINGS[kind]}
    </span>
  );
}

/** A source's live picture, or what it would show and why it doesn't. */
function Monitor({ label, icon, jpeg, mirrored, why, className }: { label: string; icon: IconName; jpeg?: string; mirrored?: boolean; why?: string; className: string }) {
  return (
    <figure className={`flex flex-col gap-1 ${className}`}>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-groove ring-1 ring-white/5">
        {jpeg && !why ? (
          // Mirrored, as a self-view is; the take isn't.
          <img src={`data:image/jpeg;base64,${jpeg}`} alt={`${label} preview`} className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""}`} data-preview={label} />
        ) : (
          <span className="flex flex-col items-center gap-1 text-caption text-text-faint">
            <Icon name={icon} size={18} />
            {why}
          </span>
        )}
      </div>
      <figcaption className="text-caption text-text-muted">{label}</figcaption>
    </figure>
  );
}

/** A source's row: its name, a checkbox, and what to record from. */
function Source({ label, on, setOn, hint, children }: { label: string; on: boolean; setOn: (on: boolean) => void; hint?: ReactNode; children?: ReactNode }) {
  return (
    <Row label={label} hint={on ? hint : undefined}>
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => setOn(e.target.checked)} data-source={label} />
      {on && children}
    </Row>
  );
}

/** File > Record…: what to record, then a countdown; Beacon then hides and its menu-bar item stops the take. */
export function RecordDialog({ sheet, host }: { sheet: RecordSheet; host: RecordHost }) {
  const [s, setS] = useState<RecordSources>(sheet.sources);
  const [counting, setCounting] = useState<number>();
  const [error, setError] = useState<string>();
  const close = () => replica.recordSheet(undefined);
  const nothing = !s.screen && !s.systemAudio && !s.camera && !s.microphone;
  const [levels, setLevels] = useState<{ microphone?: AudioLevel; systemAudio?: AudioLevel }>({});

  // Only what Beacon may already use: asking for a permission waits for Record.
  const granted = (k: keyof RecordSheet["permissions"]) => sheet.permissions[k] === "granted";
  const screen = granted("screen") ? s.screen : undefined;
  const systemAudio = granted("screen") ? s.systemAudio : undefined;
  const camera = granted("camera") ? s.camera : undefined;
  const microphone = granted("microphone") ? s.microphone : undefined;
  const previewing = !!(screen || camera);
  const frames = useRecordFrames(host.recordFrames, previewing && counting === undefined);
  useEffect(() => {
    setLevels({});
    const listen = (e: RecordPreview) => !("jpeg" in e) && setLevels(e);
    previewListeners.add(listen);
    host.recordPreview({
      ...(screen ? { screen: { display: screen.display } } : {}),
      ...(systemAudio ? { systemAudio } : {}),
      ...(camera ? { camera } : {}),
      ...(microphone ? { microphone } : {}),
    });
    return () => {
      previewListeners.delete(listen);
      host.recordPreview({});
    };
  }, [!!screen, screen?.display, !!systemAudio, !!camera, camera?.id, !!microphone, microphone?.id]);
  const why = (on: unknown, kind: keyof RecordSheet["permissions"]) => (!on ? "Off" : !granted(kind) ? "Needs permission" : undefined);

  useEffect(() => {
    if (counting === undefined) return;
    if (counting > 0) {
      const t = setTimeout(() => setCounting(counting - 1), 1000);
      return () => clearTimeout(t);
    }
    void host.startRecording(s).then((r) => {
      if (r.ok) return close();
      setCounting(undefined);
      setError(r.error);
    });
  }, [counting]);

  const display = (id: number | undefined) => sheet.displays.find((d) => d.id === id) ?? sheet.displays[0];
  if (counting !== undefined) {
    return (
      <Modal title="Record" width={360} onClose={() => setCounting(undefined)}>
        <div className="flex flex-col items-center gap-2 py-6" data-countdown>
          <div className="text-6xl font-semibold tabular-nums text-text-strong">{Math.max(counting, 1)}</div>
          <div className="text-text-muted">Beacon hides while you record. Stop from the menu bar or ⌘⇧2.</div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => setCounting(undefined)}>Cancel</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Record" width={560} onClose={close} onEnter={() => !nothing && setCounting(COUNTDOWN)}>
      <div className="mb-4 flex gap-3" data-record-monitors>
        <Monitor label="Screen" icon="monitor-play" jpeg={frames.screen} why={why(s.screen, "screen")} className="flex-[1.6]" />
        <Monitor label="Camera" icon="video-camera" jpeg={frames.camera} mirrored why={why(s.camera, "camera")} className="flex-1" />
      </div>
      <div className="flex flex-col gap-3" data-record>
        <Source label="Screen" hint={permission("screen", sheet.permissions.screen)} on={!!s.screen} setOn={(on) => setS({ ...s, screen: on ? { display: display(undefined)?.id, fps: 60 } : undefined })}>
          <div className="w-56">
            <Select value={display(s.screen?.display)?.id ?? ""} onChange={(e) => setS({ ...s, screen: { ...s.screen, display: Number(e.target.value) } })}>
              {sheet.displays.map((d, i) => (
                <option key={d.id} value={d.id}>
                  Display {i + 1} ({d.width} × {d.height})
                </option>
              ))}
            </Select>
          </div>
          <div className="w-24">
            <Select value={s.screen?.fps ?? 60} onChange={(e) => setS({ ...s, screen: { ...s.screen, fps: Number(e.target.value) } })}>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps</option>
            </Select>
          </div>
        </Source>
        <Source label="Camera" hint={permission("camera", sheet.permissions.camera)} on={!!s.camera} setOn={(on) => setS({ ...s, camera: on ? { id: sheet.cameras[0]?.id } : undefined })}>
          <div className="w-72">
            <Select value={s.camera?.id ?? ""} onChange={(e) => setS({ ...s, camera: { id: e.target.value } })}>
              {sheet.cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </Source>
        <Source label="Microphone" hint={permission("microphone", sheet.permissions.microphone)} on={!!s.microphone} setOn={(on) => setS({ ...s, microphone: on ? { id: sheet.microphones[0]?.id } : undefined })}>
          <div className="w-72">
            <Select value={s.microphone?.id ?? ""} onChange={(e) => setS({ ...s, microphone: { id: e.target.value } })}>
              {sheet.microphones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          {microphone && <LevelMeter label="Microphone level" db={levels.microphone?.db} peak={levels.microphone?.peak} />}
        </Source>
        <Source label="System audio" on={!!s.systemAudio} setOn={(on) => setS({ ...s, systemAudio: on || undefined })}>
          {systemAudio && <LevelMeter label="System audio level" db={levels.systemAudio?.db} peak={levels.systemAudio?.peak} />}
        </Source>
      </div>
      {error && <div className="mt-4 text-danger">{error}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={nothing} onClick={() => setCounting(COUNTDOWN)} data-record-start>
          Record
        </Button>
      </div>
    </Modal>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** After a take: its name (the date and time) selected to type over; Enter keeps what is typed, Esc the name it has. */
function RecordedDialog({ sheet, host }: { sheet: RecordedSheet; host: RecordHost }) {
  const [name, setName] = useState(sheet.name);
  const close = () => replica.recordedSheet(undefined);
  const save = () => {
    const n = name.trim();
    if (n && n !== sheet.name) host.run("asset.rename", { asset: sheet.asset, name: n }, "Rename Recording");
    close();
  };
  return (
    <Modal title="Name the Recording" width={420} onClose={close} onEnter={save}>
      <div className="flex flex-col gap-2" data-recorded>
        <TextInput
          value={name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          aria-label="Recording name"
          data-recorded-name
        />
        <div className="text-caption text-text-muted">{clock(sheet.duration)} recorded, at the end of the timeline. The name shows in the Media Bin and on its clips.</div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Skip</Button>
        <Button look="primary" onClick={save} data-recorded-save>
          Save
        </Button>
      </div>
    </Modal>
  );
}

export function RecordUi({ host }: { host: RecordHost }) {
  const sheet = useView((v) => v.recordSheet);
  const recorded = useView((v) => v.recordedSheet);
  if (sheet) return <RecordDialog sheet={sheet} host={host} />;
  return recorded ? <RecordedDialog key={recorded.asset} sheet={recorded} host={host} /> : null;
}
