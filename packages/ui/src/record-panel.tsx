import { useEffect, useState } from "react";
import { Button, Icon, LevelHistory } from "./controls";
import { previewListeners, useRecordFrames } from "./record-preview";
import type { AudioLevel, PanelState, RecordFrames, RecordPreview } from "./rpc";

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const two = (n: number) => String(n).padStart(2, "0");
  return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`;
};

/**
 * The recording panel: a small window floating over the screen while a take records, left out of the recording.
 * The camera (mirrored, as a self-view is), the time, Stop, and the microphone's and system audio's last few
 * seconds as rolling waveforms. Dragged by its grip (or anywhere but its buttons); hidden to the menu bar by –.
 */
export function RecordPanel({ state, onStop, onHide, pull }: { state: PanelState; onStop: () => void; onHide: () => void; pull: (after: number) => Promise<RecordFrames> }) {
  const { camera } = useRecordFrames(pull, state.camera);
  const [levels, setLevels] = useState<{ microphone?: AudioLevel; systemAudio?: AudioLevel }>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const listen = (e: RecordPreview) => !("jpeg" in e) && setLevels(e);
    previewListeners.add(listen);
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => {
      previewListeners.delete(listen);
      clearInterval(t);
    };
  }, []);
  const audio: [string, AudioLevel | undefined][] = [
    ...(state.microphone ? [["Mic", levels.microphone] as [string, AudioLevel | undefined]] : []),
    ...(state.systemAudio ? [["System", levels.systemAudio] as [string, AudioLevel | undefined]] : []),
  ];
  return (
    <div className="electrobun-webkit-app-region-drag flex h-screen cursor-grab flex-col gap-2 overflow-hidden rounded-xl border border-white/10 bg-panel/95 px-2.5 pt-1.5 pb-2.5 select-none" data-record-panel>
      <div className="flex justify-center" title="Drag to move">
        <span className="h-1 w-9 rounded-full bg-white/25" data-record-grip />
      </div>
      <div className="flex items-center gap-2">
        <span className="size-2.5 animate-pulse rounded-full bg-danger" />
        <span className="flex-1 text-body font-semibold text-text-strong tabular-nums" data-record-time>
          {clock((now - state.started) / 1000)}
        </span>
        <div className="electrobun-webkit-app-region-no-drag flex cursor-default items-center gap-1">
          <button
            className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-control hover:text-text-strong"
            title="Hide to the menu bar (it keeps recording)"
            aria-label="Hide"
            onClick={onHide}
            data-record-hide
          >
            <Icon name="minus" size={16} />
          </button>
          <Button look="danger" onClick={onStop} data-record-stop title="Stop recording (⌘⇧2)">
            Stop
          </Button>
        </div>
      </div>
      {state.camera && (
        <div className="aspect-video w-full overflow-hidden rounded-md bg-groove">
          {camera && <img src={`data:image/jpeg;base64,${camera}`} alt="Camera" className="h-full w-full -scale-x-100 object-cover" data-preview="Camera" />}
        </div>
      )}
      {audio.map(([label, level]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-12 text-caption text-text-muted">{label}</span>
          <LevelHistory label={`${label} level`} level={level} />
        </div>
      ))}
    </div>
  );
}
