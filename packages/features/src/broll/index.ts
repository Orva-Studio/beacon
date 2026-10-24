import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { jobSignal, runTool, tool } from "@beacon/media";
import {
  clipEnd,
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  findClip,
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
} from "@beacon/model";
import { streamOf, visualSize } from "../media";
import { timelineWords } from "../transcript";
import { DEFAULT_MODEL, lengthFor, nearestAspect, resolutionOf, shotCost, VIDEO_MODELS, videoModel, type Resolution, type VideoModel } from "./models";
import { planShots, tile, PLAN_MODEL, type PlanStage } from "./plan";
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
  /** What to show or avoid, for Plan. */
  guide: z.string().max(1000),
  /** Plan searches the web for what is said. */
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

/** The models that can make a shot this long, each with what it would cost. */
export function comparison(length: number, pref: Preferences) {
  const asked = pref("brollResolution");
  return VIDEO_MODELS.filter((m) => m.durations.at(-1)! >= length - 1e-3).map((m) => ({ model: m, resolution: resolutionOf(m, asked), cost: shotCost(m, resolutionOf(m, asked), length) }));
}

/** Where a clip shows on the canvas: its content's visible part (after crop), scaled and placed; rotation aside. */
export function regionOfClip(clip: Clip, project: Project, registry: FeatureRegistry): Rect {
  const [W, H] = visualSize(project, registry, clip) ?? [project.settings.width, project.settings.height];
  const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, ...(clip.props.transform as Partial<Record<"x" | "y" | "scaleX" | "scaleY", number>> | undefined) };
  const c = { left: 0, top: 0, right: 0, bottom: 0, ...(clip.props.crop as Partial<Record<"left" | "top" | "right" | "bottom", number>> | undefined) };
  const [w, h] = [(W - c.left - c.right) * t.scaleX, (H - c.top - c.bottom) * t.scaleY];
  const cx = project.settings.width / 2 + t.x + ((c.left - c.right) / 2) * t.scaleX;
  const cy = project.settings.height / 2 - t.y + ((c.top - c.bottom) / 2) * t.scaleY;
  return [cx - w / 2, cy - h / 2, w, h];
}

/** Footage `W`×`H` scaled to cover `region` and cropped to it, centred: transform and crop as props. */
function covering([W, H]: [number, number], [x, y, w, h]: Rect, project: Project) {
  const k = Math.max(w / W, h / H);
  const [cw, ch] = [(W - w / k) / 2, (H - h / k) / 2];
  return {
    transform: { x: x + w / 2 - project.settings.width / 2, y: project.settings.height / 2 - (y + h / 2), scaleX: k, scaleY: k },
    crop: { left: cw, right: cw, top: ch, bottom: ch },
  };
}

