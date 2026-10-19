/**
 * Timeline time is integer ticks. 705,600,000 a second divides every common
 * frame rate (24, 25, 30, 60, 120, 30000/1001) and sample rate (44.1k, 48k),
 * so frame snapping and `.cmproj` import (the same rate) stay lossless.
 */
export const TICKS_PER_SECOND = 705_600_000;

export type Ticks = number;

export interface Rational {
  num: number;
  den: number;
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new Error(`invalid rational ${num}/${den}`);
  }
  return { num, den };
}

/** A frame rate as a fraction: NTSC's 29.97 is 30000/1001, 12.5 is 25/2. */
export function fpsRational(fps: number): Rational {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  const ntsc = Math.round(fps * 1001);
  if (ntsc % 1000 === 0 && Math.abs(fps - ntsc / 1001) < 0.01) return { num: ntsc, den: 1001 };
  for (let den = 2; den < 1000; den++) if (Math.abs(fps * den - Math.round(fps * den)) < 1e-6) return { num: Math.round(fps * den), den };
  return { num: Math.round(fps * 1000), den: 1000 };
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

export function isTicks(value: unknown): value is Ticks {
  return Number.isSafeInteger(value);
}

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: Ticks): number {
  return ticks / TICKS_PER_SECOND;
}

/** Exact tick length of one frame; throws if the rate doesn't divide the tick rate. */
export function ticksPerFrame(fps: Rational): Ticks {
  const ticks = (TICKS_PER_SECOND * fps.den) / fps.num;
  if (!Number.isSafeInteger(ticks)) {
    throw new Error(`frame rate ${fps.num}/${fps.den} does not divide ${TICKS_PER_SECOND} ticks/s`);
  }
  return ticks;
}

export function frameToTicks(frame: number, fps: Rational): Ticks {
  return frame * ticksPerFrame(fps);
}

/** Index of the frame showing at `ticks` (the frame that started at or before it). */
export function ticksToFrame(ticks: Ticks, fps: Rational): number {
  return Math.floor(ticks / ticksPerFrame(fps));
}

export function snapToFrame(ticks: Ticks, fps: Rational): Ticks {
  const frame = ticksPerFrame(fps);
  return Math.round(ticks / frame) * frame;
}

export function sampleToTicks(sample: number, sampleRate: number): Ticks {
  const perSample = TICKS_PER_SECOND / sampleRate;
  if (!Number.isInteger(perSample)) {
    throw new Error(`sample rate ${sampleRate} does not divide ${TICKS_PER_SECOND} ticks/s`);
  }
  return sample * perSample;
}

/** Seconds to ticks on a frame boundary: how commands take times. `floor`/`ceil` round a range outward. */
export function snapSeconds(seconds: number, fps: Rational, mode: "nearest" | "floor" | "ceil" = "nearest"): Ticks {
  if (mode === "nearest") return snapToFrame(secondsToTicks(seconds), fps);
  const frame = ticksPerFrame(fps);
  const frames = secondsToTicks(seconds) / frame;
  // A time computed from frames can land a hair past its frame in floating point.
  return (mode === "floor" ? Math.floor(frames + 1e-6) : Math.ceil(frames - 1e-6)) * frame;
}

/** Seconds rounded to the millisecond, for agent-facing output. */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
