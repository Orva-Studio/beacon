import { useEffect, useState } from "react";
import { clipEnd, ticksToSeconds, type Project, type Session } from "@beacon/model";
import type { AuphonicPreset, AuphonicReview } from "@beacon/features";
import { Button, Check, Progress, Select, Slider, Toast } from "./controls";
import { replica, useView } from "./store";
import type { Host } from "./app";
import { clock } from "./time";

export const auphonicReviewOf = (s: Session) => s.features.auphonic as AuphonicReview | undefined;

/** tuneup's default preset, picked first when the user has it. */
const USUAL = "Usual-2";

/**
 * Clean with Auphonic's settings, in place of the properties panel (Audio Effects' Auphonic tile): a preset of the
 * user's, Polish on what comes back, and what it costs before anything is uploaded.
 */
export function AuphonicPanel({ project, session, host }: { project: Project; session: Session; host: Host }) {
  const review = auphonicReviewOf(session)!;
  const [presets, setPresets] = useState<AuphonicPreset[] | { error: string }>();
  const [preset, setPreset] = useState<string>();
  const [polish, setPolish] = useState(true);
  const [sibilance, setSibilance] = useState(0.2);
  useEffect(() => {
    let live = true;
    host.query("auphonic.presets").then(
      (p) => {
        if (!live) return;
        const list = p as AuphonicPreset[];
        setPresets(list);
        setPreset((list.find((x) => x.name === USUAL) ?? list[0])?.uuid);
      },
      (e: Error) => live && setPresets({ error: e.message }),
    );
    return () => void (live = false);
  }, [host]);
  const clips = project.tracks.flatMap((t) => t.clips).filter((c) => review.clips.includes(c.id));
  const seconds = clips.length ? ticksToSeconds(Math.max(...clips.map(clipEnd)) - Math.min(...clips.map((c) => c.start))) : 0;
  const ready = Array.isArray(presets) && !!preset && clips.length > 0;
  const close = () => host.run("auphonic.close");
  const start = () => {
    host.run("audio.clean", { clips: review.clips, preset, polish, sibilance });
    close();
  };
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-auphonic-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Clean with Auphonic</div>
      {presets === undefined && <div className="mb-4 text-text-muted">Reading your presets…</div>}
      {presets && !Array.isArray(presets) && (
        <div className="mb-4 flex flex-col items-start gap-2" data-auphonic-error>
          <span className="text-danger">{presets.error.replace(/^no Auphonic/, "No Auphonic")}</span>
          {/API key/.test(presets.error) && <Button onClick={() => host.app("app.settings:audio")}>Open Settings…</Button>}
        </div>
      )}
      {Array.isArray(presets) && (
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Preset</span>
          <Select value={preset ?? ""} onChange={(e) => setPreset(e.target.value)} data-auphonic-preset>
            {presets.map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="mb-2">
        <Check label="Polish what comes back" checked={polish} onChange={setPolish} data-auphonic-polish />
      </div>
      {polish && <Slider label="Sibilance" title="How much harsh “s” sounds are softened" value={sibilance * 100} unit="%" max={100} onChange={(v) => setSibilance(Math.round(v) / 100)} />}
      <div className="mt-2 mb-4 rounded-md bg-groove px-3 py-2 text-text" data-auphonic-summary>
        {clips.length === 1 ? "1 clip" : `${clips.length} clips`}, {clock(seconds)} of audio as you hear it: uploaded to Auphonic and cleaned on your account, about {Math.max(1, Math.ceil(seconds / 60))} min of your credit. The cleaned audio goes on a track of its own, the originals muted.
      </div>
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={!ready} onClick={start} data-auphonic-start>
          Clean
        </Button>
      </div>
    </div>
  );
}

/** Features' background jobs (Clean with Auphonic): stage and progress with Cancel, then done or why it failed. */
export function TaskToasts({ host }: { host: Pick<Host, "cancelJob"> }) {
  const tasks = useView((v) => v.tasks);
  return tasks.map((t) => (
    <Toast key={t.id} title={t.state === "failed" && t.error === "cancelled" ? `Cancelled: ${t.label}` : t.state === "failed" ? `Failed: ${t.label}` : t.label} done={t.state !== "running"} onDismiss={t.state === "running" ? undefined : () => replica.dismissTask(t.id)}>
      <div data-task={t.id} data-task-state={t.state}>
        {t.state === "running" && (
          <>
            {t.stage && <div className="mb-1.5 text-label text-text-muted">{t.stage}</div>}
            <div className="flex items-center gap-2">
              <Progress value={t.progress} className="flex-1" />
              <Button onClick={() => host.cancelJob(t.id)}>Cancel</Button>
            </div>
          </>
        )}
        {t.state === "failed" && t.error !== "cancelled" && <div className="text-danger">{t.error}</div>}
      </div>
    </Toast>
  ));
}
