import { expect, test } from "bun:test";
import { frameToTicks, rational, sampleToTicks, secondsToTicks, snapToFrame, TICKS_PER_SECOND, ticksPerFrame, ticksToFrame } from "../src";

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
