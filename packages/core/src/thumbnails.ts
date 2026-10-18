import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { type MediaInfo, streamSource, thumbnailPng } from "@beacon/media";
import { ticksToSeconds, type Asset, type Clip, type FeatureRegistry, type Ticks } from "@beacon/model";
import type { OpenProject } from "./project";

/** PNG of a video clip's first frame, `height` pixels tall, read from its proxy when there is one; undefined for other clips. */
export async function clipThumbnail(registry: FeatureRegistry, cacheDir: string, p: OpenProject, clipId: string, height: number): Promise<Uint8Array | undefined> {
  const doc = p.store.doc;
  const top = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  // A group or stitched clip shows what its first frame shows.
  const shown = top && mediaShown(registry, top, top.mediaStart ?? 0);
  if (!shown) return undefined;
  const { clip, at } = shown;
  const asset = doc.assets[clip.assetId!]!;
  const stream = Number((clip.props.media as { stream?: number } | undefined)?.stream ?? 0);
  const proxy = p.data.get<{ streams: Record<number, { path: string }> }>(asset.id, "proxy")?.streams[stream];
  const time = asset.kind === "image" ? 0 : ticksToSeconds(at);
  const src = proxy ? { path: proxy.path, stream: 0 } : streamSource(asset.path, asset.derived.media as MediaInfo, "video", stream);
  return cachedThumb(cacheDir, asset, stream, time, height, () => (asset.kind === "image" ? thumbnailPng(asset.path, 0, 0, height) : thumbnailPng(src.path, src.stream, time, height)));
}

/** PNG of an asset for the media bin: its first video stream `at` seconds in (a second by default; the screen, for a recording). */
export async function assetThumbnail(cacheDir: string, p: OpenProject, assetId: string, height: number, at?: number): Promise<Uint8Array | undefined> {
  const asset = p.store.doc.assets[assetId];
  if (!asset || asset.kind === "audio") return undefined;
  const proxy = p.data.get<{ streams: Record<number, { path: string }> }>(asset.id, "proxy")?.streams[0];
  const time = asset.kind === "image" ? 0 : (at ?? 1);
  const src = proxy ? { path: proxy.path, stream: 0 } : streamSource(asset.path, asset.derived.media as MediaInfo, "video", 0);
  return cachedThumb(cacheDir, asset, -1, time, height, () => thumbnailPng(src.path, src.stream, time, height));
}

/** The visual media clip showing at `at` (media time) in `clip`, looking inside groups and stitched clips, top track first; and its media time there. */
function mediaShown(registry: FeatureRegistry, clip: Clip, at: Ticks): { clip: Clip; at: Ticks } | undefined {
  if (clip.assetId && registry.hasTrait(clip.type, "visual") && registry.hasTrait(clip.type, "media")) return { clip, at };
  for (const g of registry.groupsFor(clip.type)) {
    if (!g.nested || !clip.props[g.id]) continue;
    for (const track of [...g.nested(clip.props[g.id])].reverse()) {
      if (track.hidden) continue;
      const inner = track.clips.find((c) => c.start <= at && at < c.start + c.duration);
      const found = inner && mediaShown(registry, inner, (inner.mediaStart ?? 0) + at - inner.start);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Thumbnails are kept on disk by media file, stream, time and height: a project's are made once, not on
 * every open (the benchmark project's 304 clips cost ~50 s of ffmpeg each time).
 */
async function cachedThumb(cacheDir: string, asset: Asset, stream: number, time: number, height: number, make: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const key = Bun.hash(`${asset.path}\0${asset.fingerprint}\0${stream}\0${time.toFixed(3)}\0${height}`).toString(16);
  const file = join(cacheDir, "thumbs", `${key}.png`);
  if (existsSync(file)) return new Uint8Array(await Bun.file(file).arrayBuffer());
  const png = await make();
  if (png.length) {
    mkdirSync(dirname(file), { recursive: true });
    await Bun.write(`${file}.${process.pid}.tmp`, png);
    renameSync(`${file}.${process.pid}.tmp`, file);
  }
  return png;
}
