import { useState } from "react";
import { Button, NumberBox } from "./controls";
import type { CameraSync, SyncCheck } from "./rpc";

export interface SyncCheckHost {
  checkSync(camera: string, microphone: string): Promise<{ ok: boolean; result?: SyncCheck; error?: string }>;
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/**
 * A camera and microphone pair's delay: typed, or measured by Check Sync (the screen flashes white and beeps
 * while both record). Takes recorded with the pair move their camera clip earlier by it.
 */
export function CameraSyncControl({ sync, onChange, onCheck, host, camera, microphone, typed = true }: {
  sync?: CameraSync;
  /** A new delay, measured (the app has saved it) or typed. */
  onChange: (sync: CameraSync) => void;
  /** Whether the delay can be typed (Settings › Recording) or only measured. */
  typed?: boolean;
  /** Before a check: a dialog previewing the devices lets go of them. */
  onCheck?: (running: boolean) => void;
  host: SyncCheckHost;
  camera: string;
  microphone: string;
}) {
  const [state, setState] = useState<{ running?: boolean; error?: string }>({});
  const check = async () => {
    setState({ running: true });
    onCheck?.(true);
    const r = await host.checkSync(camera, microphone).catch((e: Error) => ({ ok: false, error: e.message, result: undefined }));
    onCheck?.(false);
    if (r.ok && r.result) {
      onChange({ cameraLateMs: r.result.cameraLateMs, checked: { at: Date.now(), flashes: r.result.flashes, spreadMs: r.result.spreadMs } });
      setState({});
    } else setState({ error: r.error ?? "The check failed" });
  };
  const late = sync?.cameraLateMs ?? 0;
  const said = state.running
    ? "Checking: the screen flashes white and beeps for about 10 seconds. Keep the camera seeing the screen and the room quiet."
    : state.error
      ? state.error
      : sync?.checked
        ? `Measured ${day(sync.checked.at)} from ${sync.checked.flashes} flashes (within ${sync.checked.spreadMs} ms).`
        : sync
          ? "Typed in. Check Sync measures it."
          : "Not checked: Check Sync measures it (speakers on, the camera seeing the screen).";
  return (
    <div className="flex flex-col gap-1" data-camera-sync>
      <div className="flex items-center gap-2">
        <span className="text-text-muted">Camera late by</span>
        <NumberBox value={late} unit=" ms" digits={0} min={-1000} max={1000} onCommit={typed ? (v) => onChange({ cameraLateMs: Math.round(v) }) : undefined} />
        <span className="flex-1" />
        <Button onClick={check} disabled={state.running} data-check-sync>
          {state.running ? "Checking…" : "Check Sync…"}
        </Button>
      </div>
      <div className={`text-label ${state.error ? "text-warning" : "text-text-faint"}`} data-sync-status>
        {said}
      </div>
    </div>
  );
}
