import type { Clip } from "@beacon/model";

/** An annotation region on the timeline: its kind. */
export function regionLabel(clip: Clip): string | undefined {
  const kind = (clip.props.region as { kind?: string } | undefined)?.kind;
  return kind && kind[0]!.toUpperCase() + kind.slice(1);
}
