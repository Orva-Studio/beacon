import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { jobSignal, runTool, tool } from "@beacon/media";
import {
  eachRawClip,
  clipEnd,
  clipSpeed,
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  findClip,
  secondsToTicks,
  snapSeconds,
  ticksPerFrame,
  ticksToSeconds,
  type ActionContext,
  type Clip,
  type FeatureRegistry,
  type Project,
  type Session,
  type SessionCommandDef,
  type Track,
} from "@beacon/model";
import { mediaInfo, sourceOf, streamOf, visualSize } from "../media";
import { download, predict, upload, type MakeStage } from "../broll/replicate";
import { brief, VIEWS, type View } from "./brief";

const TOKEN = "replicate-api-token";
/** Settings › AI's limit per generation, shared with B-roll (the user, 2026-11-04). */
const LIMIT = "brollLimit";
/** What the upscaler makes of Seedance's 480p (Settings › AI): 1080p by default, 2K or 4K for more. */
const RESOLUTION = "angleResolution";
const RESOLUTIONS = [
  { id: "1080p", title: "1080p", description: "Full HD: the default" },
  { id: "2k", title: "2K", description: "1440p: sharper, a larger file" },
  { id: "4k", title: "4K", description: "2160p: the upscaler's most, the largest file" },
];
const SEEDANCE = { slug: "bytedance/seedance-2.5", title: "Seedance 2.5" };
const UPSCALER = { slug: "bytedance/video-upscaler", title: "ByteDance's upscaler" };
/** Seedance 2.5 at 480p with a video in, per second it makes (Replicate, 2026-11-03). */
const PRICE = 0.4304;
/** Seedance makes 4 s at least: an angle is generated as the 4 s from its start and trimmed to its length. */
const SHORTEST = 4;
/** An angle is a cutaway of at most 3 s (the user, 2026-11-04). */
const LONGEST = 3;
const TRACK = "Angles";
/** How much closer a close-up made by cropping is: it needs this many times the pixels it is shown at. */
const ZOOM = 1.6;
/** Where a close-up crop centres, down the camera's picture: a face sits a little above the middle. */
const FACE_Y = 0.38;

const angleGroup = z.strictObject({
  view: z.enum(Object.keys(VIEWS) as [View, ...View[]]),
  move: z.enum(["handheld", "locked"]),
  /** A few words of the user's own, added to the brief. */
  note: z.string().max(300),
  /** As `{ assetId }`, so copying the clip carries every take along. */
  takes: z.array(z.strictObject({ assetId: z.string() })),
  /** Shown as a crop of the camera's own frames (a close-up from 4K), not generated. */
  crop: z.boolean(),
});
export type AngleProps = z.infer<typeof angleGroup>;
const DEFAULTS: AngleProps = { view: "three-quarter-left", move: "handheld", note: "", takes: [], crop: false };

/** The room photos an Angles track's angles are made with (`track.props.angleRoom`): image assets. */
const roomGroup = z.strictObject({ photos: z.array(z.string()) });

export const angleOf = (c: Clip) => c.props.angle as AngleProps | undefined;

/** What camera angles are doing for which clips (`session.features.angles`): being made, and why the last try failed. */
export interface AngleState {
  making: string[];
  errors: Record<string, string>;
}
const IDLE: AngleState = { making: [], errors: {} };
export const angleState = (s: Session) => (s.features.angles as AngleState | undefined) ?? IDLE;

/** What made a take, on its asset (`derived.angle`). */
export interface AngleTakeInfo {
  view: View;
  prompt: string;
  /** Dollars Seedance charged by its price; the upscaler's isn't known to a token. */
  cost: number;
  seconds: number;
}

const fail = (message: string): never => {
  throw new Error(message);
};

/** Media seconds a clip shows at timeline second `t`. */
const mediaAt = (c: Clip, t: number) => ticksToSeconds(c.mediaStart ?? 0) + (t - ticksToSeconds(c.start)) * clipSpeed(c);

