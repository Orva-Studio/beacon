import { wordsInWindow, type Clip } from "@beacon/model";

/** A caption on the timeline: the words it shows. */
export function captionLabel(clip: Clip): string | undefined {
  const words = (clip.props.caption as { words?: { text: string; start: number; end: number }[] } | undefined)?.words;
  return words && (wordsInWindow(clip, words).map((w) => w.text).join(" ") || "Caption");
}
