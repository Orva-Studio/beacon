import { projectDuration } from "./project";
import type { Project } from "./schema";
import { rationalToNumber, ticksToSeconds } from "./ticks";

/**
 * What a narration plays: the in/out range, or from the playhead to the end. `still`: nothing to play (an empty
 * timeline, or the playhead on its last frame), so it records there until stopped.
 */
export function narrationSpan(project: Project, session: { range?: { in: number; out: number } | null; playhead: number }): { from: number; until: number; still: boolean } {
  const frame = 1 / rationalToNumber(project.settings.fps);
  const [from, until] = session.range ? [session.range.in, session.range.out] : [session.playhead, ticksToSeconds(projectDuration(project))];
  return { from, until, still: from >= until - frame * 1.5 };
}
