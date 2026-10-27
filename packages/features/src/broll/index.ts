import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { jobSignal, runTool, tool } from "@beacon/media";
import {
  clipEnd,
  clipSpeed,
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  eachRawClip,
  findClip,
  nestedOf,
  secondsToTicks,
  ticksToSeconds,
  type ActionContext,
  type ActionStep,
  type Asset,
  type Clip,
  type FeatureRegistry,
  type Preferences,
  type Project,
  type Session,
  type SessionCommandDef,
  type TaskEnv,
  type Track,
} from "@beacon/model";
import { streamOf, visualSize } from "../media";
import { timelineWords } from "../transcript";
import { DEFAULT_MODEL, lengthFor, nearestAspect, resolutionOf, shotCost, VIDEO_MODELS, videoModel, type Resolution, type VideoModel } from "./models";
import { planOnDevice, planShots, tile, PLAN_MODEL, type PlanStage } from "./plan";
import { generate, limits, type Limits, type MakeStage } from "./replicate";

export { VIDEO_MODELS, videoModel, resolutionOf, shotCost, nearestAspect, lengthFor } from "./models";

const TOKEN = "replicate-api-token";
const OPENAI = "openai-api-key";
/** Seconds of talk either side of a clip the planner reads for context. */
const CONTEXT = 15;
/** A placeholder added at the playhead lasts this long. */
const PLACEHOLDER_SECONDS = 4;

/** A region of the canvas in canvas pixels from its top left: x, y, width, height. */
export type Rect = [number, number, number, number];

/** What a B-roll clip asks for (`props.broll`), and the footage it has made: its takes, assets in the Media Bin. */
const brollGroup = z.strictObject({
  prompt: z.string().max(2000),
  why: z.string(),
  /** Which prompt it is made from: the one the planner wrote (`prompt`, "auto"), or the one typed (`manual`). */
  source: z.enum(["auto", "manual"]),
  /** The prompt typed (Manual), starting from the words said under the clip; kept while Auto is chosen. */
  manual: z.string().max(2000),
  /** Plan searches the web for what is said (OpenAI's planner only). */
  research: z.boolean(),
  /** As `{ assetId }`, so copying and pasting the clip carries every take along (any `assetId` is a reference). */
  takes: z.array(z.strictObject({ assetId: z.string() })),
});
export type BrollProps = z.infer<typeof brollGroup>;

/** An empty placeholder's box (`props.brollBox`): its size on the canvas until it has footage, then gone. */
const boxGroup = z.strictObject({ width: z.number().positive(), height: z.number().positive() });

/** What made a take, on its asset (`derived.broll`). */
export interface TakeInfo {
  prompt: string;
  model: string;
  /** Dollars, estimated from the model's price per second. */
  cost: number;
  seconds: number;
}

/** What B-roll is doing for which clips (`session.features.broll`): planned or made now, and why the last try failed. */
export interface BrollState {
  planning: string[];
  making: string[];
  errors: Record<string, string>;
}

const IDLE: BrollState = { planning: [], making: [], errors: {} };
export const brollState = (s: Session) => (s.features.broll as BrollState | undefined) ?? IDLE;

export const brollOf = (c: Clip) => c.props.broll as BrollProps | undefined;

/** The model, its resolution and the limit, as Settings › AI has them. */
export const brollSettings = (pref: Preferences) => {
  const model = videoModel(pref("brollModel"));
  return { model, resolution: resolutionOf(model, pref("brollResolution")) as Resolution, limit: Number(pref("brollLimit")) || 0 };
};

const seconds = (c: Clip) => ticksToSeconds(c.duration);

/**
 * How far past a model's longest shot a clip may run: a frame (and a hair). A cut rounded to a frame at 29.97 fps
 * makes an 8 s shot 8.008 s; the footage is 8 s and the clip ends with it, a frame early.
 */
const OVER = (project: Project) => project.settings.fps.den / project.settings.fps.num + 1e-3;

/** The models that can make a shot this long, each with what it would cost. */
export function comparison(length: number, pref: Preferences, over = 1e-3) {
  const asked = pref("brollResolution");
  return VIDEO_MODELS.filter((m) => m.durations.at(-1)! >= length - over).map((m) => ({ model: m, resolution: resolutionOf(m, asked), cost: shotCost(m, resolutionOf(m, asked), length) }));
}

/** Where a clip shows on the canvas: its content's visible part (after crop), scaled and placed; its size before rotation. */
export function regionOfClip(clip: Clip, project: Project, registry: FeatureRegistry): Rect {
  const [W, H] = visualSize(project, registry, clip) ?? [project.settings.width, project.settings.height];
  const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...(clip.props.transform as Partial<Record<"x" | "y" | "scaleX" | "scaleY" | "rotation", number>> | undefined) };
  const c = { left: 0, top: 0, right: 0, bottom: 0, ...(clip.props.crop as Partial<Record<"left" | "top" | "right" | "bottom", number>> | undefined) };
  // A flip (a negative scale) mirrors the picture in place: the region is the same size.
  const [w, h] = [Math.abs((W - c.left - c.right) * t.scaleX), Math.abs((H - c.top - c.bottom) * t.scaleY)];
  // An uneven crop moves the visible part's centre off the clip's, turned with the clip (canvas pixels, y down).
  const [dx, dy] = [((c.left - c.right) / 2) * t.scaleX, ((c.top - c.bottom) / 2) * t.scaleY];
  const [cos, sin] = [Math.cos(t.rotation), Math.sin(t.rotation)];
  const cx = project.settings.width / 2 + t.x + cos * dx + sin * dy;
  const cy = project.settings.height / 2 - t.y - sin * dx + cos * dy;
  return [cx - w / 2, cy - h / 2, w, h];
}

/**
 * Footage `W`×`H` scaled to cover a `w`×`h` region and cropped to it, its crop as far off-centre (in canvas pixels) as
 * the clip's was by `[dx, dy]`: the clip keeps its position, so the visible part stays where it was however the clip
 * is turned, tilted or flipped.
 */