/** The camera an angle is of: the top shown video clip under it on the tracks below `below`, over all of [from, to). */
function cameraAt(project: Project, from: number, to: number, below = project.tracks.length): { camera: Clip; track: Track; index: number } | undefined {
  for (let i = Math.min(below, project.tracks.length) - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.hidden) continue;
    const camera = track.clips.find((c) => c.type === "video" && c.assetId && ticksToSeconds(c.start) <= from + 1e-6 && ticksToSeconds(clipEnd(c)) >= to - 1e-6);
    if (camera) return { camera, track, index: i };
  }
  return undefined;
}

function cameraOf(project: Project, registry: FeatureRegistry, clip: Clip) {
  const { track } = findClip(project, registry, clip.id);
  const at = cameraAt(project, ticksToSeconds(clip.start), ticksToSeconds(clipEnd(clip)), project.tracks.indexOf(track));
  return at ?? fail("an angle sits over one camera clip, all of it: move or trim it onto the camera");
}

/** The camera's sound: its linked audio clip's, else its own first audio stream. */
function soundOf(project: Project, camera: Clip): { clip: Clip; stream: number } | undefined {
  const linked = camera.linkId ? project.tracks.flatMap((t) => t.clips).find((c) => c.linkId === camera.linkId && c.type === "audio" && c.assetId) : undefined;
  if (linked) return { clip: linked, stream: (linked.props.media as { stream?: number } | undefined)?.stream ?? 0 };
  const asset = project.assets[camera.assetId!];
  return asset && mediaInfo(asset).streams.some((s) => s.kind === "audio") ? { clip: camera, stream: 0 } : undefined;
}

type Box = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
type Sides = { left: number; right: number; top: number; bottom: number };
const boxOf = (c: Clip): Box => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...(c.props.transform as Partial<Box> | undefined) });
const sidesOf = (c: Clip): Sides => ({ left: 0, right: 0, top: 0, bottom: 0, ...(c.props.crop as Partial<Sides> | undefined) });

/** Footage `W` wide shown where the camera (`cw` wide) is: its scale and crop the camera's, in the footage's pixels. */
function placedLike(camera: Clip, cw: number, W: number) {
  const k = cw / W;
  const t = boxOf(camera);
  const s = sidesOf(camera);
  return { transform: { ...(camera.props.transform as object), scaleX: t.scaleX * k, scaleY: t.scaleY * k }, crop: { left: s.left / k, right: s.right / k, top: s.top / k, bottom: s.bottom / k } };
}

/** Whether the camera has the pixels for a close-up by cropping: `ZOOM` times what it is shown at. */
function canCrop(project: Project, registry: FeatureRegistry, camera: Clip): boolean {
  const size = visualSize(project, registry, camera);
  if (!size) return false;
  const s = sidesOf(camera);
  const shown = Math.abs((size[1] - s.top - s.bottom) * boxOf(camera).scaleY);
  return size[1] - s.top - s.bottom >= shown * ZOOM - 1e-6;
}

/** Seconds of the take an angle is generated from, and what Seedance charges for them. */
const cost = (clip: Clip) => {
  const seconds = Math.max(SHORTEST, Math.ceil(ticksToSeconds(clip.duration)));
  return { seconds, cost: Math.round(seconds * PRICE * 100) / 100 };
};

/** A name in `dir` not yet taken: `stem.mp4`, `stem 2.mp4`, … */
function freeName(dir: string, stem: string): string {
  for (let n = 1; ; n++) {
    const p = join(dir, `${stem}${n === 1 ? "" : ` ${n}`}.mp4`);
    if (!existsSync(p)) return p;
  }
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".webp": "image/webp" };

