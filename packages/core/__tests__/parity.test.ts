import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { renderProject } from "@beacon/render";
import { LocalCore } from "../src";

const HERMES = join(homedir(), "client-videos/personal/hermes.cmproj");
const dir = mkdtempSync(join(tmpdir(), "ot-parity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** RGBA of a PNG, scaled with an area filter when `width` is given. */
async function rgba(png: string, width?: number): Promise<Uint8Array> {
  const scale = width ? ["-vf", `scale=${width}:-2:flags=area`] : [];
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", png, ...scale, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c]! - b[i + c]!;
      se += d * d;
      n++;
    }
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

test.skipIf(!existsSync(HERMES))(
  "the preview shows what the export renders",
  async () => {
    const core = new LocalCore();
    const h = await core.create({ path: join(dir, "hermes.beproj"), cmproj: HERMES });
    const doc = core.doc(h);
    const seconds = [5, 40, 100, 200, 330];
    const frames = seconds.map((s) => s * 30);
    await renderProject(doc, core.registry, { output: { kind: "png", dir: join(dir, "export") }, frames, cacheDir: core.cacheDir });

    // At the canvas size the preview is the export, pixel for pixel; smaller, only the downscale filter differs.
    for (const [width, height, min] of [
      [1920, 1080, Infinity],
      [960, 540, 50],
    ] as const) {
      const view = core.attachView(h, { offscreen: { width, height } });
      for (const [i, s] of seconds.entries()) {
        view.show(s);
        view.settle();
        const shown = view.flush()!;
        const exported = await rgba(join(dir, "export", `f${String(frames[i]).padStart(6, "0")}.png`), width === 1920 ? undefined : width);
        expect(shown.length).toBe(exported.length);
        const db = psnr(shown, exported);
        expect(db, `${width}x${height} at ${s} s: ${db.toFixed(1)} dB`).toBeGreaterThanOrEqual(min);
      }
      core.detachView(h);
    }
    await core.close(h);
  },
  300_000,
);
