import { animatedValue, mediaTimeAt, secondsToTicks, type Clip, type Project } from "@beacon/model";

/** The prop group holding a clip's own box size (annotations), if its size isn't its media's. */
export function boxGroup(clip: Clip): string | undefined {
  return Object.entries(clip.props).find(([, v]) => typeof (v as { width?: unknown })?.width === "number" && typeof (v as { height?: unknown })?.height === "number")?.[0];
}

/**
 * Pixels of what a visual clip shows before crop: its video or image, or the box a prop group sizes (a group's or stitched
 * clip's canvas, a callout), as animated at `playhead` when given.
 */
export function contentSize(project: Project, clip: Clip, playhead?: number): [number, number] | undefined {
  const group = boxGroup(clip);
  const box = group ? (clip.props[group] as { width: number; height: number }) : undefined;
  if (box?.width && box.height) return playhead === undefined ? [box.width, box.height] : [valueAt(clip, playhead, group!, "width", box.width), valueAt(clip, playhead, group!, "height", box.height)];
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
  const streams = (asset?.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined)?.streams?.filter((s) => s.kind === "video");
  const s = streams?.[Number((clip.props.media as { stream?: number } | undefined)?.stream ?? 0)];
  return s?.width && s.height ? [s.width, s.height] : undefined;
}

/** A property's value at the playhead, through the clip's animations. */
export function valueAt(clip: Clip, playhead: number, group: string, field: string, fallback: number): number {
  const t = Math.min(Math.max(secondsToTicks(playhead), clip.start), clip.start + clip.duration);
  return Number(animatedValue((clip.props[group] as Record<string, unknown> | undefined)?.[field] ?? fallback, `${group}.${field}`, clip.animations, mediaTimeAt(clip, t)));
}