const commands = [
  defineCommand({
    id: "angle.add",
    description:
      "An Angle clip over a camera clip (`camera`), from `start` for `duration` seconds (at most 3), on an Angles track right above the camera's: nothing shows until it is generated (angle.generate) or made as a close-up crop (angle.crop). Returns its id",
    args: z.strictObject({ camera: z.string().min(1), start: z.number().nonnegative(), duration: z.number().positive().default(LONGEST) }),
    apply(doc, { camera: id, start, duration }, ctx) {
      const { clip: camera, track } = findClip(doc, ctx.registry, id);
      if (camera.type !== "video" || !camera.assetId) throw new Error(`clip "${id}" isn't a camera or video clip`);
      const fps = doc.settings.fps;
      const from = Math.max(camera.start, snapSeconds(start, fps));
      const to = Math.min(clipEnd(camera), from + snapSeconds(Math.min(duration, LONGEST), fps));
      if (to - from < ticksPerFrame(fps)) throw new Error("that's past the camera clip's end");
      const at = doc.tracks.indexOf(track);
      const free = (t: Track | undefined) => !!t && t.name === TRACK && !t.locked && t.clips.every((c) => clipEnd(c) <= from || c.start >= to);
      let angles = doc.tracks[at + 1];
      if (!free(angles)) {
        angles = { id: ctx.newId("track"), name: TRACK, clips: [] };
        doc.tracks.splice(at + 1, 0, angles);
      }
      const clipId = ctx.newId("clip");
      angles!.clips.push({ id: clipId, type: "angle", start: from, duration: to - from, mediaStart: 0, props: { angle: { ...DEFAULTS } }, effects: [], animations: [] });
      angles!.clips.sort((a, b) => a.start - b.start);
      return clipId;
    },
  }),
  defineCommand({
    id: "angle.use",
    description: "Show `asset` (footage an angle made) in an Angle clip, where its camera shows, its first frame at the clip's start, and keep it among its takes. Picking an earlier take is the same command",
    args: z.strictObject({ clip: z.string().min(1), asset: z.string().min(1) }),
    apply(doc, { clip: id, asset }, ctx) {
      const { clip, track } = findClip(doc, ctx.registry, id);
      const a = angleOf(clip);
      if (clip.type !== "angle" || !a) throw new Error(`clip "${id}" isn't an angle`);
      if (track.locked) throw new Error(`track "${track.name}" is locked`);
      const footage = doc.assets[asset] ?? fail(`no asset "${asset}"`);
      const s = streamOf(footage, "video", 0);
      const { camera } = cameraOf(doc, ctx.registry, clip);
      const [cw] = visualSize(doc, ctx.registry, camera) ?? [s.width!];
      Object.assign(clip.props, placedLike(camera, cw, s.width!));
      clip.assetId = asset;
      clip.mediaStart = 0;
      delete clip.speed;
      clip.props.media = { stream: 0 };
      clip.props.angle = { ...a, crop: false, takes: a.takes.some((t) => t.assetId === asset) ? a.takes : [...a.takes, { assetId: asset }] };
      clip.duration = Math.min(clip.duration, secondsToTicks(s.duration));
    },
  }),
  defineCommand({
    id: "angle.crop",
    description:
      "Make an Angle clip a close-up by cropping into its camera's own frames: free, in sync, no generation; only where the camera has 1.6 times the pixels it is shown at (a 4K camera in a 1080p project), as angle.estimate's `crop` says",
    args: z.strictObject({ clip: z.string().min(1) }),
    apply(doc, { clip: id }, ctx) {
      const { clip, track } = findClip(doc, ctx.registry, id);
      const a = angleOf(clip);
      if (clip.type !== "angle" || !a) throw new Error(`clip "${id}" isn't an angle`);
      if (track.locked) throw new Error(`track "${track.name}" is locked`);
      const { camera } = cameraOf(doc, ctx.registry, clip);
      if (!canCrop(doc, ctx.registry, camera)) throw new Error("the camera doesn't have the pixels for a close-up crop here: generate the close-up instead");
      const [W, H] = visualSize(doc, ctx.registry, camera)!;
      const was = sidesOf(camera);
      const t = boxOf(camera);
      const [vw, vh] = [W - was.left - was.right, H - was.top - was.bottom];
      const [w, h] = [vw / ZOOM, vh / ZOOM];
      const left = was.left + (vw - w) / 2;
      const top = Math.min(was.top + vh - h, Math.max(was.top, was.top + vh * FACE_Y - h / 2));
      const crop = { left, right: W - left - w, top, bottom: H - top - h };
      const scale = { scaleX: t.scaleX * ZOOM, scaleY: t.scaleY * ZOOM };
      // The picture stays where the camera's was: an off-centre crop moves the shown part's centre, which the position undoes.
      const off = (s: Sides, sx: number, sy: number) => [((s.left - s.right) / 2) * sx, ((s.top - s.bottom) / 2) * sy] as const;
      const [dx0, dy0] = off(was, t.scaleX, t.scaleY);
      const [dx1, dy1] = off(crop, scale.scaleX, scale.scaleY);
      const [cos, sin] = [Math.cos(t.rotation), Math.sin(t.rotation)];
      const x = t.x + cos * (dx0 - dx1) + sin * (dy0 - dy1);
      const y = t.y + sin * (dx0 - dx1) - cos * (dy0 - dy1);
      clip.assetId = camera.assetId;
      clip.mediaStart = secondsToTicks(mediaAt(camera, ticksToSeconds(clip.start)));
      if (camera.speed) clip.speed = camera.speed;
      else delete clip.speed;
      clip.props.media = { ...(camera.props.media as object) };
      clip.props.transform = { ...(camera.props.transform as object), ...scale, x, y };
      clip.props.crop = crop;
      clip.props.angle = { ...a, view: "closeup", crop: true };
    },
  }),
  defineCommand({
    id: "angles.room",
    description: "The room photos (image assets) an Angles track's angles are made with, for a truer set: photos of the room from the new angle's side, with the lights you record with",
    args: z.strictObject({ track: z.string().min(1), photos: z.array(z.string().min(1)).max(4) }),
    apply(doc, { track: id, photos }) {
      const track = doc.tracks.find((t) => t.id === id) ?? fail(`no track "${id}"`);
      for (const p of photos) if (doc.assets[p]?.kind !== "image") throw new Error(`"${p}" isn't an image in the Media Bin`);
      track.props = { ...track.props, angleRoom: { photos } };
    },
  }),
];

