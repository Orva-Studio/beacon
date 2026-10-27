import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-highlight-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rgba(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

test("a Highlight multiplies its colour onto what is under the box at its opacity, and Invert colours everything outside it instead", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const h = await core.create({ path: join(dir, "highlight.beproj") });
  await core.run(h, "project.settings.set", { background: "#ffffff" });
  await core.run(h, "edit.addAnnotation", { preset: "highlight" });
  const clip = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.type === "region")!;
  expect(clip.props.region).toMatchObject({ kind: "highlight", intensity: 0.5, invert: false });
  const { width, height } = core.doc(h).settings;
  let n = 0;
  const render = async () => {
    const name = `f${n++}`;
    await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, name) }, frames: [15], cacheDir: core.cacheDir });
    const px = await rgba(join(dir, name, "f000015.png"));
    const at = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    return { middle: at(width / 2, height / 2), corner: at(10, 10) };
  };
  const near = (got: number[], want: number[]) => expect(got.every((v, i) => Math.abs(v - want[i]!) <= 4)).toBe(true);
  const [r, g, b] = (clip.props.region as { color: number[] }).color.map((v) => Math.round(v * 255));

  // Half way to the colour over white inside; white outside.
  let f = await render();
  near(f.middle, [Math.round((255 + r!) / 2), Math.round((255 + g!) / 2), Math.round((255 + b!) / 2)]);
  near(f.corner, [255, 255, 255]);
  // Fully: white times the colour is the colour.
  await core.run(h, "clip.set", { clip: clip.id, props: { region: { intensity: 1 } } });
  f = await render();
  near(f.middle, [r!, g!, b!]);
  // Inverted: the box left as it is, everything around it coloured.
  await core.run(h, "clip.set", { clip: clip.id, props: { region: { invert: true } } });
  f = await render();
  near(f.middle, [255, 255, 255]);
  near(f.corner, [r!, g!, b!]);
  await core.close(h);
}, 60_000);
