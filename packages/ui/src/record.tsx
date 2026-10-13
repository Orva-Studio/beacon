import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, Select, SettingsRow as Row } from "./controls";
import type { RecordSheet, RecordSources } from "./rpc";
import { replica, useView } from "./store";

export interface RecordHost {
  startRecording(sources: RecordSources): Promise<{ ok: boolean; error?: string }>;
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
        </Source>
        <Source label="System audio" on={!!s.systemAudio} setOn={(on) => setS({ ...s, systemAudio: on || undefined })} />
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

export function RecordUi({ host }: { host: RecordHost }) {
  const sheet = useView((v) => v.recordSheet);
  return sheet ? <RecordDialog sheet={sheet} host={host} /> : null;
}