function covering([W, H]: [number, number], [w, h]: [number, number], [dx, dy]: [number, number]) {
  const k = Math.max(w / W, h / H);
  const [totalX, totalY] = [Math.max(0, W - w / k), Math.max(0, H - h / k)];
  // Footage with too little to spare keeps its visible size: the offset goes only as far as the spare picture does.
  const [offX, offY] = [Math.min(totalX, Math.max(-totalX, dx / k)), Math.min(totalY, Math.max(-totalY, dy / k))];
  // Never below 0 (the crop schema's floor): a float's last bit can make a side a hair negative.
  const side = (total: number, off: number): [number, number] => [Math.max(0, (total + off) / 2), Math.max(0, (total - off) / 2)];
  const [left, right] = side(totalX, offX);
  const [top, bottom] = side(totalY, offY);
  return { scale: k, crop: { left, right, top, bottom } };
}

/** A placeholder's props: a box the region's size, placed over it. */
function placeholder(region: Rect, project: Project, props: Partial<BrollProps> = {}) {
  const [x, y, w, h] = region;
  return {
    broll: { prompt: "", why: "", source: "auto", manual: "", research: true, takes: [], ...props } satisfies BrollProps,
    brollBox: { width: w, height: h },
    transform: { x: x + w / 2 - project.settings.width / 2, y: project.settings.height / 2 - (y + h / 2), scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 },
  };
}

const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

const commands = [
  defineCommand({
    id: "broll.use",
    description:
      "Show `asset` (footage B-roll made) in a B-roll clip: the clip plays it from its start, scaled and cropped to the region it covers now, and keeps it among its takes. Picking an earlier take is the same command",
    args: z.strictObject({ clip: z.string().min(1), asset: z.string().min(1) }),
    apply(doc, { clip, asset }, ctx) {
      const { clip: c, track } = findClip(doc, ctx.registry, clip);
      const b = brollOf(c);
      if (c.type !== "broll" || !b) throw new Error(`clip "${clip}" isn't B-roll`);
      if (track.locked) throw new Error(`track "${track.name}" is locked`);
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      const s = streamOf(a, "video", 0);
      const [, , w, h] = regionOfClip(c, doc, ctx.registry);
      const was = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...(c.props.transform as Partial<Record<"x" | "y" | "scaleX" | "scaleY" | "rotation", number>> | undefined) };
      const base = { left: 0, right: 0, top: 0, bottom: 0, ...(c.props.crop as Partial<Record<"left" | "right" | "top" | "bottom", number>> | undefined) };
      const off: [number, number] = [(base.left - base.right) * Math.abs(was.scaleX), (base.top - base.bottom) * Math.abs(was.scaleY)];
      const fit = covering([s.width!, s.height!], [w, h], off);
      // A flipped clip stays flipped.
      const scale = { scaleX: fit.scale * (Math.sign(was.scaleX) || 1), scaleY: fit.scale * (Math.sign(was.scaleY) || 1) };
      // Footage with too little to spare to crop that far off-centre: the clip moves the rest of the way, turned with it.
      const [remX, remY] = [((off[0] - (fit.crop.left - fit.crop.right) * fit.scale) / 2) * Math.sign(scale.scaleX), ((off[1] - (fit.crop.top - fit.crop.bottom) * fit.scale) / 2) * Math.sign(scale.scaleY)];
      const [cos, sin] = [Math.cos(was.rotation), Math.sin(was.rotation)];
      const move = { x: cos * remX + sin * remY, y: -(-sin * remX + cos * remY) };
      // Animated crops are in the old picture's pixels: what each crops past the base crop, in canvas pixels, is kept past the new one's.
      const ratio = { x: Math.abs(was.scaleX) / fit.scale, y: Math.abs(was.scaleY) / fit.scale };
      for (const a of c.animations ?? []) {
        for (const side of ["left", "right", "top", "bottom"] as const) {
          const v = a.to[`crop.${side}`];
          if (typeof v === "number") a.to[`crop.${side}`] = fit.crop[side] + (v - base[side]) * (side === "left" || side === "right" ? ratio.x : ratio.y);
        }
      }
      // Animated scale ends are in the old picture's pixels too: rescaled with it, a zoom still zooms the same.
      for (const a of c.animations ?? []) {
        for (const axis of ["scaleX", "scaleY"] as const) {
          const v = a.to[`transform.${axis}`];
          if (typeof v === "number" && was[axis]) a.to[`transform.${axis}`] = (v * scale[axis]) / was[axis];
        }
        for (const axis of ["x", "y"] as const) {
          const v = a.to[`transform.${axis}`];
          if (typeof v === "number") a.to[`transform.${axis}`] = v + move[axis];
        }
      }
      // Animations and effect spans are timed in media time: from the old in-point and speed to the new footage's (0, normal speed),
      // so each still happens where it did on the timeline.
      const [from, speed] = [c.mediaStart ?? 0, clipSpeed(c)];
      for (const a of c.animations ?? []) {
        a.end = Math.round((a.end - from) / speed);
        a.duration = Math.round(a.duration / speed);
      }
      for (const fx of c.effects) if (fx.span) fx.span = { start: Math.round((fx.span.start - from) / speed), end: Math.round((fx.span.end - from) / speed) };
      c.assetId = asset;
      c.mediaStart = 0;
      // Made for the clip's length at normal speed: played faster, it would run out before the clip ends.
      delete c.speed;
      delete c.props.brollBox;
      c.props.media = { stream: 0 };
      c.props.transform = { ...(c.props.transform as object), ...scale, x: was.x + move.x, y: was.y + move.y };
      c.props.crop = fit.crop;
      if (!b.takes.some((t) => t.assetId === asset)) b.takes.push({ assetId: asset });
      // Footage shorter than the clip: the clip ends with it.
      c.duration = Math.min(c.duration, secondsToTicks(s.duration));
    },
  }),
];

