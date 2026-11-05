import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import tealStudio from "./rooms/teal-studio.jpg" with { type: "file" };
import night from "./rooms/night.jpg" with { type: "file" };
import day from "./rooms/day.jpg" with { type: "file" };
import reflection from "./rooms/reflection.jpg" with { type: "file" };
import nightReflection from "./rooms/reflection-night.jpg" with { type: "file" };
import dayReflection from "./rooms/reflection-day.jpg" with { type: "file" };
import studioReflection from "./rooms/reflection-studio.jpg" with { type: "file" };

/**
 * The room behind the monitor, 1536×1024: made with gpt-image-2.5-flare, the least busy of the four tried, the user's
 * pick (2026-11-04); straight on, as the shot is.
 */
export const ROOM_SIZE: [number, number] = [1536, 1024];

/**
 * Rooms all round the monitor, as 360° panoramas (equirectangular, 4096×2048): flux-3-image, upscaled 4× by Topaz,
 * the user's picks (2026-11-05). The camera looks into them by its direction, so turning it shows the right part of
 * the room behind the monitor. `centre`: the share across the panorama that sits straight behind the monitor.
 */
export const PANORAMAS = {
  night: { image: night, centre: 0.53 },
  day: { image: day, centre: 0.67 },
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
/**
 * What glossy glass mirrors, 512×342, blurred: the room behind the camera with someone standing in it
 * (gpt-image-2.6-sunburst, the user preferred it to the rooms' own reflections, 2026-11-05), each room blended in
 * (Night's window, Day's shelves, the studio's teal) so they differ a little; no room has it as it is. `mirror`: how
 * much of it the glass gives back at Reflection 100% (the day's is brighter).
 */
export const REFLECTION_SIZE: [number, number] = [512, 342];
const REFLECTIONS = {
  night: { image: nightReflection, mirror: 2.4 },
  day: { image: dayReflection, mirror: 1.5 },
  "teal-studio": { image: studioReflection, mirror: 2.4 },
  none: { image: reflection, mirror: 2.4 },
} as const;
export const reflectionOf = (room: keyof typeof REFLECTIONS) => ({ path: onDisk(REFLECTIONS[room].image), mirror: REFLECTIONS[room].mirror });