const sessionCommands: SessionCommandDef[] = [
  {
    id: "angles.status",
    description: "Mark Angle clips as being made, or not (angle.generate does), with why the last try failed (`error`, null to clear)",
    args: z.strictObject({ clips: z.array(z.string()), making: z.boolean().optional(), error: z.string().nullable().optional() }),
    apply: (s, { clips, making, error }: { clips: string[]; making?: boolean; error?: string | null }) => {
      const was = angleState(s);
      const list = making === undefined ? was.making : making ? [...new Set([...was.making, ...clips])] : was.making.filter((id) => !clips.includes(id));
      const errors = { ...was.errors };
      for (const id of clips) if (error === null || making) delete errors[id];
      if (error) for (const id of clips) errors[id] = error;
      s.features.angles = { making: list, errors } satisfies AngleState;
    },
  },
];

/** The Angle clip an action works on: the one given, else the selected one. */
function target(ctx: ActionContext, id?: string): Clip {
  const all = ctx.scope.tracks.flatMap((t) => t.clips);
  const clip = id ? (all.find((c) => c.id === id) ?? fail(`no clip "${id}" on the timeline`)) : all.find((c) => ctx.session.selection.includes(c.id) && c.type === "angle");
  if (!clip || clip.type !== "angle") throw new Error("select an Angle clip first (the AI panel's Camera Angle tile adds one)");
  return clip;
}