const sessionCommands: SessionCommandDef[] = [
  {
    id: "broll.status",
    description: "Mark B-roll clips as being planned or made, or not (broll.plan and broll.generate do), with why the last try failed (`error`, null to clear)",
    args: z.strictObject({ clips: z.array(z.string()), planning: z.boolean().optional(), making: z.boolean().optional(), error: z.string().nullable().optional() }),
    apply: (s, { clips, planning, making, error }: { clips: string[]; planning?: boolean; making?: boolean; error?: string | null }) => {
      const was = brollState(s);
      const mark = (list: string[], on?: boolean) => (on === undefined ? list : on ? [...new Set([...list, ...clips])] : list.filter((id) => !clips.includes(id)));
      const errors = { ...was.errors };
      for (const id of clips) if (error === null || planning || making) delete errors[id];
      if (error) for (const id of clips) errors[id] = error;
      s.features.broll = { planning: mark(was.planning, planning), making: mark(was.making, making), errors } satisfies BrollState;
    },
  },
];

/** Where a new B-roll track goes: right above the highest track with media (or a group of it) over the span, so captions above stay in front. */
export function trackIndex(project: Project, registry: FeatureRegistry, from: number, to: number): number {
  const media = (c: Clip): boolean => (!!c.assetId && c.type !== "broll") || registry.groupsFor(c.type).some((g) => g.nested && c.props[g.id] && g.nested(c.props[g.id]).some((t) => t.clips.some(media)));
  const over = project.tracks.flatMap((t, i) => (t.clips.some((c) => media(c) && ticksToSeconds(c.start) < to && ticksToSeconds(clipEnd(c)) > from) ? [i] : []));
  return over.length ? Math.max(...over) + 1 : project.tracks.length;
}

