import { useEffect, useRef, useState } from "react";
import { Button, Icon, LevelMeter, Modal, NumberBox, Select, SettingsRow as Row } from "./controls";
import { previewListeners, useRecordFrames } from "./record-preview";
import type { AudioLevel, CameraSync, RecordFrames, RecordPreview, RecordSources, SyncCheck } from "./rpc";

export interface SyncCheckHost {
  checkSync(camera: string, microphone: string, display?: number): Promise<{ ok: boolean; result?: SyncCheck; error?: string }>;
  testBeep(): Promise<void>;
  recordPreview(sources: RecordSources): void;
  recordFrames(after: number): Promise<RecordFrames>;
}

/** The devices a sync check uses: the pair, and the displays it can flash. */
export interface SyncDevices {
  camera: { id: string; name: string };
  microphone: { id: string; name: string };
  displays: { id: number; width: number; height: number }[];
  /** The display to flash first: the one recorded. */
  display?: number;
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A beep is heard when the microphone's peak comes this close to full scale. */
const HEARD_DB = -35;

/**
 * Check Sync's dialog: first what to do (a live view of the camera being measured, its microphone's level, the
 * screen to flash, a test beep), then the check (the screen flashes white and beeps six times), then the result.
 * The flash is the clap: the camera sees its light on the room as the microphone hears the beep.
 */
function SyncCheckDialog({ devices, host, onClose, onMeasured }: { devices: SyncDevices; host: SyncCheckHost; onClose: () => void; onMeasured: (r: SyncCheck) => void }) {
  const [display, setDisplay] = useState(devices.display ?? devices.displays[0]?.id);
  const [step, setStep] = useState<"setup" | "checking" | { result: SyncCheck } | { error: string }>("setup");
  const [level, setLevel] = useState<AudioLevel>();
  const [beep, setBeep] = useState<"playing" | "heard" | "missed">();
  const loudest = useRef(-120);
  const previewing = step === "setup";
  const { camera } = useRecordFrames(host.recordFrames, previewing);
  useEffect(() => {
    if (!previewing) return;
    const listen = (e: RecordPreview) => {
      if ("jpeg" in e || !e.microphone) return;
      setLevel(e.microphone);
      loudest.current = Math.max(loudest.current, e.microphone.peak);
    };
    previewListeners.add(listen);
    host.recordPreview({ camera: { id: devices.camera.id }, microphone: { id: devices.microphone.id } });
    return () => {
      previewListeners.delete(listen);
      host.recordPreview({});
    };
  }, [previewing]);
  const testBeep = async () => {
    setBeep("playing");
    loudest.current = -120;
    await host.testBeep();
    // The level arrives a beat after the sound.
    await new Promise((r) => setTimeout(r, 300));
    setBeep(loudest.current >= HEARD_DB ? "heard" : "missed");
  };
  const start = async () => {
    setStep("checking");
    const r = await host.checkSync(devices.camera.id, devices.microphone.id, display).catch((e: Error) => ({ ok: false, error: e.message, result: undefined }));
    if (r.ok && r.result) {
      onMeasured(r.result);
      setStep({ result: r.result });
    } else setStep({ error: r.error ?? "The check failed" });
  };
  const screenName = (i: number, d: { width: number; height: number }) => `Display ${i + 1} (${d.width} × ${d.height})`;

  if (step === "checking") {
    return (
      <Modal title="Check Sync" width={460} onClose={() => {}}>
        <div className="py-6 text-center text-text-muted" data-sync-checking>
          Watch the flashing screen and keep still and quiet for about 10 seconds.
        </div>
      </Modal>
    );
  }
  if (typeof step === "object") {
    return (
      <Modal title="Check Sync" width={460} onClose={onClose} onEnter={onClose}>
        {"result" in step ? (
          <div className="flex flex-col gap-2" data-sync-result>
            <div className="text-title font-semibold text-text-strong">
              {step.result.cameraLateMs > 0 ? `The camera is ${step.result.cameraLateMs} ms behind the microphone` : step.result.cameraLateMs < 0 ? `The camera is ${-step.result.cameraLateMs} ms ahead of the microphone` : "The camera and microphone are in sync"}
            </div>
            <div className="text-text-muted">
              Measured from {step.result.flashes} flashes, within {step.result.spreadMs} ms of each other. Saved: takes with {devices.camera.name} and {devices.microphone.name} move the camera's clip by it.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-sync-error>
            <div className="text-title font-semibold text-warning">The check didn't work</div>
            <div className="text-text-muted">{step.error}</div>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setStep("setup")}>Check Again</Button>
          <Button look="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Check Sync" width={520} onClose={onClose} onEnter={start}>
      <div className="flex flex-col gap-3" data-sync-setup>
        <div className="flex gap-3">
          <div className="flex aspect-video w-52 shrink-0 items-center justify-center overflow-hidden rounded-md bg-groove ring-1 ring-white/5">
            {camera ? <img src={`data:image/jpeg;base64,${camera}`} alt="Camera preview" className="h-full w-full -scale-x-100 object-cover" data-preview="Camera" /> : <Icon name="video-camera" size={18} className="text-text-faint" />}
          </div>
          <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-text-muted">
            <li>Sit where you record, facing the screen below: the camera measures its light on you.</li>
            <li>Beacon turns your Mac's volume up for the check, and back after.</li>
            <li>Stay still and quiet while the screen flashes and beeps, about 10 seconds.</li>
          </ol>
        </div>
        <Row label="Camera">
          <span className="truncate text-text">{devices.camera.name}</span>
        </Row>
        <Row label="Microphone" hint={beep === "heard" ? "Heard the beep." : beep === "missed" ? "The microphone didn't hear the beep: turn the speakers up or bring the microphone closer." : undefined}>
          <span className="w-44 truncate text-text">{devices.microphone.name}</span>
          <LevelMeter label="Microphone level" db={level?.db} peak={level?.peak} />
        </Row>
        <Row label="Flash">
          <div className="w-56">
            <Select value={display ?? ""} onChange={(e) => setDisplay(Number(e.target.value))} data-sync-display>
              {devices.displays.map((d, i) => (
                <option key={d.id} value={d.id}>
                  {screenName(i, d)}
                </option>
              ))}
            </Select>
          </div>
        </Row>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <Button onClick={testBeep} disabled={beep === "playing"} data-test-beep>
          {beep === "playing" ? "Beeping…" : beep ? "Test Beep Again" : "Play Test Beep"}
        </Button>
        <span className="flex-1" />
        <Button onClick={onClose}>Cancel</Button>
        <Button look="primary" onClick={start} data-start-sync>
          Start Check
        </Button>
      </div>
    </Modal>
  );
}

/**
 * A camera and microphone pair's delay: typed, or measured by Check Sync. Takes recorded with the pair move
 * their camera clip earlier by it.
 */
export function CameraSyncControl({ sync, onChange, onCheck, host, devices, typed = true }: {
  sync?: CameraSync;
  /** A new delay, measured (the app has saved it) or typed. */
  onChange: (sync: CameraSync) => void;
  /** While the check's dialog is open: a dialog previewing the same devices lets go of them. */
  onCheck?: (open: boolean) => void;
  host: SyncCheckHost;
  devices: SyncDevices;
  /** Whether the delay can be typed (Settings › Recording) or only measured. */
  typed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const show = (on: boolean) => {
    setOpen(on);
    onCheck?.(on);
  };
  const late = sync?.cameraLateMs ?? 0;
  const said = sync?.checked
    ? `Measured ${day(sync.checked.at)} from ${sync.checked.flashes} flashes (within ${sync.checked.spreadMs} ms).`
    : sync
      ? "Typed in. Check Sync measures it."
      : "Not checked: Check Sync measures it.";
  return (
    <div className="flex flex-col gap-1" data-camera-sync>
      <div className="flex items-center gap-2">
        <span className="text-text-muted">Camera late by</span>
        <NumberBox value={late} unit=" ms" digits={0} min={-1000} max={1000} onCommit={typed ? (v) => onChange({ cameraLateMs: Math.round(v) }) : undefined} />
        <span className="flex-1" />
        <Button onClick={() => show(true)} data-check-sync>
          Check Sync…
        </Button>
      </div>
      <div className="text-label text-text-faint" data-sync-status>
        {said}
      </div>
      {open && (
        <SyncCheckDialog
          devices={devices}
          host={host}
          onClose={() => show(false)}
          onMeasured={(r) => onChange({ cameraLateMs: r.cameraLateMs, checked: { at: Date.now(), flashes: r.flashes, spreadMs: r.spreadMs } })}
        />
      )}
    </div>
  );
}