/** Where an angle's job is: cutting, uploading, on Replicate, downloading. */
const STAGES: Record<string, string> = { cutting: "Cutting the take", uploading: "Uploading the take", queued: "Waiting its turn on Replicate", making: "Seedance is re-filming it", upscaling: "Upscaling to 1080p", downloading: "Downloading" };

const angleAdd = defineAction({
  id: "angles.add",
  description:
    "Add an Angle clip (the AI panel's Camera Angle tile, or a camera's right-click › New Angle Here with `camera`): over the in/out range (at most 3 s) or 3 s from the playhead, above the camera showing there (or `camera`, from its start when neither is on it), then select it and show its Camera Angle tab",
  args: z.strictObject({ camera: z.string().min(1).optional() }),
  resolve: ({ camera: id }, ctx) => {
    const range = ctx.session.range;
    let from = range ? range.in : ctx.session.playhead;
    let to = range ? Math.min(range.out, from + LONGEST) : from + 0.04;
    let camera: Clip;
    if (id) {
      const c = findClip(ctx.project, ctx.registry, id).clip;
      if (c.type !== "video" || !c.assetId) fail("New Angle Here is for a camera clip: an angle is made of the camera under it");
      camera = c;
      const [start, end] = [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))];
      if (from < start - 1e-6 || from >= end - 1e-6) [from, to] = [start, start + 0.04];
      to = Math.min(to, end);
      if (!range || to - from < 0.04) to = Math.min(end, from + LONGEST);
    } else {
      camera = (cameraAt(ctx.project, from, to) ?? fail(range ? "no camera clip covers the in/out range: an angle is made of the camera under it" : "no camera clip at the playhead: an angle is made of the camera under it")).camera;
      if (!range) to = from + LONGEST;
    }
    return {
      label: "Add Camera Angle",
      steps: [{ command: "angle.add", args: { camera: camera.id, start: from, duration: Math.min(LONGEST, to - from) } }],
      after: ([id]) => [{ command: "selection.set", args: { clips: [id] } }, { command: "inspector.tab", args: { tab: "angle" } }],
    };
  },
});