/** The B-roll clips an action works on: those given, else the selected ones. */
function targets(ctx: ActionContext, ids?: string[]): Clip[] {
  // What the editor is editing: an opened group's clips, at main-timeline times.
  const all = ctx.scope.tracks.flatMap((t) => t.clips);
  // Each clip once: a repeated id mustn't make (and charge for) it twice.
  const chosen = ids ? [...new Set(ids)].map((id) => all.find((c) => c.id === id) ?? fail(`no clip "${id}" on the timeline`)) : all.filter((c) => ctx.session.selection.includes(c.id));
  const broll = chosen.filter((c) => c.type === "broll");
  if (!broll.length) throw new Error(ids ? "those clips aren't B-roll" : "select a B-roll clip first (the AI panel's B-roll tile adds one)");
  return broll;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const keyOf = async (secret: (id: string) => Promise<string | undefined>, which: string) => {
  const key = await secret(which);
  if (!key) throw new Error(`no ${which === TOKEN ? "Replicate API token" : "OpenAI API key"}: add one in Settings › AI`);
  return key;
};

const minutes = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const brollAdd = defineAction({
  id: "broll.add",
  description:
    "Add a B-roll placeholder clip (the AI panel's B-roll tile): over the in/out range if one is set, else at `time` (default the playhead) for `duration` seconds, on a B-roll track above the talk, covering `region` ([x, y, width, height] canvas pixels from the top left; default the whole canvas), with an optional `prompt`. It shows nothing in an export until it has footage: move and trim it like any clip, then broll.plan writes its prompt from the words under it, broll.generate makes it",
  args: z.strictObject({
    time: z.number().nonnegative().optional(),
    duration: z.number().positive().optional(),
    region: RectSchema.optional(),
    prompt: z.string().max(2000).optional(),
  }),
  resolve: ({ time, duration, region, prompt }, ctx) => {
    if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to add B-roll");
    const range = time === undefined && duration === undefined ? ctx.session.range : null;
    const from = range ? range.in : (time ?? ctx.session.playhead);
    const length = range ? range.out - range.in : (duration ?? PLACEHOLDER_SECONDS);
    const { width, height } = ctx.project.settings;
    const props = placeholder(region ?? [0, 0, width, height], ctx.project, prompt ? { prompt } : {});
    // An existing B-roll track above the talk, free over the span, takes it; else a new one above the talk.
    const above = trackIndex(ctx.project, ctx.registry, from, from + length);
    const free = ctx.project.tracks.find((t, i) => i >= above && t.name === "B-roll" && !t.locked && t.clips.every((c) => ticksToSeconds(clipEnd(c)) <= from || ticksToSeconds(c.start) >= from + length));
    const steps: ActionStep[] = free
      ? [{ command: "clip.place", args: { type: "broll", props, duration: length, time: from, track: free.id } }]
      : [
          { command: "track.add", args: { name: "B-roll", index: above } },
          { command: "clip.place", args: (r: unknown[]) => ({ type: "broll", props, duration: length, time: from, track: r[0] }) },
        ];
    return {
      label: "Add B-roll",
      steps,
      after: (r) => [
        { command: "selection.set", args: { clips: [r.at(-1) as string], linked: false } },
        { command: "inspector.tab", args: { tab: "broll" } },
        ...(range ? [{ command: "range.clear" }] : []),
      ],
    };
  },
});

const brollPlan = defineAction({
  id: "broll.plan",
  description:
    "Write a B-roll clip's prompt (`clip`, else the selected one) from what is said under it: by the planner chosen in Settings › AI (Apple's on-device model, free and offline, by default; or OpenAI on the user's key, which also searches the web with the clip's `research`). A clip longer than the model makes is split into shots, each with its prompt, one undo step. Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const [clip] = targets(ctx, id ? [id] : undefined);
    if (!clip) throw new Error("select a B-roll clip first");
    const state = brollState(ctx.session);
    if (state.planning.includes(clip.id) || state.making.includes(clip.id)) throw new Error("that clip is being planned or made already");
    const b = brollOf(clip)!;
    const [from, to] = [ticksToSeconds(clip.start), ticksToSeconds(clipEnd(clip))];
    const words = heardWords(ctx);
    const said = words.filter((w) => w.end > from && w.start < to);
    if (!said.length) throw new Error("nothing is said under the clip yet: B-roll is planned from the transcript (wait for it, move the clip over speech, or type a prompt)");
    const { model } = brollSettings(ctx.pref);
    const planner = ctx.pref("brollPlanner");
    const [, , w, h] = regionOfClip(clip, ctx.project, ctx.registry);
    if (b.takes.length && to - from > model.durations.at(-1)! + 1e-3) throw new Error(`the clip has footage and is longer than ${model.title} makes: trim it to ${model.durations.at(-1)} s to plan it again`);
    // A model that picks its own shape is told the region's, and its footage cropped to it.
    const aspect = nearestAspect(model, w, h) ?? `${Math.round(w)}:${Math.round(h)}`;
    const text = (ws: typeof words) => ws.map((x) => x.text).join(" ");
    // Where the clip is, wherever it is (a group opened or closed meanwhile), in main-timeline ticks.
    const shapeOf = (project: Project, registry: FeatureRegistry) => {
      try {
        const at = findClip(project, registry, clip.id);
        return JSON.stringify([at.clip.start + at.offset, at.clip.duration]);
      } catch {
        return undefined;
      }
    };
    const shape = shapeOf(ctx.project, ctx.registry);
    return {
      label: "Plan B-roll",
      before: [{ command: "broll.status", args: { clips: [clip.id], planning: true } }],
      task: {
        label: "Plan B-roll",
        run: async (env) => {
          const request = {
            words: said.map((x) => ({ text: x.text, start: x.start, end: x.end })),
            before: text(words.filter((x) => x.end <= from && x.start >= from - CONTEXT)),
            after: text(words.filter((x) => x.start >= to && x.end <= to + CONTEXT)),
            from,
            to,
            research: b.research && planner === "openai",
            aspect,
            shortest: b.takes.length ? to - from : model.durations[0]!,
            longest: model.durations.at(-1)!,
          };
          const started = Date.now();
          // Numbered steps with a ticking clock, as Clean with Auphonic's.
          let step = { n: 1, of: 1, text: "", since: started };
          const tell = () => {
            // No percentage from either model: each step creeps on towards the next.
            const value = (step.n - 1 / (1 + (Date.now() - step.since) / 20_000)) / step.of;
            env.progress(Math.min(0.95, value), `${step.n} of ${step.of} · ${step.text} · ${minutes((Date.now() - started) / 1000)}`);
          };
          const say = (n: number, of: number, text: string) => {
            step = { n, of, text, since: n === step.n ? step.since : Date.now() };
            tell();
          };
          const ticking = setInterval(tell, 1000);
          let plan: Awaited<ReturnType<typeof planShots>>;
          try {
            if (planner === "apple") {
              plan = await planOnDevice(request, (n, of) => say(n, of, of === 1 ? "Apple's on-device model is writing the shot" : `Apple's on-device model is writing shot ${n}`));
            } else {
              const key = await keyOf(env.secret, OPENAI);
              // OpenAI's stream says which step it is on.
              const order: PlanStage[] = request.research ? ["thinking", "searching", "writing"] : ["thinking", "writing"];
              const says: Record<PlanStage, string> = { thinking: `${PLAN_MODEL} is thinking`, searching: "Searching the web", writing: "Writing the shots" };
              say(1, order.length, says.thinking);
              plan = await planShots(request, key, (s) => {
                if (order.indexOf(s) > step.n - 1) say(order.indexOf(s) + 1, order.length, says[s]);
              });
            }
          } finally {
            clearInterval(ticking);
          }
          // A clip with footage keeps one shot: it gets a new prompt, not a split (its box went with the footage).
          const shots = tile(plan.shots, from, to, b.takes.length ? to - from : model.durations[0]!, model.durations.at(-1)!);
          if (!shots.length) throw new Error("no shots were planned: try a longer clip");
          env.progress(1, shots.length === 1 ? "Prompt written" : `Split into ${shots.length} shots, each with its prompt`);
          return (now) => {
            const was = shapeOf(now.project, now.registry);
            if (!was) throw new Error("the B-roll clip was deleted while it was planned");
            if (was !== shape) throw new Error("the B-roll clip was moved or trimmed while it was planned: plan it again");
            const done = [{ command: "broll.status", args: { clips: [clip.id], planning: false } }];
            if (shots.length === 1) return { label: "Plan B-roll", steps: [{ command: "clip.set", args: { clip: clip.id, props: { broll: { prompt: shots[0]!.prompt, why: shots[0]!.why, source: "auto" } } } }], after: () => done };
            // Split where the shots meet, as the editor splits a clip (its effects, animations and look kept), from the
            // last boundary back so the clip itself stays the first shot; each piece then gets its shot's prompt.
            const cuts = shots.slice(1).map((s) => s.start).reverse();
            const steps: ActionStep[] = cuts.map((at) => ({ command: "clip.split", args: { at, clips: [clip.id], linked: false } }));
            const piece = (r: unknown[], k: number) => (k === 0 ? clip.id : (r[cuts.length - k] as string[])[0]!);
            steps.push(...shots.map((s, k) => ({ command: "clip.set", args: (r: unknown[]) => ({ clip: piece(r, k), props: { broll: { prompt: s.prompt, why: s.why, source: "auto" } } }) })));
            return { label: "Plan B-roll", steps, after: (r) => [...done, { command: "selection.set", args: { clips: shots.map((_, k) => piece(r, k)), linked: false } }] };
          };
        },
        failed: (error) => [{ command: "broll.status", args: { clips: [clip.id], planning: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

/** Taken by creating it, so two generations at once never pick the same name. */
function freeName(dir: string, stem: string): string {
  for (let n = 1; ; n++) {
    const path = join(dir, `${stem}${n > 1 ? ` ${n}` : ""}.mp4`);
    try {
      writeFileSync(path, "", { flag: "wx" });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/** A take made for a clip, as `asset.add` takes it, or why there is none. */
type Made = { clip: string; asset?: Omit<Asset, "id">; error?: string };

/** The resolution input `asked` as the model lists them now: 1080p asked and missing, its best below. */
function resolutionInput(asked: Record<string, unknown> | undefined, live: Limits): Record<string, unknown> {
  const r = asked?.resolution;
  if (typeof r !== "string" || !live.resolutions || live.resolutions.includes(r)) return asked ?? {};
  return { ...asked, resolution: live.resolutions.includes("720p") ? "720p" : live.resolutions[0] };
}

/**
 * One clip's footage made with one model (`live`, what it takes now), saved in `dir` beside a `.json` of what made
 * it: the asset, or why there is none. A cancelled job's clip reports nothing.
 */
async function makeTake(env: TaskEnv, token: string, model: VideoModel, live: Limits, resolution: Resolution, c: { id: string; prompt: string; length: number }, [w, h]: [number, number], dir: string, stage: (s: MakeStage) => void): Promise<Made | undefined> {
  const length = lengthFor(live, c.length);
  const aspect = nearestAspect(live, w, h);
  // Bounded, with room for the counter and suffixes after it: the whole prompt is in the .json.
  const words = c.prompt.replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 40).trim();
  const out = freeName(dir, `${model.title} - ${words}`);
  try {
    const input: Record<string, unknown> = { prompt: c.prompt, aspect_ratio: aspect, duration: live.durationText ? String(length) : length, generate_audio: false, ...resolutionInput(model.resolutions[resolution], live) };
    for (const k of Object.keys(input)) if (input[k] === undefined || !live.fields.has(k)) delete input[k];
    await generate(token, model, input, out, stage);
  } catch (e) {
    // Nothing paid for arrived: the file is a placeholder, or half a download.
    rmSync(out, { force: true });
    if (jobSignal()?.aborted) return undefined;
    return { clip: c.id, error: e instanceof Error ? e.message : String(e) };
  }
  // Downloaded, it is kept whatever happens next: it was paid for. What made it is written beside it first.
  const info: TakeInfo = { prompt: c.prompt, model: model.title, cost: shotCost({ ...model, durations: live.durations }, resolution, c.length), seconds: length };
  try {
    writeFileSync(out.replace(/\.mp4$/, ".json"), JSON.stringify({ ...info, slug: model.slug, resolution, aspect: aspect ?? "the model's own", made: new Date().toISOString() }, null, 2));
    // B-roll is silent: sound a model made anyway (one whose schema has no audio switch) is taken off the file.
    const silent = `${out}.silent.mp4`;
    await runTool([tool("ffmpeg"), "-v", "error", "-y", "-i", out, "-map", "0:v:0", "-c", "copy", "-an", silent]);
    renameSync(silent, out);
    const asset = await env.asset(out, "video");
    return { clip: c.id, asset: { ...asset, name: `B-roll: ${c.prompt.slice(0, 60)}`, derived: { ...asset.derived, broll: info } } };
  } catch (e) {
    if (jobSignal()?.aborted) return undefined;
    return { clip: c.id, error: `made, but couldn't be read (kept as ${basename(out)} in media/B-roll): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A generation's end: each take added to the Media Bin and shown in its clip (the last made for a clip is shown),
 * one undo step; a clip deleted meanwhile still gets its takes in the bin. With nothing made, the first reason fails the job.
 */
function finished(env: TaskEnv, results: Made[], clips: string[], label: string) {
  jobSignal()?.throwIfAborted();
  const made = results.filter((x) => x.asset);
  const failed = results.filter((x) => x.error);
  if (!made.length) throw new Error(failed[0]?.error ?? "nothing was made");
  env.progress(1, [`${made.length} made, in the project's media/B-roll folder`, failed.length ? `${failed.length} failed: ${failed[0]!.error}` : ""].filter(Boolean).join("; "));
  return (ctx: ActionContext) => {
    // Grouped meanwhile, a clip is inside its group: still there. Locked meanwhile, it is left as it is.
    const where = (id: string) => {
      try {
        return findClip(ctx.project, ctx.registry, id);
      } catch {
        return undefined;
      }
    };
    const steps: ActionStep[] = [];
    const locked: string[] = [];
    for (const m of made) {
      const added = steps.length;
      steps.push({ command: "asset.add", args: m.asset });
      const at = where(m.clip);
      if (at?.track.locked) locked.push(m.clip);
      else if (at) steps.push({ command: "broll.use", args: (r: unknown[]) => ({ clip: m.clip, asset: r[added] }) });
    }
    const errors = [
      ...failed.filter((f) => !made.some((m) => m.clip === f.clip)),
      ...locked.map((clip) => ({ clip, error: "its track is locked: the footage is in the Media Bin" })),
    ];
    return {
      label,
      steps,
      after: () => [
        { command: "broll.status", args: { clips, making: false, error: null } },
        ...errors.map((f) => ({ command: "broll.status", args: { clips: [f.clip], error: f.error } })),
      ],
    };
  };
}

const STEPS: MakeStage[] = ["queued", "making", "downloading"];

/**
 * A generation's toast, ticking each second: one take in numbered steps (sent, being made, downloading), as Clean
 * with Auphonic's; several, how many are made and being made. Replicate gives no percentage: each step creeps on.
 */
function tracker(env: TaskEnv, model: (key: string) => string, total: number) {
  const started = Date.now();
  const at = new Map<string, { stage: MakeStage; since: number }>();
  let done = 0;
  const clock = () => minutes((Date.now() - started) / 1000);
  const tell = () => {
    if (total === 1) {
      const [key, now] = [...at.entries()][0] ?? ["", { stage: "queued" as MakeStage, since: started }];
      const n = STEPS.indexOf(now.stage);
      const says = { queued: "Sent to Replicate, waiting its turn", making: `${model(key)} is making it`, downloading: "Downloading" }[now.stage];
      return env.progress(Math.min(0.95, (n + 1 - 1 / (1 + (Date.now() - now.since) / 30_000)) / STEPS.length), `${n + 1} of ${STEPS.length} · ${says} · ${clock()}`);
    }
    const making = [...at.values()].filter((x) => x.stage !== "queued").length;
    env.progress(0.05 + (0.95 * done) / total, [`${done} of ${total} made`, making ? `${making} being made` : "", clock()].filter(Boolean).join(" · "));
  };
  return {
    tell,
    stage: (key: string) => (stage: MakeStage) => {
      if (at.get(key)?.stage !== stage) at.set(key, { stage, since: Date.now() });
      tell();
    },
    done: (key: string) => {
      at.delete(key);
      done++;
      tell();
    },
  };
}

/**
 * The words heard on the timeline and inside its groups at every level, opened or not, on unmuted tracks: each
 * group's words mapped through its start and speed onto the timeline, within its span. Narration grouped with its
 * picture counts too.
 */
export function heardWords(ctx: Pick<ActionContext, "project" | "registry" | "data">) {
  const nested = nestedOf(ctx.registry);
  const heard = (tracks: Track[]): { text: string; start: number; end: number }[] => [
    ...timelineWords({ ...ctx.project, tracks }, ctx.registry, ctx.data),
    ...tracks
      .filter((t) => !t.muted)
      .flatMap((t) => t.clips)
      .flatMap((g) => {
        const inner = nested(g);
        if (!inner) return [];
        const [from, to, at, speed] = [ticksToSeconds(g.start), ticksToSeconds(clipEnd(g)), ticksToSeconds(g.mediaStart ?? 0), clipSpeed(g)];
        const out = (s: number) => from + (s - at) / speed;
        // A word cut by the group's trim is heard only as far as the group plays.
        return heard(inner)
          .map((w) => ({ ...w, start: Math.max(from, out(w.start)), end: Math.min(to, out(w.end)) }))
          .filter((w) => w.end > w.start);
      }),
  ];
  return heard(ctx.project.tracks).sort((a, b) => a.start - b.start);
}

/** Where a clip plays on the timeline, in seconds, inside groups at any level too: through each group's start and speed. */
export function timelineSpan(id: string, project: Project, registry: FeatureRegistry): [number, number] | undefined {
  const nested = nestedOf(registry);
  const find = (tracks: Track[]): [number, number] | undefined => {
    for (const c of tracks.flatMap((t) => t.clips)) {
      if (c.id === id) return [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))];
      const inner = nested(c);
      const span = inner && find(inner);
      if (!span) continue;
      const out = (s: number) => ticksToSeconds(c.start) + (s - ticksToSeconds(c.mediaStart ?? 0)) / clipSpeed(c);
      return [out(span[0]), out(span[1])];
    }
    return undefined;
  };
  return find(project.tracks);
}

/** What is said under a clip on the timeline, from the transcript already made (by whichever transcriber). */
export function wordsUnder(clip: Clip, ctx: Pick<ActionContext, "project" | "registry" | "data">): string {
  const [from, to] = timelineSpan(clip.id, ctx.project, ctx.registry) ?? [ticksToSeconds(clip.start), ticksToSeconds(clipEnd(clip))];
  return heardWords(ctx)
    .filter((w) => w.end > from && w.start < to)
    .map((w) => w.text)
    .join(" ")
    .trim();
}

/**
 * The prompt a clip is made from: Auto, the one Plan wrote; Manual, the one typed (the look the user wants in its
 * words). Either one still empty: the words said under it (so a first try needs no planner).
 */
function promptFor(clip: Clip, ctx: ActionContext): string {
  const b = brollOf(clip)!;
  if (b.source === "auto" && b.prompt.trim()) return b.prompt.trim();
  if (b.source === "manual" && b.manual.trim()) return b.manual.trim();
  const words = wordsUnder(clip, ctx);
  if (!words) throw new Error("nothing is said under this B-roll clip: type a prompt (Prompt: Manual)");
  return `Footage illustrating: "${words}".`;
}

const notReady = (ctx: ActionContext, clips: Clip[]) => {
  const state = brollState(ctx.session);
  const busy = clips.filter((c) => state.planning.includes(c.id) || state.making.includes(c.id));
  if (busy.length) throw new Error(busy.length === clips.length ? "being planned or made already" : `${busy.length} of them are being planned or made already`);
};

const brollGenerate = defineAction({
  id: "broll.generate",
  description:
    "Make footage for B-roll clips (`clips`, else the selected ones) from their prompts (an empty one: the words said under the clip) with the model chosen in Settings › AI, through Replicate on the user's token: each prompt and the clip's shape are sent, and Replicate charges their account (broll.estimate says how much). Each file is saved in the project's media/B-roll folder as it arrives; when it is done, each take is added to the Media Bin and shown in its clip, scaled and cropped to the clip's region, one undo step; earlier takes stay on the clip (broll.use picks one). Refused over the limit set in Settings › AI. Runs as a job. Only when the user asks: it spends their money",
  args: z.strictObject({ clips: z.array(z.string().min(1)).min(1).optional() }),
  resolve: ({ clips: ids }, ctx) => {
    const clips = targets(ctx, ids);
    notReady(ctx, clips);
    const { model, resolution, limit } = brollSettings(ctx.pref);
    const longest = model.durations.at(-1)!;
    const tooLong = clips.filter((c) => seconds(c) > longest + OVER(ctx.project));
    if (tooLong.length) throw new Error(`${tooLong.length === 1 ? "a clip is" : `${tooLong.length} clips are`} longer than ${model.title}'s ${longest} s: trim it, or Plan it to split it into shots`);
    const cost = clips.reduce((sum, c) => sum + shotCost(model, resolution, seconds(c)), 0);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)}, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const shots = clips.map((c) => ({ id: c.id, prompt: promptFor(c, ctx), length: seconds(c), region: regionOfClip(c, ctx.project, ctx.registry) }));
    const over = OVER(ctx.project);
    const ids2 = clips.map((c) => c.id);
    const results: Made[] = [];
    return {
      label: "Generate B-roll",
      before: [{ command: "broll.status", args: { clips: ids2, making: true } }],
      task: {
        label: `B-roll: ${clips.length === 1 ? "1 clip" : `${clips.length} clips`} with ${model.title}`,
        run: async (env) => {
          const dir = join(env.mediaDir, "B-roll");
          mkdirSync(dir, { recursive: true });
          const track = tracker(env, () => model.title, shots.length);
          const ticking = setInterval(track.tell, 1000);
          try {
            const token = await keyOf(env.secret, TOKEN);
            const live = await limits(token, model);
            // Checked again by what the model makes now, before anything is paid for.
            const max = live.durations.at(-1)!;
            if (shots.some((s) => s.length > max + over)) throw new Error(`${model.title} now makes ${max} s at most, shorter than a clip: trim it`);
            const charged = shots.reduce((sum, s) => sum + shotCost({ ...model, durations: live.durations }, resolution, s.length), 0);
            if (limit > 0 && charged > limit) throw new Error(`about $${charged.toFixed(2)} at the lengths ${model.title} makes now, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
            await Promise.all(
              shots.map(async (s) => {
                const m = await makeTake(env, token, model, live, resolution, s, [s.region[2], s.region[3]], dir, track.stage(s.id));
                if (m) results.push(m);
                track.done(s.id);
              }),
            );
            return finished(env, results, ids2, "Generate B-roll");
          } finally {
            clearInterval(ticking);
          }
        },
        failed: (error) => [{ command: "broll.status", args: { clips: ids2, making: false, ...(error === "cancelled" ? { error: null } : { error }) } }],
      },
    };
  },
});

const brollCompare = defineAction({
  id: "broll.compare",
  description:
    "Make one B-roll clip (`clip`, else the selected one) with every model that can make it that long (Settings › AI's list, at its resolution), side by side: each take is added to the clip, the last made shown, the others picked with broll.use, to choose a default model. Replicate charges the user's account for each (broll.estimate's `compare`); refused over the limit per generation. Runs as a job. Only when the user asks",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const [clip] = targets(ctx, id ? [id] : undefined);
    if (!clip) throw new Error("select a B-roll clip first");
    notReady(ctx, [clip]);
    const length = seconds(clip);
    const models = comparison(length, ctx.pref, OVER(ctx.project));
    const { limit } = brollSettings(ctx.pref);
    const cost = models.reduce((sum, m) => sum + m.cost, 0);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)} for ${models.length} models, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const region = regionOfClip(clip, ctx.project, ctx.registry);
    const shot = { id: clip.id, prompt: promptFor(clip, ctx), length };
    const over = OVER(ctx.project);
    const results: Made[] = [];
    return {
      label: "Compare B-roll models",
      before: [{ command: "broll.status", args: { clips: [clip.id], making: true } }],
      task: {
        label: `B-roll: 1 clip with ${models.length} models`,
        run: async (env) => {
          const dir = join(env.mediaDir, "B-roll");
          mkdirSync(dir, { recursive: true });
          const track = tracker(env, (key) => key, models.length);
          const ticking = setInterval(track.tell, 1000);
          try {
            const token = await keyOf(env.secret, TOKEN);
            // Every model's schema first: the limit is checked at the lengths they make now, before any is paid for.
            const read = await Promise.all(
              models.map(async (m) => {
                try {
                  return { ...m, live: await limits(token, m.model) };
                } catch (e) {
                  jobSignal()?.throwIfAborted();
                  results.push({ clip: clip.id, error: `${m.model.title}: ${e instanceof Error ? e.message : String(e)}` });
                  track.done(m.model.title);
                  return undefined;
                }
              }),
            );
            const able = read.flatMap((m) => {
              if (!m) return [];
              if (length <= m.live.durations.at(-1)! + over) return [m];
              results.push({ clip: clip.id, error: `${m.model.title} makes ${m.live.durations.at(-1)} s at most` });
              track.done(m.model.title);
              return [];
            });
            const charged = able.reduce((sum, m) => sum + shotCost({ ...m.model, durations: m.live.durations }, m.resolution, length), 0);
            if (limit > 0 && charged > limit) throw new Error(`about $${charged.toFixed(2)} for ${able.length} models at the lengths they make now, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
            await Promise.all(
              able.map(async ({ model, resolution, live }) => {
                const m = await makeTake(env, token, model, live, resolution, shot, [region[2], region[3]], dir, track.stage(model.title));
                if (m) results.push(m);
                track.done(model.title);
              }),
            );
            return finished(env, results, [clip.id], "Compare B-roll models");
          } finally {
            clearInterval(ticking);
          }
        },
        failed: (error) => [{ command: "broll.status", args: { clips: [clip.id], making: false, ...(error === "cancelled" ? { error: null } : { error }) } }],
      },
    };
  },
});

/**
 * AI B-roll: placeholder clips over the talk whose footage is generated from a prompt (typed, or planned from the
 * words under them by OpenAI with web research), through Replicate on the user's token, and shown in the clip in place.
 */
/** v2: takes as `{ assetId }` (they were bare ids), so copying a clip carries them. */
function takesAsRefs(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const b = o.props?.broll as { takes?: unknown[] } | undefined;
    if (Array.isArray(b?.takes)) b.takes = b.takes.map((t) => (typeof t === "string" ? { assetId: t } : t));
  });
  return doc;
}

/** v3: a style and where the prompt comes from in place of the guide (the user, 2026-10-24); a clip's guide is dropped. */
function stylesNotGuides(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const b = o.props?.broll as Record<string, unknown> | undefined;
    if (!b) return;
    delete b.guide;
    b.style ??= "none";
    b.source ??= "auto";
  });
  return doc;
}

/** v4: Prompt from Transcript became Manual, typed in a prompt of its own (the user, 2026-10-24); empty, it is still the words said. */
function manualNotTranscript(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const b = o.props?.broll as Record<string, unknown> | undefined;
    if (!b) return;
    b.manual ??= "";
    if (b.source === "transcript") b.source = "manual";
  });
  return doc;
}

/** v5: Manual's own prompt for projects saved at v4 before it had one. */
function manualPrompt(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const b = o.props?.broll as Record<string, unknown> | undefined;
    if (b) b.manual ??= "";
  });
  return doc;
}

/** v6: no styles (the user, 2026-10-27: the look is typed in the prompt); the prompts written in one are kept. */
function noStyles(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const b = o.props?.broll as Record<string, unknown> | undefined;
    if (b) delete b.style;
  });
  return doc;
}

