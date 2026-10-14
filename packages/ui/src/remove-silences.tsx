import { useEffect, useState } from "react";
import { projectDuration, ticksToSeconds, type Project } from "@beacon/model";
import { Button, Modal, NumberBox, SettingsRow as Row } from "./controls";
import { useQuery } from "./query";
import type { Host } from "./app";

/** What `transcript.silences` answers. */
interface Silences {
  /** Media with no transcript yet. */
  waiting: string[];
  silences: { start: number; end: number; active: boolean }[];
  except: { start: number; end: number }[];
  cuts: number;
  saved: number;
}

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Remove Silences (the AI panel): shortens every silence in the transcript, keeping those where the recording's
 * cursor moved or clicked (screen action), as one undo step through `transcript.removePauses`.
 */
export function RemoveSilencesDialog({ project, host, onClose }: { project: Project; host: Host; onClose: () => void }) {
  const [min, setMin] = useState(0.6);
  const [keep, setKeep] = useState(0.3);
  const [keepActive, setKeepActive] = useState(true);
  // A transcript still being made: ask again each second until it is.
  const [tick, setTick] = useState(0);
  const found = useQuery<Silences>(host, "transcript.silences", { min, keep, keepActive }, tick);
  const waiting = !!found?.waiting.length;
  // Made on import, but an import whose app quit first has none: start what is missing (running ones are left be).
  const missing = found?.waiting.join() ?? "";
  useEffect(() => {
    for (const asset of found?.waiting ?? []) host.analyze("transcript", asset);
  }, [missing]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const length = ticksToSeconds(projectDuration(project));
  const kept = found ? found.silences.filter((s) => s.active).length : 0;
  const ready = !!found && !waiting && found.cuts > 0;
  const remove = () => {
    if (!ready) return;
    host.run("transcript.removePauses", { min, keep, except: found.except }, "Remove Silences");
    onClose();
  };
  const summary = !found
    ? "Finding silences…"
    : waiting
      ? `Transcribing ${found.waiting.length === 1 ? "the speech" : `${found.waiting.length} media items`}: silences are found from the transcript, made on this Mac.`
      : !found.silences.length
        ? `No silences longer than ${min} s.`
        : `${found.silences.length} silences: ${found.cuts} cut${keepActive && kept ? `, ${kept} kept for screen action` : ""}. ${clock(length)} → ${clock(length - found.saved)} (${clock(found.saved)} shorter).`;
  return (
    <Modal title="Remove Silences" width={460} onClose={onClose} onEnter={remove}>
      <div className="flex flex-col gap-3" data-remove-silences>
        <Row label="Cut silences over">
          <NumberBox value={min} unit=" s" digits={1} step={0.1} min={0.2} max={10} onCommit={setMin} />
        </Row>
        <Row label="Leave a pause of">
          <NumberBox value={keep} unit=" s" digits={1} step={0.1} min={0} max={2} onCommit={(v) => setKeep(Math.min(v, min))} />
        </Row>
        <Row label="Screen action" hint="Silences where the recording's cursor moves or clicks stay as they are. Typing alone isn't seen.">
          <input type="checkbox" aria-label="Keep silences with screen action" checked={keepActive} onChange={(e) => setKeepActive(e.target.checked)} data-keep-active />
          <span className="text-text">Keep silences with screen action</span>
        </Row>
        <div className="rounded-md bg-groove px-3 py-2 text-text" data-silences-summary>
          {summary}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button look="primary" disabled={!ready} onClick={remove} data-remove-silences-run>
          Remove Silences
        </Button>
      </div>
    </Modal>
  );
}
