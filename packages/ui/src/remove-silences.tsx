import { projectDuration, ticksToSeconds, type Project, type Session } from "@beacon/model";
import { Button, Progress, Slider } from "./controls";
import { useShortcutTip } from "./keymap";
import { useReviewed, useTranscribing } from "./review";
import { clock } from "./time";
import type { Host } from "./app";

/** Remove Silences' review in `session.features.transcript.silences` (the transcript feature's `silences.review`). */
interface Review {
  min: number;
  keep: number;
  selected: number[];
}

/** What `transcript.silences` answers. */
export interface Silences {
  /** Media with no transcript yet. */
  waiting: string[];
  silences: { start: number; end: number; active: boolean; selected: boolean }[];
  /** Seconds cutting all of them saves, and cutting the picked ones. */
  saved: number;
  selectedSaved: number;
  /** Why nothing can be cut: two voices heard at once. */
  stacked?: string;
}

export const reviewOf = (session: Session | undefined) => (session?.features.transcript as { silences?: Review } | undefined)?.silences;

export const useSilences = (host: Host, session: Session | undefined, project: Project | undefined) => useReviewed<Silences>(host, "transcript.silences", reviewOf(session), project);

// A slider's steps of 0.1 come out as 0.30000000000000004.
const tenths = (v: number) => Math.round(v * 10) / 10;

/**
 * Remove Silences' review: the silences it finds are marked on the timeline and nothing is cut until the user picks
 * which (a click, ⇧-click for more) and cuts them, or cuts them all.
 */
export function SilenceReviewPanel({ project, session, host, found }: { project: Project; session: Session; host: Host; found: Silences | undefined }) {
  const review = reviewOf(session)!;
  const set = (args: Partial<Review>) => host.run("silences.review", args);
  const progress = useTranscribing();
  const tip = useShortcutTip();
  const length = ticksToSeconds(projectDuration(project));
  const items = found?.silences ?? [];
  const picked = items.filter((s) => s.selected).length;
  const usable = !!found && !found.waiting.length && !found.stacked && items.length > 0;
  const summary = !found
    ? "Finding silences…"
    : found.waiting.length
      ? `Transcribing ${found.waiting.length === 1 ? "the speech" : `${found.waiting.length} media items`}${progress === undefined ? "" : ` (${Math.round(progress * 100)}%)`}: silences are found in the transcript.`
      : !items.length
        ? `No silences longer than ${review.min} s.`
        : picked
          ? `${picked} of ${items.length} silences selected: ${clock(found.selectedSaved)} shorter.`
          : `${items.length} silences. Cutting them all: ${clock(length)} → ${clock(length - found.saved)}, ${clock(found.saved)} shorter.`;
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-silence-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Remove Silences</div>
      <Slider label="Longer than" title="Silences longer than this are found" value={review.min} unit=" s" digits={1} step={0.1} min={0.2} max={5} onChange={(v) => set({ min: tenths(v) })} />
      <Slider label="Leave" title="How much of each cut silence is left in, half each side" value={review.keep} unit=" s" digits={1} step={0.1} min={0} max={2} onChange={(v) => set({ keep: tenths(v) })} />
      {found?.stacked ? (
        <div className="mt-2 mb-4 rounded-md bg-groove px-3 py-2 text-danger" data-silences-stacked>
          {found.stacked}.
        </div>
      ) : (
        <div className="mt-2 mb-2 rounded-md bg-groove px-3 py-2 text-text" data-silences-summary>
          {summary}
          {!!found?.waiting.length && <Progress value={progress ?? 0} className="mt-2" />}
        </div>
      )}
      <div className="mb-4 text-label text-text-muted" data-review-hint>
        Click a silence on the timeline to select it, ⇧-click to select more, then Cut Selected ({tip("edit.delete").replace(/^ \((.*)\)$/, "$1") || "Delete"}).
      </div>
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        <Button onClick={() => host.run("silences.close")} data-silences-cancel>
          Cancel{tip("reviews.cancel")}
        </Button>
        <Button disabled={!usable} onClick={() => host.run("silences.apply", { all: true })} data-silences-all>
          Cut All
        </Button>
        <Button look="primary" disabled={!usable || !picked} onClick={() => host.run("silences.apply")} data-silences-apply>
          Cut Selected{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}
