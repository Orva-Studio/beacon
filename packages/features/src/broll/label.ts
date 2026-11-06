import type { Clip } from "@beacon/model";

/** B-roll on the timeline before its footage: what it will show. */
export function brollLabel(clip: Clip): string | undefined {
  if (clip.type !== "broll") return undefined;
  const b = clip.props.broll as { prompt?: string; manual?: string; source?: string } | undefined;
  return (b?.source === "manual" ? b.manual : b?.prompt)?.trim() || "B-roll";
}
