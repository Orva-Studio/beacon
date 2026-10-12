import { Icon } from "./icons";
import { timecode } from "../time";
import { Button } from "./buttons";
import { SliderTrack } from "./fields";

/** The time readout: the time and, faded, the length. */
export function Timecode({ time, end, fps }: { time: number; end: number; fps: number }) {
  return (
    <span className="font-mono text-xs tabular-nums">
      {timecode(time, fps)} <span className="text-text-off">/ {timecode(end, fps)}</span>
    </span>
  );
}

/** Play/pause, a scrubber and the time, for anything that plays on its own clock (a media preview). */
export function PlayBar({ time, end, fps, playing, onToggle, onSeek }: { time: number; end: number; fps: number; playing: boolean; onToggle: () => void; onSeek: (t: number) => void }) {
  return (
    <div className="flex h-9 items-center gap-3">
      <Button look="icon" title={playing ? "Pause (Space)" : "Play (Space)"} onClick={onToggle}>
        <Icon name={playing ? "pause" : "play"} size={20} filled />
      </Button>
      <SliderTrack value={time} max={end} step={1 / fps} name="scrub" onChange={(t) => onSeek(t)} />
      <Timecode time={time} end={end} fps={fps} />
    </div>
  );
}
