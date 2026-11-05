import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import tealStudio from "./rooms/teal-studio.jpg" with { type: "file" };
import night from "./rooms/night.jpg" with { type: "file" };
import nightReflection from "./rooms/night-reflection.jpg" with { type: "file" };
import day from "./rooms/day.jpg" with { type: "file" };
import dayReflection from "./rooms/day-reflection.jpg" with { type: "file" };

/**
 * The room behind the monitor, 1536×1024: made with gpt-image-2.5-flare, the least busy of the four tried, the user's
 * pick (2026-11-04); straight on, as the shot is.
 */
export const ROOM_SIZE: [number, number] = [1536, 1024];

/**
 * Rooms all round the monitor, as 360° panoramas (equirectangular, 4096×2048): flux-3-image, upscaled 4× by Topaz,
 * the user's picks (2026-11-05). The camera looks into them by its direction, so turning it shows the right part of
 * the room behind the monitor. `centre`: the share across the panorama that sits straight behind the monitor.
 * `reflection`: the same room, 512×256, turned half round (what is behind the camera in its middle) and blurred;
 * `mirror`, how much of it the glass gives back at Reflection 100% (a daylit room is far brighter than the night's).
 */
export const PANORAMAS = {
  night: { image: night, reflection: nightReflection, centre: 0.53, mirror: 2.4 },
  day: { image: day, reflection: dayReflection, centre: 0.67, mirror: 0.35 },
} as const;
export type Panorama = keyof typeof PANORAMAS;

const ready = new Map<string, string>();

/**
 * A bundled picture on disk for the renderer. Bundled, the import may be relative to the bundle or inside a compiled
 * binary's own file system, which the renderer can't open: then it is copied out once to the temp folder.
 */
function onDisk(src: string): string {
  const known = ready.get(src);
  if (known) return known;
  const abs = isAbsolute(src) ? src : resolve(import.meta.dir, src);
  let path = abs;
  if (abs.startsWith("/$bunfs") || !existsSync(abs)) {
    const dir = join(tmpdir(), "beacon-rooms");
    mkdirSync(dir, { recursive: true });
    path = join(dir, basename(abs));
    if (!existsSync(path)) {
      try {
        writeFileSync(path, readFileSync(src));
      } catch {
        copyFileSync(abs, path);
      }
    }
  }
  ready.set(src, path);
  return path;
}

export const roomPath = () => onDisk(tealStudio);
export const panoramaPath = (room: Panorama) => onDisk(PANORAMAS[room].image);
export const reflectionPath = (room: Panorama) => onDisk(PANORAMAS[room].reflection);
