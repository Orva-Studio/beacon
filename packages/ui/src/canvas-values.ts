import { DEFAULT_SETTINGS, fpsRational, rationalToNumber, type Settings, type SettingsChange } from "@beacon/model";

/** A project's canvas as Settings › Project and New Project show it. */
export interface CanvasValues {
  width: number;
  height: number;
  fps: number;
  /** "#rrggbb". */
  background: string;
  normalize: boolean;
}

/** The canvas of a project's settings. */
export const canvasValues = (s: Settings): CanvasValues => ({
  width: s.width,
  height: s.height,
  fps: rationalToNumber(s.fps),
  background: s.background,
  normalize: s.loudnessTarget !== undefined,
});

export const DEFAULT_CANVAS = canvasValues(DEFAULT_SETTINGS);

/** What the canvas form changed, as `project.settings.set` and a new project take it: normalize is the default loudness target, or none. */
export function canvasChange({ width, height, fps, background, normalize }: Partial<CanvasValues>): SettingsChange {
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(fps !== undefined ? { fps: fpsRational(fps) } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(normalize !== undefined ? { loudnessTarget: normalize ? DEFAULT_SETTINGS.loudnessTarget! : null } : {}),
  };
}