export const broll = defineFeature({
  id: "broll",
  version: 6,
  migrations: [
    { version: 2, migrate: takesAsRefs },
    { version: 3, migrate: stylesNotGuides },
    { version: 4, migrate: manualNotTranscript },
    { version: 5, migrate: manualPrompt },
    { version: 6, migrate: noStyles },
  ],
  clipTypes: [{ id: "broll", description: "B-roll: a placeholder for generated footage (nothing in an export until made), then that footage", traits: ["visual", "picture", "media", "video", "broll"] }],
  props: [
    {
      id: "broll",
      description: "The B-roll a clip asks for: its prompt (and why), where its prompt comes from (`source`: auto, `prompt` as Plan wrote it; manual, `manual` as typed), research for OpenAI's planner, and the takes made (`{ assetId }`)",
      traits: ["broll"],
      // Beside Visual Properties (1), where annotations have theirs.
      tab: { title: "B-roll", icon: "sparkle", order: 2 },
      schema: brollGroup,
      defaults: () => ({ prompt: "", why: "", source: "auto", manual: "", research: true, takes: [] }),
      identity: true,
    },
    {
      id: "brollBox",
      description: "An empty B-roll placeholder's box, in canvas pixels before its transform; gone once it has footage",
      traits: ["broll"],
      schema: boxGroup,
      defaults: () => ({ width: 1920, height: 1080 }),
      size: (box: { width: number; height: number }) => [box.width, box.height],
      identity: true,
    },
  ],
  commands,
  secrets: [{ id: TOKEN, title: "Replicate API token" }],
  preferences: [
    {
      id: "brollModel",
      title: "B-roll model",
      description: "The text-to-video model B-roll's footage is made with, through Replicate on your token",
      options: VIDEO_MODELS.map((m) => ({
        id: m.id,
        title: m.title,
        description: `About $${(m.perSecond["1080p"] ?? m.perSecond["720p"])!.toFixed(2)}/s · ${m.aspects.length > 3 ? "most shapes" : m.aspects.join(", ")} · ${m.durations[0]}–${m.durations.at(-1)} s shots`,
        online: true,
      })),
      default: DEFAULT_MODEL,
    },
    {
      id: "brollResolution",
      title: "B-roll resolution",
      description: "720p or 1080p (a model without 1080p makes 720p)",
      options: [
        { id: "1080p", title: "1080p", description: "Sharper; some models charge more for it" },
        { id: "720p", title: "720p", description: "Cheaper on some models" },
      ],
      default: "1080p",
    },
    {
      id: "brollPlanner",
      title: "B-roll planner",
      description: "Who writes a B-roll clip's prompt from the words under it (Prompt from: Auto)",
      options: [
        { id: "apple", title: "Apple, on this Mac", description: "Apple's on-device model: free, offline, no key. Needs Apple Intelligence (macOS 26); no web research" },
        { id: "openai", title: "OpenAI", description: "gpt-6.1-sol with your OpenAI API key: the words are sent to OpenAI, which charges your account; can research the topic on the web", secret: OPENAI, online: true },
      ],
      default: "apple",
    },
    {
      id: "brollLimit",
      title: "Limit per generation",
      description: "Dollars one generation may cost at most, by the estimate; 0 is no limit",
      options: [],
      range: { min: 0, max: 1000 },
      default: "0",
    },
  ],
  sessionCommands,
  queries: [
    defineQuery({
      id: "broll.words",
      description: "What is said under a B-roll clip (from the transcripts already made, narration inside groups too): what an empty prompt is made from",
      args: z.strictObject({ clip: z.string().min(1) }),
      run: ({ clip: id }, { project, registry, data }) => {
        return wordsUnder(findClip(project, registry, id).clip, { project, registry, data });
      },
    }),
    defineQuery({
      id: "broll.estimate",
      description:
        "What making B-roll clips (`clips`, else the selected ones) would cost (dollars, by the chosen model's price per second), all of them and each, with the model, its resolution and longest shot; each clip's `compare`: what broll.compare would cost, and with how many models. `for` is echoed back, so a caller can tell the answer to its latest ask",
      args: z.strictObject({ clips: z.array(z.string()).optional(), for: z.string().optional() }),
      run: ({ clips: ids, for: asked }, { project, registry, session, pref }) => {
        // Anywhere, inside groups too.
        const clips = (ids ?? session?.selection ?? []).flatMap((id) => {
          try {
            const { clip } = findClip(project, registry, id);
            return clip.type === "broll" ? [clip] : [];
          } catch {
            return [];
          }
        });
        const { model, resolution, limit } = brollSettings(pref);
        const each = clips.map((c) => {
          const versus = comparison(seconds(c), pref, OVER(project));
          return { id: c.id, seconds: lengthFor(model, seconds(c)), cost: shotCost(model, resolution, seconds(c)), compare: { models: versus.length, cost: versus.reduce((sum, m) => sum + m.cost, 0) } };
        });
        return { for: asked, model: model.title, resolution, limit, longest: model.durations.at(-1), total: each.reduce((sum, c) => sum + c.cost, 0), clips: each };
      },
    }),
  ],
  actions: [brollAdd, brollPlan, brollGenerate, brollCompare],
});