const angleGenerate = defineAction({
  id: "angle.generate",
  description:
    "Generate an Angle clip (`clip`, else the selected one) through Replicate on the user's token: the 4 s of its camera and sound from its start (Seedance's shortest), and the Angles track's room photos, are sent to Seedance 2.5 (480p, re-filmed from the angle with the speaker's lips kept to their sound), then ByteDance's upscaler to 1080p; saved in the project's media/Angles folder, added to the Media Bin and shown in the clip, one undo step. Replicate charges the user's account (angle.estimate says how much); refused over the limit per generation in Settings › AI. Runs as a job. Only when the user asks: it spends their money",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const clip = target(ctx, id);
    const a = angleOf(clip)!;
    if (angleState(ctx.session).making.includes(clip.id)) throw new Error("that angle is being made already");
    const { camera } = cameraOf(ctx.project, ctx.registry, clip);
    const sound = soundOf(ctx.project, camera) ?? fail("the camera has no sound linked to it: an angle keeps the lips to the take's own sound");
    const { seconds, cost: price } = cost(clip);
    const limit = Number(ctx.pref(LIMIT)) || 0;
    const resolution = RESOLUTIONS.some((r) => r.id === ctx.pref(RESOLUTION)) ? String(ctx.pref(RESOLUTION)) : "1080p";
    if (limit > 0 && price > limit) throw new Error(`about $${price.toFixed(2)} for Seedance alone, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const track = ctx.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    const photos = ((track?.props?.angleRoom as { photos?: string[] } | undefined)?.photos ?? []).flatMap((p) => {
      const asset = ctx.project.assets[p];
      return asset && existsSync(asset.path) ? [asset] : [];
    });
    const start = ticksToSeconds(clip.start);
    const video = sourceOf(ctx.project.assets[camera.assetId!]!, "video", (camera.props.media as { stream?: number } | undefined)?.stream ?? 0);
    const audio = sourceOf(ctx.project.assets[sound.clip.assetId!]!, "audio", sound.stream);
    const [vFrom, aFrom] = [mediaAt(camera, start), mediaAt(sound.clip, start)];
    const prompt = brief({ view: a.view, move: a.move, note: a.note, photos: photos.length });
    const fps = [24, 30, 60].reduce((best, f) => (Math.abs(f - ctx.project.settings.fps.num / ctx.project.settings.fps.den) < Math.abs(best - ctx.project.settings.fps.num / ctx.project.settings.fps.den) ? f : best), 30);
    const ids = [clip.id];
    return {
      label: "Generate Camera Angle",
      before: [{ command: "angles.status", args: { clips: ids, making: true } }],
      task: {
        label: `Camera angle: ${VIEWS[a.view].title}`,
        run: async (env) => {
          const tell = (f: number, s: string) => env.progress(f, STAGES[s] ?? s);
          const token = (await env.secret(TOKEN)) ?? fail("no Replicate API token: add one in Settings › AI");
          const tmp = mkdtempSync(join(tmpdir(), "beacon-angle-"));
          try {
            tell(0.02, "cutting");
            const take = join(tmp, "take.mp4");
            const said = join(tmp, "said.wav");
            await runTool([tool("ffmpeg"), "-v", "error", "-y", "-ss", vFrom.toFixed(3), "-t", String(seconds), "-i", video.path, "-map", `0:v:${video.stream}`, "-vf", "scale=-2:720", "-c:v", "h264_videotoolbox", "-b:v", "8M", "-an", take]);
            await runTool([tool("ffmpeg"), "-v", "error", "-y", "-ss", aFrom.toFixed(3), "-t", String(seconds), "-i", audio.path, "-map", `0:a:${audio.stream}`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", said]);
            tell(0.08, "uploading");
            const [v, s, ...images] = await Promise.all([upload(token, take, "video/mp4"), upload(token, said, "audio/wav"), ...photos.map((p) => upload(token, p.path, MIME[extname(p.path).toLowerCase()] ?? "image/jpeg"))]);
            const stage = (base: number, span: number) => (st: MakeStage) => tell(base + (st === "making" ? span / 2 : 0), st);
            let made: string;
            try {
              made = await predict(token, SEEDANCE, { prompt, reference_videos: [v], reference_audios: [s], ...(images.length ? { reference_images: images } : {}), duration: -1, aspect_ratio: "adaptive", resolution: "480p", generate_audio: false }, stage(0.15, 0.5));
            } catch (e) {
              // Seedance's moderation refuses some takes (a brand on screen was one): said plainly, never worked around.
              if (/E005|sensitive/i.test((e as Error).message)) throw new Error("Seedance declined this take (it flags some, often for a brand or logo in it): try another stretch, or a close-up crop");
              throw e;
            }
            tell(0.7, "upscaling");
            const upscaled = await predict(token, UPSCALER, { video: made, scene: "aigc", target_resolution: resolution, target_fps: fps, processing_type: "standard" }, (st) => tell(st === "making" ? 0.8 : 0.72, st === "making" ? "upscaling" : st));
            tell(0.92, "downloading");
            const dir = join(env.mediaDir, TRACK);
            mkdirSync(dir, { recursive: true });
            const out = freeName(dir, VIEWS[a.view].title);
            await download(upscaled, join(tmp, "made.mp4"));
            // Silent: the take's own sound plays under it.
            await runTool([tool("ffmpeg"), "-v", "error", "-y", "-i", join(tmp, "made.mp4"), "-map", "0:v:0", "-c", "copy", "-an", out]);
            const info: AngleTakeInfo = { view: a.view, prompt, cost: Math.round(seconds * PRICE * 100) / 100, seconds };
            writeFileSync(out.replace(/\.mp4$/, ".json"), JSON.stringify({ ...info, models: [SEEDANCE.slug, UPSCALER.slug], made: new Date().toISOString() }, null, 2));
            const asset = await env.asset(out, "video");
            jobSignal()?.throwIfAborted();
            env.progress(1, `Made, in the project's media/${TRACK} folder`);
            return (now: ActionContext) => {
              let there = true;
              try {
                findClip(now.project, now.registry, clip.id);
              } catch {
                there = false;
              }
              return {
                label: "Generate Camera Angle",
                steps: [
                  { command: "asset.add", args: { ...asset, name: `Angle: ${VIEWS[a.view].title}`, derived: { ...asset.derived, angle: info } } },
                  ...(there ? [{ command: "angle.use", args: (r: unknown[]) => ({ clip: clip.id, asset: r[0] }) }] : []),
                ],
                after: () => [{ command: "angles.status", args: { clips: ids, making: false } }],
              };
            };
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
        },
        failed: (error) => [{ command: "angles.status", args: { clips: ids, making: false, ...(error === "cancelled" ? { error: null } : { error }) } }],
      },
    };
  },
});