/** A placeholder's props: a box the region's size, placed over it. */
function placeholder(region: Rect, project: Project, props: Partial<BrollProps> = {}) {
  const [x, y, w, h] = region;
  return {
    broll: { prompt: "", why: "", guide: "", research: true, takes: [], ...props } satisfies BrollProps,
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
      const { clip: c } = findClip(doc, ctx.registry, clip);
      const b = brollOf(c);
      if (c.type !== "broll" || !b) throw new Error(`clip "${clip}" isn't B-roll`);
      const a = doc.assets[asset];
      if (!a) throw new Error(`no asset "${asset}"`);
      const s = streamOf(a, "video", 0);
      const region = regionOfClip(c, doc, ctx.registry);
      const fit = covering([s.width!, s.height!], region, doc);
      // Animated scale ends are in the old picture's pixels: rescaled with it, a zoom still zooms the same.
      const was = { scaleX: 1, scaleY: 1, ...(c.props.transform as Partial<Record<"scaleX" | "scaleY", number>> | undefined) };
      for (const a of c.animations ?? []) {
        for (const axis of ["scaleX", "scaleY"] as const) {
          const v = a.to[`transform.${axis}`];
          if (typeof v === "number" && was[axis]) a.to[`transform.${axis}`] = (v * fit.transform[axis]) / was[axis];
        }
      }
      c.assetId = asset;
      c.mediaStart = 0;
      // Made for the clip's length at normal speed: played faster, it would run out before the clip ends.
      delete c.speed;
      delete c.props.brollBox;
      c.props.media = { stream: 0 };
      c.props.transform = { ...(c.props.transform as object), ...fit.transform };
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
function trackIndex(project: Project, registry: FeatureRegistry, from: number, to: number): number {
  const media = (c: Clip): boolean => (!!c.assetId && c.type !== "broll") || registry.groupsFor(c.type).some((g) => g.nested && c.props[g.id] && g.nested(c.props[g.id]).some((t) => t.clips.some(media)));
  const over = project.tracks.flatMap((t, i) => (t.clips.some((c) => media(c) && ticksToSeconds(c.start) < to && ticksToSeconds(clipEnd(c)) > from) ? [i] : []));
  return over.length ? Math.max(...over) + 1 : project.tracks.length;
}

/** The B-roll clips an action works on: those given, else the selected ones. */
function targets(ctx: ActionContext, ids?: string[]): Clip[] {
  // What the editor is editing: an opened group's clips, at main-timeline times.
  const all = ctx.scope.tracks.flatMap((t) => t.clips);
  const chosen = ids ? ids.map((id) => all.find((c) => c.id === id) ?? fail(`no clip "${id}" on the timeline`)) : all.filter((c) => ctx.session.selection.includes(c.id));
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
    "Write a B-roll clip's prompt (`clip`, else the selected one) from what is said under it: OpenAI reads the words (and searches the web for them with the clip's `research`), with its guide, on the user's key. A clip longer than the model makes is split into shots, each with its prompt, one undo step. Runs as a job",
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
          const key = await keyOf(env.secret, OPENAI);
          // Numbered steps with a ticking clock, as Clean with Auphonic's: the stream says which, the clock that it is still going.
          const order: PlanStage[] = b.research ? ["thinking", "searching", "writing"] : ["thinking", "writing"];
          const says: Record<PlanStage, string> = { thinking: `${PLAN_MODEL} is thinking`, searching: "Searching the web", writing: "Writing the shots" };
          const started = Date.now();
          let at: PlanStage = "thinking";
          let since = started;
          const tell = () => {
            const n = order.indexOf(at);
            // No percentage from OpenAI: each step creeps on towards the next.
            const value = (n + 1 - 1 / (1 + (Date.now() - since) / 20_000)) / order.length;
            env.progress(Math.min(0.95, value), `${n + 1} of ${order.length} · ${says[at]} · ${minutes((Date.now() - started) / 1000)}`);
          };
          const ticking = setInterval(tell, 1000);
          tell();
          const plan = await planShots(
            {
              words: said.map((x) => ({ text: x.text, start: x.start, end: x.end })),
              before: text(words.filter((x) => x.end <= from && x.start >= from - CONTEXT)),
              after: text(words.filter((x) => x.start >= to && x.end <= to + CONTEXT)),
              from,
              to,
              guide: b.guide,
              research: b.research,
              aspect,
              shortest: model.durations[0]!,
              longest: model.durations.at(-1)!,
            },
            key,
            (s) => {
              if (!order.includes(s) || order.indexOf(s) <= order.indexOf(at)) return;
              [at, since] = [s, Date.now()];
              tell();
            },
          ).finally(() => clearInterval(ticking));
          // A clip with footage keeps one shot: it gets a new prompt, not a split (its box went with the footage).
          const shots = tile(plan.shots, from, to, b.takes.length ? to - from : model.durations[0]!, model.durations.at(-1)!);
          if (!shots.length) throw new Error("OpenAI planned no shots: try a guide, or a longer clip");
          env.progress(1, shots.length === 1 ? "Prompt written" : `Split into ${shots.length} shots, each with its prompt`);
          return (now) => {
            const was = shapeOf(now.project, now.registry);
            if (!was) throw new Error("the B-roll clip was deleted while it was planned");
            if (was !== shape) throw new Error("the B-roll clip was moved or trimmed while it was planned: plan it again");
            const done = [{ command: "broll.status", args: { clips: [clip.id], planning: false } }];
            if (shots.length === 1) return { label: "Plan B-roll", steps: [{ command: "clip.set", args: { clip: clip.id, props: { broll: { prompt: shots[0]!.prompt, why: shots[0]!.why } } } }], after: () => done };
            // Split where the shots meet, as the editor splits a clip (its effects, animations and look kept), from the
            // last boundary back so the clip itself stays the first shot; each piece then gets its shot's prompt.
            const cuts = shots.slice(1).map((s) => s.start).reverse();
            const steps: ActionStep[] = cuts.map((at) => ({ command: "clip.split", args: { at, clips: [clip.id], linked: false } }));
            const piece = (r: unknown[], k: number) => (k === 0 ? clip.id : (r[cuts.length - k] as string[])[0]!);
            steps.push(...shots.map((s, k) => ({ command: "clip.set", args: (r: unknown[]) => ({ clip: piece(r, k), props: { broll: { prompt: s.prompt, why: s.why } } }) })));
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
    // Grouped meanwhile, a clip is inside its group: still there.
    const there = (id: string) => {
      try {
        return !!findClip(ctx.project, ctx.registry, id);
      } catch {
        return false;
      }
    };
    const steps: ActionStep[] = [];
    for (const m of made) {
      const added = steps.length;
      steps.push({ command: "asset.add", args: m.asset });
      if (there(m.clip)) steps.push({ command: "broll.use", args: (r: unknown[]) => ({ clip: m.clip, asset: r[added] }) });
    }
    const errors = failed.filter((f) => !made.some((m) => m.clip === f.clip));
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
 * The words heard on the timeline and in the group being edited (whose clips are at main-timeline times), from the
 * transcripts already made: narration inside an opened group counts too.
 */
function heardWords(ctx: Pick<ActionContext, "project" | "registry" | "data" | "scope">) {
  const top = timelineWords(ctx.project, ctx.registry, ctx.data);
  if (!ctx.scope.group) return top;
  const inner = timelineWords({ ...ctx.project, tracks: ctx.scope.tracks }, ctx.registry, ctx.data);
  return [...top, ...inner].sort((a, b) => a.start - b.start);
}

/** What is said under a clip on the timeline, from the transcript already made (by whichever transcriber). */
export function wordsUnder(clip: Clip, ctx: Pick<ActionContext, "project" | "registry" | "data" | "scope">): string {
  const [from, to] = [ticksToSeconds(clip.start), ticksToSeconds(clipEnd(clip))];
  return heardWords(ctx)
    .filter((w) => w.end > from && w.start < to)
    .map((w) => w.text)
    .join(" ")
    .trim();
}

/** The prompt a clip is made from: its own, else the words said under it (so a first try needs no OpenAI key). */
function promptFor(clip: Clip, ctx: ActionContext): string {
  const own = brollOf(clip)!.prompt.trim();
  if (own) return own;
  const words = wordsUnder(clip, ctx);
  if (!words) throw new Error("a B-roll clip has no prompt and nothing is said under it: type one");
  return `Footage illustrating: "${words}"`;
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
    const tooLong = clips.filter((c) => seconds(c) > longest + 1e-3);
    if (tooLong.length) throw new Error(`${tooLong.length === 1 ? "a clip is" : `${tooLong.length} clips are`} longer than ${model.title}'s ${longest} s: trim it, or Plan it to split it into shots`);
    const cost = clips.reduce((sum, c) => sum + shotCost(model, resolution, seconds(c)), 0);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)}, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const shots = clips.map((c) => ({ id: c.id, prompt: promptFor(c, ctx), length: seconds(c), region: regionOfClip(c, ctx.project, ctx.registry) }));
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
            if (shots.some((s) => s.length > max + 1e-3)) throw new Error(`${model.title} now makes ${max} s at most, shorter than a clip: trim it`);
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
    const models = comparison(length, ctx.pref);
    const { limit } = brollSettings(ctx.pref);
    const cost = models.reduce((sum, m) => sum + m.cost, 0);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)} for ${models.length} models, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const region = regionOfClip(clip, ctx.project, ctx.registry);
    const shot = { id: clip.id, prompt: promptFor(clip, ctx), length };
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
              if (length <= m.live.durations.at(-1)! + 1e-3) return [m];
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
export const broll = defineFeature({
  id: "broll",
  version: 1,
  clipTypes: [{ id: "broll", description: "B-roll: a placeholder for generated footage (nothing in an export until made), then that footage", traits: ["visual", "picture", "media", "video", "broll"] }],
  props: [
    {
      id: "broll",
      description: "The B-roll a clip asks for: its prompt (and why), the guide and research Plan uses, and the takes made (`{ assetId }`)",
      traits: ["broll"],
      // Beside Visual Properties (1), where annotations have theirs.
      tab: { title: "B-roll", icon: "sparkle", order: 2 },
      schema: brollGroup,
      defaults: () => ({ prompt: "", why: "", guide: "", research: true, takes: [] }),
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
          const versus = comparison(seconds(c), pref);
          return { id: c.id, seconds: lengthFor(model, seconds(c)), cost: shotCost(model, resolution, seconds(c)), compare: { models: versus.length, cost: versus.reduce((sum, m) => sum + m.cost, 0) } };
        });
        return { for: asked, model: model.title, resolution, limit, longest: model.durations.at(-1), total: each.reduce((sum, c) => sum + c.cost, 0), clips: each };
      },
    }),
  ],
  actions: [brollAdd, brollPlan, brollGenerate, brollCompare],
});
