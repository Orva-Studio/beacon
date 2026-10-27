import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-motion-blur-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rgba(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

test("motion blur over a zoom keeps a dark fill its own colour: the samples add up without banding or tints", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "blur.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "rectangle", time: 0, duration: 3 });
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "callout")!;
  // Dark enough that each of the 16 samples rounded to 8 bits on its own was off by up to 6.
  const fill = [18, 26, 36];
  await core.run(h, "clip.set", { clip: clip.id, props: { callout: { width: 1600, height: 900, fill: [...fill.map((v) => v / 255), 1] } } });
  await core.run(h, "animation.add", { clip: clip.id, end: 2, duration: 1, to: { "transform.scaleX": 1.14, "transform.scaleY": 1.14 } });
  await core.run(h, "effect.add", { clip: clip.id, type: "motion-blur" });
  const { width, height, fps } = core.doc(h).settings;
  const frame = Math.round((1.5 * fps.num) / fps.den);
  await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, "out") }, frames: [frame], cacheDir: core.cacheDir });
  const px = await rgba(join(dir, "out", `f${String(frame).padStart(6, "0")}.png`));
  const at = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  for (const [x, y] of [[width / 2, height / 2], [width / 2 - 300, height / 2 + 200], [width / 2 + 500, height / 2 - 250]] as const) {
    const got = at(x, y);
    expect(got.every((v, i) => Math.abs(v - fill[i]!) <= 1)).toBe(true);
  }
  await core.close(h);
}, 60_000);
