import { type Project, type Session } from "@beacon/model";
import { Check, Slider } from "./controls";
import { ReviewPanel, useReviewed } from "./review";
import { clock } from "./time";
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
  /** Index of the silence being looked at, going through them one at a time. */
  current?: number;
}

export const reviewOf = (session: Session | undefined) => (session?.features.transcript as { silences?: Review } | undefined)?.silences;

export const useSilences = (host: Host, session: Session | undefined, project: Project | undefined) => useReviewed<Silences>(host, "transcript.silences", reviewOf(session), project);

// A slider's steps of 0.1 come out as 0.30000000000000004.
const tenths = (v: number) => Math.round(v * 10) / 10;

/** Remove Silences' review, with its settings. */
export function SilenceReviewPanel({ project, session, host, found }: { project: Project; session: Session; host: Host; found: Silences | undefined }) {
  const review = reviewOf(session)!;
  const set = (args: Partial<Review>) => host.run("silences.review", args);
  return (
    <ReviewPanel
      review="silences"
      one="silence"
      title="Remove Silences"
      noun="silences"
      none={`No silences longer than ${review.min} s.`}
      project={project}
      host={host}
      found={found}
      items={found?.silences}
      describe={(s) => `${clock(s.start)}, ${(s.end - s.start).toFixed(1)} s${s.active ? " of screen action" : ""}: ${s.cut ? "to cut" : "kept"}`}
    >
      <Slider label="Cut over" title="Silences longer than this are cut" value={review.min} unit=" s" digits={1} step={0.1} min={0.2} max={5} onChange={(v) => set({ min: tenths(v) })} />
      <Slider label="Leave" title="How much of each cut silence is left in, half each side" value={review.keep} unit=" s" digits={1} step={0.1} min={0} max={2} onChange={(v) => set({ keep: tenths(v) })} />
      <div className="mt-1 mb-1">
        <Check label="Keep silences with screen action" checked={review.keepActive} onChange={(keepActive) => set({ keepActive })} data-keep-active />
      </div>
      <div className="mb-4 text-label text-text-faint">Where the recording's cursor moves or clicks. Typing alone isn't seen.</div>
    </ReviewPanel>
  );
}
