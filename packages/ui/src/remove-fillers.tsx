import { projectDuration, ticksToSeconds, type Project, type Session } from "@beacon/model";
import { Button, Progress } from "./controls";
import { useTranscribing } from "./captions";
import { clock, useReviewed } from "./remove-silences";
import type { Host } from "./app";

/** What `transcript.fillers` answers. */
export interface Fillers {
  /** Media with no transcript yet. */
  waiting: string[];
  fillers: { start: number; end: number; text: string; cut: boolean }[];
  cuts: number;
  saved: number;
}

/** Remove Filler Words' review in `session.features.transcript.fillers` (the transcript feature's `fillers.review`). */
export const fillerReviewOf = (session: Session | undefined) => (session?.features.transcript as { fillers?: { flipped: number[] } } | undefined)?.fillers;

export const useFillers = (host: Host, session: Session | undefined, project: Project | undefined) => useReviewed<Fillers>(host, "transcript.fillers", fillerReviewOf(session), project);

/**
 * Remove Filler Words' review, in the properties panel while it is open: what it will cut (marked on the timeline,
 * red to cut and grey to keep; a click there flips one), then Apply as one undo step or Cancel.
 */
export function FillerReviewPanel({ project, host, found }: { project: Project; host: Host; found: Fillers | undefined }) {
  const length = ticksToSeconds(projectDuration(project));
  const cut = found?.fillers.filter((f) => f.cut).length ?? 0;
  const kept = (found?.fillers.length ?? 0) - cut;
  const ready = !!found && !found.waiting.length && cut > 0;
  const progress = useTranscribing();
  const summary = !found
    ? "Finding filler words…"
    : found.waiting.length
      ? `Transcribing ${found.waiting.length === 1 ? "the speech" : `${found.waiting.length} media items`}${progress === undefined ? "" : ` (${Math.round(progress * 100)}%)`}: filler words are found in the transcript.`
      : !found.fillers.length
        ? "No filler words in the transcript."
        : `${found.fillers.length} filler words: ${cut} to cut, ${kept} kept. ${clock(length)} → ${clock(length - found.saved)}, ${clock(found.saved)} shorter.`;
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-filler-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Remove Filler Words</div>
      <div className="mb-4 text-label text-text-faint">"Um", "uh", "er" and "hmm" where the transcript has them, each with the shorter of the pauses around it. Fillers the transcriber left out aren't found.</div>
      <div className="mb-2 rounded-md bg-groove px-3 py-2 text-text" data-fillers-summary>
        {summary}
        {!!found?.waiting.length && <Progress value={progress ?? 0} className="mt-2" />}
      </div>
      <div className="mb-4 flex flex-col gap-1 text-label text-text-muted">
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-4 rounded-sm bg-silence-cut" /> To cut
          <span className="ml-3 h-2.5 w-4 rounded-sm bg-silence-keep" /> Kept
        </span>
        <span>Click a filler on the timeline to keep or cut it.</span>
      </div>
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => host.run("fillers.close")} data-fillers-cancel>
          Cancel
        </Button>
        <Button look="primary" disabled={!ready} onClick={() => host.run("fillers.apply")} data-fillers-apply>
          Apply
        </Button>
      </div>
    </div>
  );
}
