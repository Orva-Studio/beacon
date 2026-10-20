import { useEffect, useState } from "react";
import { Button, Icon, LevelHistory } from "./controls";
import { previewListeners } from "./record-preview";
import type { AudioLevel, PanelState, RecordPreview } from "./rpc";
import { clock } from "./time";

type Source = "screen" | "camera" | "microphone" | "systemAudio";
const SOURCES: [Source, string][] = [
  ["screen", "Screen"],
  ["camera", "Camera"],
  ["microphone", "Mic"],
  ["systemAudio", "System"],
];

/**
 * The recording panel: a small window floating over the screen while a take records, left out of the recording.
 * The time, Stop, a chip per source recorded (red once it stops sending or saving, the camera's dot amber while
 * its picture is black or frozen), and the microphone's and system audio's last few seconds as rolling waveforms,
 * or "Not saving" in place of a stopped one's, whose level can carry on while nothing is written. No camera: a
 * live picture mid-take was choppy and cost the take (the Record dialog shows it before). Dragged by its grip (or anywhere but its buttons); hidden to the menu bar by –.
 */
export function RecordPanel({ state, onStop, onHide }: { state: PanelState; onStop: () => void; onHide: () => void }) {
  const [levels, setLevels] = useState<{ microphone?: AudioLevel; systemAudio?: AudioLevel; live?: Partial<Record<Source, boolean>>; picture?: { camera?: "black" | "frozen" | null } }>({});
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
  const chips = SOURCES.filter(([key]) => state[key]);
  const stopped = (key: Source) => levels.live?.[key] === false;
  const audio: [Source, string, AudioLevel | undefined][] = [
    ...(state.microphone ? [["microphone", "Mic", levels.microphone] as [Source, string, AudioLevel | undefined]] : []),
    ...(state.systemAudio ? [["systemAudio", "System", levels.systemAudio] as [Source, string, AudioLevel | undefined]] : []),
  ];
  return (
    <div className="electrobun-webkit-app-region-drag flex h-screen cursor-grab flex-col gap-2 overflow-hidden rounded-xl border border-white/10 bg-panel/95 px-2.5 pt-1.5 pb-2.5 select-none" data-record-panel>
      <div className="flex justify-center" title="Drag to move">
        <span className="h-1 w-9 rounded-full bg-white/25" data-record-grip />
      </div>
      <div className="flex items-center gap-2">
        <span className="size-2.5 animate-pulse rounded-full bg-danger" />
        <span className="flex-1 text-body font-semibold text-text-strong tabular-nums" data-record-time>
          {clock((now - state.started) / 1000, { floor: true })}
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
      <div className="flex flex-wrap gap-1" data-record-sources>
        {chips.map(([key, label]) => {
          const off = stopped(key);
          const picture = key === "camera" && !off ? levels.picture?.camera : undefined;
          const state = off ? "stopped" : picture ?? "live";
          const title = off ? `${label}: nothing is being saved (it stopped sending, or its file couldn't be written)` : picture ? `${label}: the picture is ${picture}` : `${label}: recording`;
          return (
            <span
              key={key}
              className={`flex h-5 items-center gap-1 rounded-full px-2 text-caption ${off ? "bg-danger/20 font-semibold text-danger" : "bg-control text-text"}`}
              title={title}
              data-source-live={state}
              data-source={key}
            >
              <span className={`size-1.5 rounded-full ${off ? "bg-danger" : picture ? "bg-warning" : "bg-accent"}`} />
              {label}
            </span>
          );
        })}
      </div>
      {audio.map(([key, label, level]) => (
        <div key={key} className="flex items-center gap-2">
          <span className="w-12 text-caption text-text-muted">{label}</span>
          {stopped(key) ? (
            <span className="flex h-6 flex-1 items-center text-caption font-semibold text-danger" data-not-saving={key}>
              Not saving
            </span>
          ) : (
            <LevelHistory label={`${label} level`} level={level} />
          )}
        </div>
      ))}
    </div>
  );
}