/** Camera angles: a generated cutaway of the presenter from another angle (or a close-up crop), placed over the camera as a cut, the take's own sound kept. */
/**
 * v2: the side profiles went (the user, 2026-11-05: three-quarter shots are what they use); an Angle clip set to one
 * becomes the three-quarter view on that side, its takes kept.
 */
function profilesToThreeQuarter(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const a = o.props?.angle as { view?: string } | undefined;
    if (a?.view === "profile-left") a.view = "three-quarter-left";
    if (a?.view === "profile-right") a.view = "three-quarter-right";
  });
  return doc;
}

export const angles = defineFeature({
  id: "angles",
  version: 2,
  migrations: [{ version: 2, migrate: profilesToThreeQuarter }],
  clipTypes: [{ id: "angle", description: "A camera angle: a cutaway of the camera under it from another angle, generated (nothing in an export until it is) or a close-up crop", traits: ["visual", "picture", "media", "video", "angle"] }],
  props: [
    { id: "angle", description: "The angle an Angle clip is (view, handheld or locked, a note) and the takes made for it", traits: ["angle"], tab: { title: "Camera Angle", icon: "video-camera", order: 3 }, schema: angleGroup, defaults: () => ({ ...DEFAULTS }) },
    { id: "angleRoom", description: "The room photos an Angles track's angles are made with", traits: ["angle"], schema: roomGroup, defaults: () => ({ photos: [] }), track: true },
  ],
  commands,
  sessionCommands,
  actions: [angleAdd, angleGenerate],
  preferences: [{ id: RESOLUTION, title: "Camera angles: upscaled to", description: "The resolution a generated angle is upscaled to; higher is sharper and takes longer", options: RESOLUTIONS, default: "1080p" }],
  queries: [
    defineQuery({
      id: "angle.estimate",
      description: "What generating an Angle clip (`clip`) would cost: the seconds sent (4 at least), Seedance's dollars (the upscaler's are on the user's Replicate bill), the limit per generation, and whether its camera can give a close-up by cropping instead (`crop`, free)",
      args: z.strictObject({ clip: z.string().min(1) }),
      run({ clip: id }, { project, registry, pref }) {
        const { clip } = findClip(project, registry, id);
        if (clip.type !== "angle") throw new Error(`clip "${id}" isn't an angle`);
        let crop = false;
        let camera: string | undefined;
        try {
          const c = cameraOf(project, registry, clip).camera;
          camera = c.id;
          crop = canCrop(project, registry, c);
        } catch {
          // No camera under it: said by `camera` missing.
        }
        return { ...cost(clip), limit: Number(pref(LIMIT)) || 0, crop, ...(camera ? { camera } : {}) };
      },
    }),
  ],
});
