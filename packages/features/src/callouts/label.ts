import type { Clip } from "@beacon/model";

/** A callout on the timeline: a text one its text's first line, the rest their shape. */
export function calloutLabel(clip: Clip): string | undefined {
  const callout = clip.props.callout as { shape?: string; text?: { text?: string } } | undefined;
  if (callout?.shape === "text") return callout.text?.text?.split("\n")[0]?.trim() || "Text";
  if (callout?.shape) return callout.shape === "rectangle" ? "Shape" : callout.shape[0]!.toUpperCase() + callout.shape.slice(1);
  return undefined;
}
