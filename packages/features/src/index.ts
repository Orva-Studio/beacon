import { FeatureRegistry, type Feature } from "@beacon/model";
import { border } from "./border";
import { callouts } from "./callouts";
import { captions } from "./captions";
import { cursor } from "./cursor";
import { groups } from "./groups";
import { labels } from "./labels";
import { regions } from "./regions";
import { crtMonitor } from "./crt-monitor";
import { dropShadow } from "./drop-shadow";
import { media } from "./media";
import { motionBlur } from "./motion-blur";
import { roundCorners } from "./round-corners";
import { stitching } from "./stitching";
import { timeline } from "./timeline";
import { transcript } from "./transcript";
import { transform } from "./transform";
import { removeBackground } from "./remove-background";
import { lut } from "./lut";
import { noise } from "./noise";
import { polish } from "./polish";
import { safeAreas } from "./safe-areas";
import { filmLook } from "./film-look";
import { volume } from "./volume";
import { zoom } from "./zoom";

export * from "./media";
export * from "./cursor";
export * from "./transform";
export * from "./drop-shadow";
export * from "./timeline";
export * from "./zoom";
export * from "./transcript";
export * from "./noise";
export * from "./volume";
export * from "./groups";
export * from "./stitching";
export * from "./captions";
export * from "./labels";
export * from "./safe-areas";
export * from "./film-look";

/**
 * Every feature, in evaluation order: clip content and cursor are drawn in
 * content space, `transform` maps them to the canvas, then effects.
 * Editing-only features come last.
 */
export const FEATURES: Feature[] = [media, callouts, captions, regions, groups, stitching, cursor, removeBackground, transform, lut, filmLook, roundCorners, border, crtMonitor, dropShadow, motionBlur, timeline, volume, noise, polish, zoom, transcript, labels, safeAreas];

export function createRegistry(): FeatureRegistry {
  return new FeatureRegistry(FEATURES);
}
