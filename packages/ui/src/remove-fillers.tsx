import { type Project, type Session } from "@beacon/model";
import { ReviewPanel, useReviewed } from "./review";
import { clock } from "./time";
import type { Host } from "./app";

/** What `transcript.fillers` answers. */
export interface Fillers {
  /** Media with no transcript yet. */
  waiting: string[];
  fillers: { start: number; end: number; text: string; cut: boolean }[];
  cuts: number;
  saved: number;
  /** Index of the filler being looked at, going through them one at a time. */
  current?: number;
}

/** Remove Filler Words' review in `session.features.transcript.fillers` (the transcript feature's `fillers.review`). */
export const fillerReviewOf = (session: Session | undefined) => (session?.features.transcript as { fillers?: { flipped: number[]; learned?: string[] } } | undefined)?.fillers;

export const useFillers = (host: Host, session: Session | undefined, project: Project | undefined) => useReviewed<Fillers>(host, "transcript.fillers", fillerReviewOf(session), project);

/** Remove Filler Words' review. */
export function FillerReviewPanel({ project, session, host, found }: { project: Project; session: Session; host: Host; found: Fillers | undefined }) {
  return (
    <ReviewPanel
      review="fillers"
      one="filler"
      title="Remove Filler Words"
      noun="filler words"
      none="No filler words in the transcript."
      project={project}
      host={host}
      found={found}
      items={found?.fillers}
      learned={fillerReviewOf(session)?.learned}
      describe={(f) => `“${f.text}” at ${clock(f.start)}: ${f.cut ? "to cut" : "kept"}`}
    >
      <div className="mb-4 text-label text-text-faint">"Um", "uh", "er" and "hmm" where the transcript has them, each with the shorter of the pauses around it. Fillers the transcriber left out aren't found.</div>
    </ReviewPanel>
  );
}
