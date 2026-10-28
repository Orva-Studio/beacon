import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animatedValue, secondsToTicks } from "@beacon/model";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-animate-region-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a highlight's width animates: Add Animation holds the region's animatable fields, so a width set after it goes to the block, not the whole clip; undone exactly", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "p.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "highlight", time: 0, duration: 5 });
  const clip = () => core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "region")!;
  const width = (clip().props.region as { width: number }).width;
  await core.run(h, "edit.addAnimation", { clip: clip().id, time: 1, duration: 1 });
  const [block] = clip().animations;
  expect(block!.to).toMatchObject({ "region.width": width, "region.height": expect.any(Number), "region.intensity": expect.any(Number) });
  expect(Object.keys(block!.to).some((k) => k.startsWith("audio."))).toBe(false);
  const before = JSON.stringify(core.doc(h));
  await core.run(h, "clip.set", { clip: clip().id, props: { region: { width: 200 } }, at: 3 });
  expect((clip().props.region as { width: number }).width).toBe(width);
  const at = (s: number) => animatedValue(width, "region.width", clip().animations, secondsToTicks(s));
  expect([at(0.5), at(1.5), at(3)]).toEqual([width, (width + 200) / 2, 200]);
  await core.undo(h);
  expect(JSON.stringify(core.doc(h))).toBe(before);
  await core.close(h);
});
