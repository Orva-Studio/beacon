import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeSpans, type Asset } from "@beacon/model";
import { KEY } from "./epidemic";

/** Epidemic Sound's edits are at most this long. */
export const EDIT_MAX = 300;
/** Pauses in speech shorter than this keep the music down, so it doesn't pump between words. */
const GAP = 0.8;
/** Seconds the music takes to dip under speech, and to come back. */
const RAMP = 0.3;
/** A track cut to fit fades out over its last second. */
export const FADE = 1;
export const MUSIC_DEFAULTS = { level: 0.5, under: 0.18 };

/** `Asset.derived.library`: music or a sound effect from a library, which isn't transcribed. */
export interface LibraryInfo {
  source: "epidemic";
  kind: "music" | "sfx";
  id: string;
  title: string;
  /** What was downloaded: the full mix, its instruments alone, or an edit that many seconds long. */
  version: string;
}

/** The music panel's choice, kept in the session so Apply (↩) and agents add what it shows. */
export interface MusicPick {
  id: string;
  title: string;
  ms: number;
  vocals?: boolean;
}

export const keyOf = async (secret: ((id: string) => Promise<string | undefined>) | undefined) => {
  const key = await secret?.(KEY);
  if (!key) throw new Error("no Epidemic Sound key: add one in Settings › AI (your Epidemic Sound account › API keys)");
  return key;
};

export const libraryOf = (a: Asset | undefined) => a?.derived.library as LibraryInfo | undefined;

/**
 * Music's audio points over [from, end] timeline seconds: `level`, dipping to `under` beneath speech (pauses shorter
 * than GAP kept down), with a fade to silence over the last FADE seconds when `fade`.
 */
export function duckPoints(from: number, end: number, speech: [number, number][], o: { level: number; under: number; duck: boolean; fade: boolean }): { time: number; value: number }[] {
  const spans = o.duck ? mergeSpans(speech.filter(([a, b]) => b > from && a < end), GAP) : [];
  const points: { time: number; value: number }[] = [{ time: from, value: spans[0] && spans[0][0] - RAMP <= from ? o.under : o.level }];
  for (const [a, b] of spans) {
    if (a - RAMP > from) points.push({ time: a - RAMP, value: o.level });
    if (a > from) points.push({ time: a, value: o.under });
    if (b < end) points.push({ time: b, value: o.under });
    if (b + RAMP < end) points.push({ time: b + RAMP, value: o.level });
  }
  if (o.fade && end - from > FADE) {
    const at = end - FADE;
    const kept = points.filter((p) => p.time < at - 1e-6);
    const before = points.filter((p) => p.time <= at).at(-1)!;
    const after = points.find((p) => p.time > at);
    // The volume where the fade starts, on the line between the points either side.
    const value = after ? before.value + ((after.value - before.value) * (at - before.time)) / (after.time - before.time) : before.value;
    return [...kept, { time: at, value }, { time: end, value: 0 }];
  }
  return points;
}

/** A file in `dir` named for `title`, taken by creating it, so two downloads at once never pick the same one. */
export function freePath(dir: string, title: string, ext: string): string {
  const base = title.replace(/[/\\:*?"<>|]/g, "-").trim() || "Epidemic Sound";
  for (let n = 1; ; n++) {
    const path = join(dir, `${base} (Epidemic Sound)${n > 1 ? ` ${n}` : ""}${ext}`);
    try {
      writeFileSync(path, "", { flag: "wx" });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
