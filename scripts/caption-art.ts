/**
 * The Look menu's pictures for Caption Properties: each caption look drawn by Beacon's own renderer ("Aa Bb Cc", Bb
 * a keyword), cropped to the caption, saved as packages/ui/src/art/caption-<look>.webp. Then
 * `bun scripts/effect-art.ts css` inlines them into art.css.
 *
 *   bun scripts/caption-art.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "@beacon/core";

const ART = join(import.meta.dir, "../packages/ui/src/art");
const [W, H] = [1920, 1080];
const dir = mkdtempSync(join(tmpdir(), "beacon-caption-art-"));
const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
const h = await core.create({ path: join(dir, "art.beproj") });
await core.run(h, "project.settings.set", { width: W, height: H, background: "#0d0f0e" });
const track = (await core.run(h, "track.add", { name: "Captions" })).results[0] as string;
const words = ["Aa", "Bb", "Cc"].map((text, i) => ({ text, start: 0.1 + i * 0.3, end: 0.35 + i * 0.3, ...(i === 1 ? { em: true } : {}) }));
await core.run(h, "clip.add", { track, type: "caption", start: 0, duration: 3, mediaStart: 0, props: { caption: { words } } });

const looks = (await core.query(h, "captions.presets")) as { id: string; title: string }[];
for (const look of looks) {
  await core.run(h, "captions.preset", { preset: look.id, track });
  const png = join(dir, `${look.id}.png`);
  // Late in the clip: every word revealed, the entrances settled.
  writeFileSync(png, (await core.frame(h, 2.4)).png);
  // Cropped to what the caption drew (pixels brighter than the background), with room around it, then fitted into
  // a 3:2 tile.
  const gray = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"]).stdout;
  let [x0, y0, x1, y1] = [W, H, 0, 0];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (gray[y * W + x]! > 40) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  if (x1 < x0) [x0, y0, x1, y1] = [0, 0, W - 1, H - 1];
  const pad = Math.max(24, (y1 - y0) * 0.35);
  // At least as wide as 3:2 of its height, so a short caption isn't blown up past the tile.
  let [bw, bh] = [x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  if (bw < bh * 1.5) bw = bh * 1.5;
  else bh = Math.max(bh, bw / 1.5 / 1.6);
  const box = { w: Math.round(Math.min(W, bw)), h: Math.round(Math.min(H, bh)) };
  const at = { x: Math.round(Math.max(0, Math.min(W - box.w, (x0 + x1) / 2 - box.w / 2))), y: Math.round(Math.max(0, Math.min(H - box.h, (y0 + y1) / 2 - box.h / 2))) };
  const out = join(ART, `caption-${look.id}.webp`);
  const filter = `crop=${box.w}:${box.h}:${at.x}:${at.y},scale=384:256:force_original_aspect_ratio=decrease,pad=384:256:(ow-iw)/2:(oh-ih)/2:color=0x0d0f0e`;
  const ff = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", png, "-vf", filter, "-c:v", "libwebp", "-quality", "85", out]);
  if (ff.exitCode !== 0) throw new Error(`${look.id}: ffmpeg failed: ${ff.stderr}`);
  console.log(`${look.id}: ${readFileSync(out).length} bytes`);
}
await core.close(h);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
