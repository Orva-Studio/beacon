import { useEffect, useState } from "react";
import { clipEnd, heardAudio, ticksToSeconds, type Project, type Session } from "@beacon/model";
import type { AuphonicPreset, AuphonicReview } from "@beacon/features";
import { Button, Check, Progress, Select, Slider, Toast } from "./controls";
import { useShortcutTip } from "./keymap";
import { replica, useView } from "./store";
import type { Host } from "./app";
import type { Init } from "./rpc";
import { clock } from "./time";
import { NO_NESTED, timelineView } from "./timeline-draw";

export const auphonicReviewOf = (s: Session) => s.features.auphonic as AuphonicReview | undefined;

/** tuneup's default preset, picked first when the user has it. */
const USUAL = "Usual-2";

/**
 * Clean with Auphonic's settings, in place of the properties panel (Audio Effects' Auphonic tile): a preset of the
 * user's, Polish on what comes back, and what it costs before anything is uploaded.
 */
export function AuphonicPanel({ project: full, session, host, init }: { project: Project; session: Session; host: Host; init?: Init }) {
  // With a group open, its clips are the ones selected; muted ones are left out, as Clean leaves them.
  const { project } = timelineView(full, session, init?.nested ?? NO_NESTED);
  const [presets, setPresets] = useState<AuphonicPreset[] | { error: string }>();
  // Kept in the session, so Apply (↩) starts it as set here.
  const review = auphonicReviewOf(session)!;
  const { preset, polish, sibilance } = review;
  const set = (settings: Partial<Omit<AuphonicReview, "open">>) => host.run("auphonic.review", settings);
  // Asked again when Settings closes: the key may just have been added there.
  const settingsOpen = useView((v) => !!v.settings);
  useEffect(() => {
    if (settingsOpen) return;
    let live = true;
    host.query("auphonic.presets").then(
      (p) => {
        if (!live) return;
        const list = p as AuphonicPreset[];
        setPresets(list);
        const chosen = auphonicReviewOf(replica.get().session!)?.preset;
        if (!list.some((x) => x.uuid === chosen)) {
          const first = (list.find((x) => x.name === USUAL) ?? list[0])?.uuid;
          if (first) set({ preset: first });
        }
      },
      (e: Error) => live && setPresets({ error: e.message }),
    );
    return () => void (live = false);
  }, [host, settingsOpen]);
  const clips = heardAudio(project.tracks, (type) => !!init?.clipTypes[type]?.includes("audio")).filter((c) => session.selection.includes(c.id));
  const seconds = clips.length ? ticksToSeconds(Math.max(...clips.map(clipEnd)) - Math.min(...clips.map((c) => c.start))) : 0;
  const ready = Array.isArray(presets) && !!preset && clips.length > 0;
  const tip = useShortcutTip();
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-auphonic-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Clean with Auphonic</div>
      {presets === undefined && <div className="mb-4 text-text-muted">Reading your presets…</div>}
      {presets && !Array.isArray(presets) && (
        <div className="mb-4 flex flex-col items-start gap-2" data-auphonic-error>
          <span className="text-danger">{presets.error.replace(/^no Auphonic/, "No Auphonic")}</span>
          {/API key/.test(presets.error) && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
        </div>
      )}
      {Array.isArray(presets) && (
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Preset</span>
          <Select value={preset ?? ""} onChange={(e) => set({ preset: e.target.value })} data-auphonic-preset>
            {presets.map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="mb-2">
        <Check label="Polish what comes back" checked={polish} onChange={(on) => set({ polish: on })} data-auphonic-polish />
      </div>
      {polish && <Slider label="Sibilance" title="How much harsh “s” sounds are softened" value={sibilance * 100} unit="%" max={100} onChange={(v) => set({ sibilance: Math.round(v) / 100 })} />}
      {clips.length ? (
        <div className="mt-2 mb-4 rounded-md bg-groove px-3 py-2 text-text" data-auphonic-summary>
          {clips.length === 1 ? "1 clip" : `${clips.length} clips`}, {clock(seconds)} · about {Math.max(1, Math.ceil(seconds / 60))} min of Auphonic credit
        </div>
      ) : (
        <div className="mt-2 mb-4 flex flex-col items-start gap-2 rounded-md bg-groove px-3 py-2 text-text" data-auphonic-none>
          <span className="text-warning">Select the audio to clean on the timeline.</span>
          <Button onClick={() => host.run("auphonic.selectAudio")} data-auphonic-select-all>
            Select All Audio
          </Button>
          <span className="text-caption text-text-faint">All the audio the export plays: not muted, on tracks not muted.</span>
        </div>
      )}
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => host.run("auphonic.close")}>Cancel{tip("reviews.cancel")}</Button>
        <Button look="primary" disabled={!ready} onClick={() => host.run("auphonic.apply")} data-auphonic-start>
          Apply{tip("reviews.apply")}
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
        {t.state === "done" && t.stage && <div className="text-label text-text-muted" data-task-done>{t.stage}</div>}
        {t.state === "failed" && t.error !== "cancelled" && <div className="text-danger">{t.error}</div>}
      </div>
    </Toast>
  ));
}
