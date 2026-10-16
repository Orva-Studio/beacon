import { useEffect, useRef, useState } from "react";
import { projectDuration, ticksToSeconds, type Project, type Session } from "@beacon/model";
import { Button, Progress, Slider } from "./controls";
import { useTranscribing } from "./captions";
import { useQuery } from "./query";
import type { Host } from "./app";

/** Remove Silences' review in `session.features.transcript.silences` (the transcript feature's `silences.review`). */
interface Review {
  min: number;
  keep: number;
  keepActive: boolean;
  flipped: number[];
}

/** What `transcript.silences` answers. */
export interface Silences {
  /** Media with no transcript yet. */
  waiting: string[];
  silences: { start: number; end: number; active: boolean; cut: boolean }[];
  cuts: number;
  saved: number;
}

export const reviewOf = (session: Session | undefined) => (session?.features.transcript as { silences?: Review } | undefined)?.silences;

/**
 * The open review's silences, for the timeline's marks and the review panel; asked again after each edit, and each
 * second while a transcript is still being made, and a missing one (an import whose app quit first) is started.
 */
export function useSilences(host: Host, session: Session | undefined, project: Project | undefined): Silences | undefined {
  const review = reviewOf(session);
  const [tick, setTick] = useState(0);
  // Each edit is a new project: the marks and Apply must describe the timeline as it is now.
  const edits = useRef({ project, n: 0 });
  if (edits.current.project !== project) edits.current = { project, n: edits.current.n + 1 };
  const found = useQuery<Silences>(host, review ? "transcript.silences" : "", review ?? {}, `${tick}:${edits.current.n}`);
  const missing = review ? (found?.waiting.join() ?? "") : "";
  useEffect(() => {
    for (const asset of missing ? missing.split(",") : []) host.analyze("transcript", asset);
  }, [missing]);
  useEffect(() => {
    if (!missing) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [missing]);
  return review ? found : undefined;
}

// A slider's steps of 0.1 come out as 0.30000000000000004.
const tenths = (v: number) => Math.round(v * 10) / 10;

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Remove Silences' review, in the properties panel while it is open: its settings, what it will cut (marked on
 * the timeline, red to cut and grey to keep; a click there flips one), then Apply as one undo step or Cancel.
 */
export function SilenceReviewPanel({ project, session, host, found }: { project: Project; session: Session; host: Host; found: Silences | undefined }) {
  const review = reviewOf(session)!;
  const set = (args: Partial<Review>) => host.run("silences.review", args);
  const length = ticksToSeconds(projectDuration(project));
  const cut = found?.silences.filter((s) => s.cut).length ?? 0;
  const kept = (found?.silences.length ?? 0) - cut;
  const ready = !!found && !found.waiting.length && cut > 0;
  const progress = useTranscribing();
  const summary = !found
    ? "Finding silences…"
    : found.waiting.length
      ? `Transcribing ${found.waiting.length === 1 ? "the speech" : `${found.waiting.length} media items`} on this Mac${progress === undefined ? "" : ` (${Math.round(progress * 100)}%)`}: silences are found from the transcript.`
      : !found.silences.length
        ? `No silences longer than ${review.min} s.`
        : `${found.silences.length} silences: ${cut} to cut, ${kept} kept. ${clock(length)} → ${clock(length - found.saved)}, ${clock(found.saved)} shorter.`;
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-silence-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Remove Silences</div>
      <Slider label="Cut over" title="Silences longer than this are cut" value={review.min} unit=" s" digits={1} step={0.1} min={0.2} max={5} onChange={(v) => set({ min: tenths(v) })} />
      <Slider label="Leave" title="How much of each cut silence is left in, half each side" value={review.keep} unit=" s" digits={1} step={0.1} min={0} max={2} onChange={(v) => set({ keep: tenths(v) })} />
      <label className="mt-1 mb-1 flex items-center gap-2 text-text">
        <input type="checkbox" checked={review.keepActive} onChange={(e) => set({ keepActive: e.target.checked })} data-keep-active />
        Keep silences with screen action
      </label>
      <div className="mb-4 text-label text-text-faint">Where the recording's cursor moves or clicks. Typing alone isn't seen.</div>
      <div className="mb-2 rounded-md bg-groove px-3 py-2 text-text" data-silences-summary>
        {summary}
        {!!found?.waiting.length && <Progress value={progress ?? 0} className="mt-2" />}
      </div>
      <div className="mb-4 flex flex-col gap-1 text-label text-text-muted">
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-4 rounded-sm bg-silence-cut" /> To cut
          <span className="ml-3 h-2.5 w-4 rounded-sm bg-silence-keep" /> Kept
        </span>
        <span>Click a silence on the timeline to keep or cut it.</span>
      </div>
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => host.run("silences.close")} data-silences-cancel>
          Cancel
        </Button>
        <Button look="primary" disabled={!ready} onClick={() => host.run("silences.apply")} data-silences-apply>
          Apply
        </Button>
      </div>
    </div>
  );
}
