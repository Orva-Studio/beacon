import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video-3.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-border-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rgba(png: string): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

test.skipIf(!existsSync(VIDEO))(
  "a border is drawn just inside the clip's rounded edge, the same in preview and export",
  async () => {
    const video = join(dir, "camera.mp4");
    copyFileSync(VIDEO, video);
    const core = new LocalCore({ cacheDir: join(dir, "cache") });
    const h = await core.create({ path: join(dir, "border.beproj") });
    const { clips } = await core.import(h, [video], { at: 0 });
    const clip = clips[0]!;
    const { width, height } = core.doc(h).settings;
    const t = (core.doc(h).tracks.flatMap((k) => k.clips).find((c) => c.id === clip)!.props.transform ?? {}) as { scaleX?: number; scaleY?: number };
    await core.run(h, "clip.set", { clip, props: { transform: { scaleX: (t.scaleX ?? 1) * 0.5, scaleY: (t.scaleY ?? 1) * 0.5 } } });
    await core.run(h, "effect.add", { clip, type: "round-corners", params: { radius: 60 } });

    const render = async (name: string) => {
      await renderProject(core.doc(h), core.registry, { output: { kind: "png", dir: join(dir, name) }, frames: [30], cacheDir: core.cacheDir });
      return rgba(join(dir, name, "f000030.png"));
    };
    const plain = await render("plain");
    await core.run(h, "clip.set", { clips: [clip], props: { border: { thickness: 12, color: [1, 0, 0, 1] } } });
    const bordered = await render("bordered");

    const px = (img: Uint8Array, x: number, y: number) => img.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
    const differs = (x: number, y: number) => px(plain, x, y).some((v, i) => Math.abs(v - px(bordered, x, y)[i]!) > 8);
    const red = (x: number, y: number) => {
      const [r, g, b] = px(bordered, x, y);
      return r! > 240 && g! < 15 && b! < 15;
    };
    // Along the middle row and column, the first pixels the border changes are its band: 12 pixels of red where the clip starts.
    const [row, col] = [Math.floor(height / 2), Math.floor(width / 2)];
    const left = Array.from({ length: width }, (_, x) => x).find((x) => differs(x, row))!;
    const right = Array.from({ length: width }, (_, x) => width - 1 - x).find((x) => differs(x, row))!;
    const top = Array.from({ length: height }, (_, y) => y).find((y) => differs(col, y))!;
    expect(left).toBeGreaterThan(width * 0.2);
    expect(right).toBeLessThan(width * 0.8);
    for (const edge of [left, right - 11]) expect(Array.from({ length: 16 }, (_, i) => edge - 2 + i).filter((x) => red(x, row)).length).toBe(12);
    expect(Array.from({ length: 16 }, (_, i) => top - 2 + i).filter((y) => red(col, y)).length).toBe(12);
    for (let x = left + 14; x < right - 14; x += 7) expect(differs(x, row)).toBe(false);
    // At the top-left corner the band follows Round Corners' curve: red just inside it, nothing drawn outside it.
    const [cx, cy, d] = [left + 60, top + 60, Math.SQRT1_2];
    expect(red(Math.round(cx - 54 * d), Math.round(cy - 54 * d))).toBe(true);
    expect(differs(Math.round(cx - 64 * d), Math.round(cy - 64 * d))).toBe(false);
    expect(differs(left + 2, top + 2)).toBe(false);

    const view = core.attachView(h, { offscreen: { width, height } });
    view.show(1);
    view.settle();
    const shown = view.flush()!;
    core.detachView(h);
    expect(shown.length).toBe(bordered.length);
    let diff = 0;
    for (let i = 0; i < shown.length; i++) diff = Math.max(diff, Math.abs(shown[i]! - bordered[i]!));
    expect(diff).toBe(0);
    await core.close(h);
  },
  120_000,
);
