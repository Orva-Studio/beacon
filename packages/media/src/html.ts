import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegArgs, jobSignal, runTool, tool } from "./tool";

export interface HtmlRender {
  /** The page: a whole HTML document, its animations seekable (CSS, Web Animations, or its own `window.__seek(t)`). */
  html: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** Where the clip goes: a .mov, ProRes 4444 with its transparency. */
  out: string;
  /** 0–1 as frames are drawn. */
  progress?: (fraction: number) => void;
}

/**
 * An HTML page drawn frame by frame by WebKit (beacon-html) and made into a clip with alpha by Beacon's FFmpeg:
 * how motion graphics are rendered. The page is kept in a folder of its own while it is drawn, so it can only read
 * files put beside it.
 */
export async function renderHtml(r: HtmlRender): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-html-"));
  try {
    const page = join(dir, "page.html");
    const frames = join(dir, "frames");
    mkdirSync(frames);
    writeFileSync(page, r.html);
    const count = Math.max(1, Math.round(r.seconds * r.fps));
    const request = join(dir, "request.json");
    writeFileSync(request, JSON.stringify({ page, out: frames, width: Math.round(r.width), height: Math.round(r.height), fps: r.fps, frames: count }));
    try {
      await runTool([tool("beacon-html"), request], {
        onStderr: (chunk) => {
          const n = [...chunk.matchAll(/frame (\d+)/g)].at(-1)?.[1];
          if (n) r.progress?.(Number(n) / count);
        },
      });
    } catch (e) {
      jobSignal()?.throwIfAborted();
      throw new Error((e as Error).message.replace(/^.*? exited with \d+: /, "the motion graphic couldn't be drawn: "));
    }
    await runTool([...ffmpegArgs(), "-y", "-framerate", String(r.fps), "-i", join(frames, "f%05d.png"), "-c:v", "prores_videotoolbox", "-profile:v", "4444", "-pix_fmt", "bgra", r.out]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
