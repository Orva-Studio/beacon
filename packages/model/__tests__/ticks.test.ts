import { expect, test } from "bun:test";
import { fpsRational, frameToTicks, rational, sampleToTicks, secondsToTicks, snapToFrame, TICKS_PER_SECOND, ticksPerFrame, ticksToFrame } from "../src";

test("every common frame and sample rate is a whole number of ticks", () => {
  for (const fps of [rational(24), rational(25), rational(30), rational(60), rational(120), rational(30000, 1001), rational(24000, 1001), rational(60000, 1001)]) {
    expect(Number.isInteger(ticksPerFrame(fps))).toBe(true);
  }
  expect(sampleToTicks(44_100, 44_100)).toBe(TICKS_PER_SECOND);
  expect(sampleToTicks(48_000, 48_000)).toBe(TICKS_PER_SECOND);
  expect(() => ticksPerFrame(rational(7))).not.toThrow();
  expect(() => ticksPerFrame(rational(1_000_000_007))).toThrow("does not divide");
});

test("frame maths round-trips at 29.97", () => {
  const fps = rational(30000, 1001);
  expect(frameToTicks(30000, fps)).toBe(1001 * TICKS_PER_SECOND);
  expect(ticksToFrame(frameToTicks(12345, fps), fps)).toBe(12345);
  expect(ticksToFrame(frameToTicks(12345, fps) - 1, fps)).toBe(12344);
  expect(snapToFrame(secondsToTicks(1.01), rational(30))).toBe(secondsToTicks(1));
});

test("frame rates become exact fractions", () => {
  expect(fpsRational(30)).toEqual({ num: 30, den: 1 });
  expect(fpsRational(12.5)).toEqual({ num: 25, den: 2 });
  expect(fpsRational(7.5)).toEqual({ num: 15, den: 2 });
  expect(fpsRational(29.97)).toEqual({ num: 30000, den: 1001 });
  expect(fpsRational(23.976)).toEqual({ num: 24000, den: 1001 });
  expect(fpsRational(59.94)).toEqual({ num: 60000, den: 1001 });
  expect(fpsRational(14.985)).toEqual({ num: 15000, den: 1001 });
});
