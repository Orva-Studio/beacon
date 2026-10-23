import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { jobSignal } from "@beacon/media";
import { defineAction, defineFeature, defineQuery, ticksToSeconds, clipEnd, type ActionContext, type ActionStep, type Asset, type Clip, type FeatureRegistry, type Preferences, type Project, type Session, type SessionCommandDef, type TaskEnv } from "@beacon/model";
import { timelineWords } from "../transcript";
import { DEFAULT_MODEL, lengthFor, nearestAspect, resolutionOf, shotCost, VIDEO_MODELS, videoModel, type Resolution, type VideoModel } from "./models";
import { planShots, tile, PLAN_MODEL } from "./plan";
import { generate, limits, type Limits } from "./replicate";

export { VIDEO_MODELS, videoModel, resolutionOf, shotCost, nearestAspect, lengthFor } from "./models";

const TOKEN = "replicate-api-token";
const OPENAI = "openai-api-key";
/** Seconds of talk either side of the range the planner reads for context. */
const CONTEXT = 15;

/** A region of the canvas in canvas pixels from its top left: x, y, width, height. */
export type Rect = [number, number, number, number];

export interface BrollCandidate {
  /** The file, in the project's `media/B-roll` folder. */
  path: string;
  /** As `asset.add` takes it, probed. */
  asset: Omit<Asset, "id">;
  prompt: string;
  model: string;
  aspect: string;
  seconds: number;
  /** Dollars, estimated from the model's price per second. */
  cost: number;
}

export interface BrollShot {
  id: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  prompt: string;
  why: string;
  /** Placed by Apply: on unless the user unticks it. */
  use: boolean;
  /** The footage Apply places and the canvas previews. */
  candidate?: BrollCandidate;
  /** Its earlier footage (made again, or by other models), to pick instead. */
  others?: BrollCandidate[];
  /** Being made now (a job). */
  making?: boolean;
  error?: string;
}

/** B-roll's review, open in the properties panel: what it covers, how it is planned, and the shots. */
export interface BrollReview {
  from: number;
  to: number;
  guide: string;
  research: boolean;
  /** Where on the canvas it goes; null: the whole canvas. */
  region: Rect | null;
  /** The canvas is taking a drawn region. */
  drawing: boolean;
  /** The plan being made: its request, so an answer for a review closed or moved since is dropped. */
  planning?: string;
  /** What the planner's research found. */
  notes?: string;
  shots: BrollShot[];
  error?: string;
}

export const brollReview = (s: Session) => s.features.broll as BrollReview | undefined;

const need = (s: Session) => {
  const r = brollReview(s);
  if (!r) throw new Error("B-roll's review isn't open: broll.review opens it");
  return r;
};

const id = () => Math.random().toString(36).slice(2, 8);

export const regionOf = (r: Pick<BrollReview, "region">, project: Project): Rect => r.region ?? [0, 0, project.settings.width, project.settings.height];

/** The model, its resolution and the limit, as Settings › AI has them. */
export const brollSettings = (pref: Preferences) => {
  const model = videoModel(pref("brollModel"));
  return { model, resolution: resolutionOf(model, pref("brollResolution")) as Resolution, limit: Number(pref("brollLimit")) || 0 };
};

/** What generating these shots costs, by the model's listed price. */
export const estimate = (shots: Pick<BrollShot, "start" | "end">[], pref: Preferences) => {
  const { model, resolution } = brollSettings(pref);
  return shots.reduce((sum, s) => sum + shotCost(model, resolution, s.end - s.start), 0);
};

const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

const sessionCommands: SessionCommandDef[] = [
  {
    id: "broll.review",
    description:
      "Open B-roll's review (the AI panel's B-roll tile does) over the range (`from`/`to` timeline seconds, else the range dragged on the ruler), or change it: `guide` (what to show or avoid), `research` (the planner searches the web for what is said), `region` ([x, y, width, height] canvas pixels from the top left, or null for the whole canvas), `drawing` (the canvas takes a drawn region). A new range drops the planned shots. Then broll.plan",
    args: z.strictObject({
      from: z.number().nonnegative().optional(),
      to: z.number().positive().optional(),
      guide: z.string().max(1000).optional(),
      research: z.boolean().optional(),
      region: RectSchema.nullable().optional(),
      drawing: z.boolean().optional(),
    }),
    apply: (s, a: { from?: number; to?: number; guide?: string; research?: boolean; region?: Rect | null; drawing?: boolean }, { project }) => {
      const was = brollReview(s);
      const from = a.from ?? was?.from ?? s.range?.in;
      const to = a.to ?? was?.to ?? s.range?.out;
      if (from === undefined || to === undefined) throw new Error("drag a range on the ruler over the words the B-roll should cover (or give `from` and `to`)");
      if (to - from < 0.5) throw new Error("the range is under half a second: B-roll needs a stretch of the talk");
      if (a.region) {
        const [x, y, w, h] = a.region;
        if (x < -1 || y < -1 || x + w > project.settings.width + 1 || y + h > project.settings.height + 1) throw new Error(`the region must be inside the ${project.settings.width}×${project.settings.height} canvas`);
      }
      const moved = !!was && (Math.abs(was.from - from) > 1e-3 || Math.abs(was.to - to) > 1e-3);
      const given = Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && k !== "from" && k !== "to"));
      s.features.broll = {
        ...(was ?? { guide: "", research: true, region: null, drawing: false, shots: [] }),
        ...given,
        from,
        to,
        ...(moved ? { shots: [], notes: undefined, error: undefined, planning: undefined } : {}),
      } satisfies BrollReview;
    },
  },
  {
    id: "broll.shot",
    description: "Change a planned shot: its `prompt` (broll.generate makes it again), `use` (whether Apply places it), or `pick` (the path of footage it made before, to show and place instead)",
    args: z.strictObject({ shot: z.string().min(1), prompt: z.string().min(1).max(2000).optional(), use: z.boolean().optional(), pick: z.string().min(1).optional() }),
    apply: (s, { shot, prompt, use, pick }: { shot: string; prompt?: string; use?: boolean; pick?: string }) => {
      const r = need(s);
      const x = r.shots.find((x) => x.id === shot);
      if (!x) throw new Error(`no shot "${shot}" in the review: ${r.shots.map((x) => x.id).join(", ") || "plan it first"}`);
      if (prompt !== undefined) x.prompt = prompt;
      if (use !== undefined) x.use = use;
      if (pick !== undefined && pick !== x.candidate?.path) {
        const other = x.others?.find((c) => c.path === pick);
        if (!other) throw new Error(`shot "${shot}" made no ${pick}`);
        x.others = [...x.others!.filter((c) => c !== other), ...(x.candidate ? [x.candidate] : [])];
        x.candidate = other;
      }
    },
  },
  {
    id: "broll.planned",
    description: "Set the review's shots (broll.plan's job does, when OpenAI answers), or its `error`, for the plan `request` it is making; any other is dropped",
    args: z.strictObject({
      request: z.string(),
      shots: z.array(z.strictObject({ start: z.number(), end: z.number(), prompt: z.string(), why: z.string() })).optional(),
      notes: z.string().optional(),
      error: z.string().optional(),
    }),
    apply: (s, { request, shots, notes, error }: { request: string; shots?: { start: number; end: number; prompt: string; why: string }[]; notes?: string; error?: string }) => {
      const r = brollReview(s);
      // Closed, or its range changed, while it planned: what it planned is dropped (it cost a few cents).
      if (r?.planning !== request) return;
      r.planning = undefined;
      r.error = error;
      if (shots) {
        r.shots = shots.map((x) => ({ ...x, id: id(), use: true }));
        r.notes = notes;
      }
    },
  },
  {
    id: "broll.making",
    description: "Mark shots as being planned or made (broll.plan and broll.generate do)",
    args: z.strictObject({ shots: z.array(z.string()).optional(), planning: z.string().optional() }),
    apply: (s, { shots, planning }: { shots?: string[]; planning?: string }) => {
      const r = need(s);
      if (planning !== undefined) r.planning = planning;
      for (const x of r.shots) if (shots?.includes(x.id)) Object.assign(x, { making: true, error: undefined });
    },
  },
  {
    id: "broll.made",
    description: "Give shots what was made for them, or why it failed (broll.generate's job does)",
    args: z.strictObject({ results: z.array(z.strictObject({ shot: z.string(), candidate: z.unknown().optional(), error: z.string().optional() })) }),
    apply: (s, { results }: { results: { shot: string; candidate?: BrollCandidate; error?: string }[] }) => {
      const r = brollReview(s);
      // Closed while it made them: the files are kept in media/B-roll.
      if (!r) return;
      for (const m of results) {
        const x = r.shots.find((x) => x.id === m.shot);
        if (!x) continue;
        x.making = false;
        x.error = m.error;
        if (!m.candidate) continue;
        if (x.candidate) x.others = [...(x.others ?? []), x.candidate];
        x.candidate = m.candidate;
      }
    },
  },
  {
    id: "broll.close",
    description: "Close B-roll's review without placing anything (footage made is kept in the project's media/B-roll folder)",
    args: z.strictObject({}),
    apply: (s) => void delete s.features.broll,
  },
];

/**
 * Where the B-roll track goes: right above the highest track with media over the range (the talk), so captions
 * and annotations above it stay in front.
 */
function trackIndex(project: Project, registry: FeatureRegistry, from: number, to: number): number {
  // A group holding media is the talk too: its picture would otherwise cover the B-roll.
  const media = (c: Clip): boolean => !!c.assetId || registry.groupsFor(c.type).some((g) => g.nested && c.props[g.id] && g.nested(c.props[g.id]).some((t) => t.clips.some(media)));
  const over = project.tracks.flatMap((t, i) => (t.clips.some((c) => media(c) && ticksToSeconds(c.start) < to && ticksToSeconds(clipEnd(c)) > from) ? [i] : []));
  return over.length ? Math.max(...over) + 1 : project.tracks.length;
}

/** The candidate scaled to cover the region and cropped to it, centred: transform and crop as `clip.set` takes them. */
function fitted(c: BrollCandidate, region: Rect, project: Project) {
  const v = (c.asset.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined)?.streams?.find((s) => s.kind === "video");
  const [W, H] = [v?.width ?? 1280, v?.height ?? 720];
  const [x, y, w, h] = region;
  const k = Math.max(w / W, h / H);
  const [cw, ch] = [(W - w / k) / 2, (H - h / k) / 2];
  return {
    transform: { x: x + w / 2 - project.settings.width / 2, y: project.settings.height / 2 - (y + h / 2), scaleX: k, scaleY: k, rotation: 0, rotationX: 0, rotationY: 0 },
    crop: { left: cw, right: cw, top: ch, bottom: ch },
  };
}

/**
 * The document steps that place the review's picked candidates: a B-roll track above the talk, each shot's footage
 * over its span, fitted to the region. Apply runs them as one undo step; the canvas shows them while it is open.
 */
export function brollSteps(r: BrollReview, project: Project, registry: FeatureRegistry): ActionStep[] {
  const shots = r.shots.filter((s) => s.use && s.candidate);
  if (!shots.length) return [];
  const region = regionOf(r, project);
  const steps: ActionStep[] = [{ command: "track.add", args: { name: "B-roll", index: trackIndex(project, registry, r.from, r.to) } }];
  for (const s of shots) {
    const c = s.candidate!;
    const added = steps.length;
    steps.push({ command: "asset.add", args: { ...c.asset, name: `B-roll: ${c.prompt.slice(0, 60)}`, derived: { ...c.asset.derived, broll: { prompt: c.prompt, model: c.model, cost: c.cost } } } });
    const placed = steps.length;
    const clip = (res: unknown[]) => (res[placed] as string[])[0]!;
    steps.push({ command: "asset.place", args: (res: unknown[]) => ({ asset: res[added], time: s.start, track: res[0] }) });
    steps.push({ command: "clip.trim", args: (res: unknown[]) => ({ clip: clip(res), end: s.end, linked: false }) });
    steps.push({ command: "clip.set", args: (res: unknown[]) => ({ clip: clip(res), props: fitted(c, region, project) }) });
  }
  return steps;
}

const keyOf = async (secret: (id: string) => Promise<string | undefined>, which: string, where: string) => {
  const key = await secret(which);
  if (!key) throw new Error(`no ${which === TOKEN ? "Replicate API token" : "OpenAI API key"}: add one in Settings › ${where}`);
  return key;
};

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const brollPlan = defineAction({
  id: "broll.plan",
  description:
    "Plan B-roll over the open review's range (opening it with these settings first, as broll.review takes them): OpenAI reads what is said there (and searches the web for it with `research`) and writes a shot list, each shot's span, prompt and why, shown on the timeline with what generating it would cost. The words and the guide are sent to OpenAI, on the user's key. Runs as a job",
  args: z.strictObject({
    from: z.number().nonnegative().optional(),
    to: z.number().positive().optional(),
    guide: z.string().max(1000).optional(),
    research: z.boolean().optional(),
    region: RectSchema.nullable().optional(),
  }),
  resolve: (args, ctx) => {
    const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const open = brollReview(ctx.session);
    if (!open && !ctx.session.range && (args.from === undefined || args.to === undefined)) throw new Error("drag a range on the ruler over the words the B-roll should cover (or give `from` and `to`)");
    const from = args.from ?? open?.from ?? ctx.session.range!.in;
    const to = args.to ?? open?.to ?? ctx.session.range!.out;
    const words = timelineWords(ctx.project, ctx.registry, ctx.data);
    const said = words.filter((w) => w.end > from && w.start < to);
    if (!said.length) throw new Error("nothing is said over the range yet: B-roll is planned from the transcript (wait for it, or pick a range with speech)");
    const guide = args.guide ?? open?.guide ?? "";
    const research = args.research ?? open?.research ?? true;
    const region = args.region !== undefined ? args.region : (open?.region ?? null);
    const [, , w, h] = regionOf({ region }, ctx.project);
    const { model } = brollSettings(ctx.pref);
    // A model that picks its own shape is told the region's, and its footage cropped to it.
    const aspect = nearestAspect(model, w, h) ?? `${Math.round(w)}:${Math.round(h)}`;
    const text = (ws: typeof words) => ws.map((x) => x.text).join(" ");
    const request = id();
    return {
      label: "Plan B-roll",
      before: [
        { command: "broll.review", args: given },
        { command: "broll.making", args: { planning: request } },
      ],
      task: {
        label: "Plan B-roll",
        run: async (env) => {
          const key = await keyOf(env.secret, OPENAI, "AI");
          env.progress(0.1, research ? `${PLAN_MODEL}: researching and planning the shots` : `${PLAN_MODEL}: planning the shots`);
          const plan = await planShots(
            {
              words: said.map((x) => ({ text: x.text, start: x.start, end: x.end })),
              before: text(words.filter((x) => x.end <= from && x.start >= from - CONTEXT)),
              after: text(words.filter((x) => x.start >= to && x.end <= to + CONTEXT)),
              from,
              to,
              guide,
              research,
              aspect,
              shortest: model.durations[0]!,
              longest: model.durations.at(-1)!,
            },
            key,
          );
          const shots = tile(plan.shots, from, to, model.durations[0]!, model.durations.at(-1)!);
          if (!shots.length) throw new Error("OpenAI planned no shots: try a guide, or a longer range");
          env.progress(1, `${shots.length} shot${shots.length === 1 ? "" : "s"} planned: about $${estimate(shots, env.pref).toFixed(2)} to generate`);
          return () => ({ label: "Plan B-roll", before: [{ command: "broll.planned", args: { request, shots, notes: plan.research } }] });
        },
        failed: (error) => [{ command: "broll.planned", args: { request, ...(error === "cancelled" ? {} : { error }) } }],
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

type Made = { shot: string; candidate?: BrollCandidate; error?: string };

/** The resolution input `asked` as the model lists them now: 1080p asked and missing, its best below. */
function resolutionInput(asked: Record<string, unknown> | undefined, live: Limits): Record<string, unknown> {
  const r = asked?.resolution;
  if (typeof r !== "string" || !live.resolutions || live.resolutions.includes(r)) return asked ?? {};
  return { ...asked, resolution: live.resolutions.includes("720p") ? "720p" : live.resolutions[0] };
}

/**
 * One shot made with one model (`live`, what it takes now), saved in `dir` beside a `.json` of what made it: its
 * footage, or why there is none. A cancelled job's shot reports nothing.
 */
async function makeShot(env: TaskEnv, token: string, model: VideoModel, live: Limits, resolution: Resolution, s: BrollShot, n: number, [w, h]: [number, number], dir: string, waiting: () => void): Promise<Made | undefined> {
  const seconds = lengthFor(live, s.end - s.start);
  const aspect = nearestAspect(live, w, h);
  const words = s.prompt.replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).slice(0, 6).join(" ");
  const out = freeName(dir, `Shot ${n} - ${model.title} - ${words}`);
  try {
    const input: Record<string, unknown> = { prompt: s.prompt, aspect_ratio: aspect, duration: live.durationText ? String(seconds) : seconds, generate_audio: false, ...resolutionInput(model.resolutions[resolution], live) };
    for (const k of Object.keys(input)) if (input[k] === undefined || !live.fields.has(k)) delete input[k];
    await generate(token, model, input, out, waiting);
  } catch (e) {
    // Nothing paid for arrived: the file is a placeholder, or half a download.
    rmSync(out, { force: true });
    if (jobSignal()?.aborted) return undefined;
    return { shot: s.id, error: e instanceof Error ? e.message : String(e) };
  }
  // Downloaded, it is kept whatever happens next: it was paid for.
  try {
    const asset = await env.asset(out, "video");
    const v = (asset.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined)?.streams?.find((x) => x.kind === "video");
    const candidate: BrollCandidate = { path: out, asset, prompt: s.prompt, model: model.title, aspect: aspect ?? `${v?.width}×${v?.height}`, seconds, cost: shotCost({ ...model, durations: live.durations }, resolution, s.end - s.start) };
    writeFileSync(out.replace(/\.mp4$/, ".json"), JSON.stringify({ prompt: s.prompt, model: model.slug, resolution, aspect: candidate.aspect, seconds, estimatedCost: candidate.cost, made: new Date().toISOString() }, null, 2));
    return { shot: s.id, candidate };
  } catch (e) {
    if (jobSignal()?.aborted) return undefined;
    return { shot: s.id, error: `made, but couldn't be read (kept as ${basename(out)} in media/B-roll): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The job's end: what was made goes to the review; with nothing made, the first reason fails the job. */
function finished(env: TaskEnv, results: Made[]) {
  jobSignal()?.throwIfAborted();
  const made = results.filter((x) => x.candidate).length;
  const failed = results.filter((x) => x.error);
  if (!made) throw new Error(failed[0]?.error ?? "nothing was made");
  env.progress(1, [`${made} made, in the project's media/B-roll folder`, failed.length ? `${failed.length} failed: ${failed[0]!.error}` : ""].filter(Boolean).join("; "));
  return () => ({ label: "Generate B-roll", before: [{ command: "broll.made", args: { results } }] });
}

/** What was made before a job failed or was cancelled is kept; the shots with nothing say why. */
const failedSteps = (results: Made[], shots: string[]) => (error: string) => [
  { command: "broll.made", args: { results: [...results, ...shots.filter((id) => !results.some((x) => x.shot === id)).map((shot) => ({ shot, ...(error === "cancelled" ? {} : { error }) }))] } },
];

const progress = (env: TaskEnv, results: Made[], total: number, started: number) => () =>
  env.progress(0.05 + (0.95 * results.length) / total, `${results.filter((x) => x.candidate).length} of ${total} made · ${minutes((Date.now() - started) / 1000)}`);

const brollGenerate = defineAction({
  id: "broll.generate",
  description:
    "Generate footage for the open review's shots (`shots`: their ids, to make one again; else every shot without footage) with the model chosen in Settings › AI, through Replicate on the user's token: each prompt and the region's shape are sent, and Replicate charges their account (the review shows the estimate). Each file is saved in the project's media/B-roll folder as it arrives, with its prompt, model and cost; a shot's earlier footage stays to pick again. Refused over the limit set in Settings › AI. Runs as a job. Only when the user asks: it spends their money",
  args: z.strictObject({ shots: z.array(z.string().min(1)).min(1).optional() }),
  resolve: ({ shots: ids }, ctx: ActionContext) => {
    const r = need(ctx.session);
    if (!r.shots.length) throw new Error("plan the shots first (broll.plan)");
    const unknown = ids?.filter((x) => !r.shots.some((s) => s.id === x)) ?? [];
    if (unknown.length) throw new Error(`no shot ${unknown.join(", ")} in the review`);
    const shots = r.shots.filter((s) => (ids ? ids.includes(s.id) : !s.candidate) && !s.making);
    if (!shots.length) throw new Error(ids ? "those shots are being made already" : "every shot has footage: give `shots` to make one again");
    const { model, resolution, limit } = brollSettings(ctx.pref);
    // Planned for a model that makes longer shots: made shorter, they would leave gaps when placed.
    const longest = model.durations.at(-1)!;
    const tooLong = shots.filter((s) => s.end - s.start > longest + 1e-3);
    if (tooLong.length) throw new Error(`${tooLong.length === 1 ? "a shot is" : `${tooLong.length} shots are`} longer than ${model.title}'s ${longest} s: plan again for it`);
    const cost = estimate(shots, ctx.pref);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)}, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const [, , w, h] = regionOf(r, ctx.project);
    const index = new Map(r.shots.map((s, i) => [s.id, i + 1]));
    const results: Made[] = [];
    return {
      label: "Generate B-roll",
      before: [{ command: "broll.making", args: { shots: shots.map((s) => s.id) } }],
      task: {
        label: `B-roll: ${shots.length === 1 ? "1 shot" : `${shots.length} shots`} with ${model.title}`,
        run: async (env) => {
          const dir = join(env.mediaDir, "B-roll");
          mkdirSync(dir, { recursive: true });
          const tell = progress(env, results, shots.length, Date.now());
          const ticking = setInterval(tell, 1000);
          try {
            const token = await keyOf(env.secret, TOKEN, "AI");
            const live = await limits(token, model);
            // Checked again by what the model makes now, before anything is paid for.
            const max = live.durations.at(-1)!;
            if (shots.some((s) => s.end - s.start > max + 1e-3)) throw new Error(`${model.title} now makes ${max} s at most, shorter than a shot: plan again`);
            const charged = shots.reduce((sum, s) => sum + shotCost({ ...model, durations: live.durations }, resolution, s.end - s.start), 0);
            if (limit > 0 && charged > limit) throw new Error(`about $${charged.toFixed(2)} at the lengths ${model.title} makes now, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
            await Promise.all(
              shots.map(async (s) => {
                const m = await makeShot(env, token, model, live, resolution, s, index.get(s.id)!, [w, h], dir, tell);
                if (m) results.push(m);
                tell();
              }),
            );
            return finished(env, results);
          } finally {
            clearInterval(ticking);
          }
        },
        failed: failedSteps(results, shots.map((s) => s.id)),
      },
    };
  },
});

/** The models that can make a shot this long, each with what it would cost. */
export function comparison(seconds: number, pref: Preferences) {
  const asked = pref("brollResolution");
  return VIDEO_MODELS.filter((m) => m.durations.at(-1)! >= seconds - 1e-3).map((m) => ({ model: m, resolution: resolutionOf(m, asked), cost: shotCost(m, resolutionOf(m, asked), seconds) }));
}

const brollCompare = defineAction({
  id: "broll.compare",
  description:
    "Make one shot of the open review with every model that can make it that long (Settings › AI's list, at its resolution), side by side: each is kept on the shot, the last made shown, the others picked with broll.shot `pick`, previewed in place, to choose a default model. Replicate charges the user's account for each (broll.estimate's `compare`); refused over the limit per generation. Runs as a job. Only when the user asks",
  args: z.strictObject({ shot: z.string().min(1) }),
  resolve: ({ shot }, ctx) => {
    const r = need(ctx.session);
    const s = r.shots.find((x) => x.id === shot);
    if (!s) throw new Error(`no shot "${shot}" in the review`);
    if (s.making) throw new Error("that shot is being made already");
    const models = comparison(s.end - s.start, ctx.pref);
    const { limit } = brollSettings(ctx.pref);
    const cost = models.reduce((sum, m) => sum + m.cost, 0);
    if (limit > 0 && cost > limit) throw new Error(`about $${cost.toFixed(2)} for ${models.length} models, over the $${limit.toFixed(2)} limit per generation set in Settings › AI`);
    const [, , w, h] = regionOf(r, ctx.project);
    const n = r.shots.indexOf(s) + 1;
    const results: Made[] = [];
    return {
      label: "Compare B-roll models",
      before: [{ command: "broll.making", args: { shots: [s.id] } }],
      task: {
        label: `B-roll: shot ${n} with ${models.length} models`,
        run: async (env) => {
          const dir = join(env.mediaDir, "B-roll");
          mkdirSync(dir, { recursive: true });
          const tell = progress(env, results, models.length, Date.now());
          const ticking = setInterval(tell, 1000);
          try {
            const token = await keyOf(env.secret, TOKEN, "AI");
            await Promise.all(
              models.map(async ({ model, resolution }) => {
                try {
                  const live = await limits(token, model);
                  if (s.end - s.start > live.durations.at(-1)! + 1e-3) return void results.push({ shot: s.id, error: `${model.title} makes ${live.durations.at(-1)} s at most` });
                  const m = await makeShot(env, token, model, live, resolution, s, n, [w, h], dir, tell);
                  if (m) results.push(m);
                } catch (e) {
                  if (!jobSignal()?.aborted) results.push({ shot: s.id, error: `${model.title}: ${e instanceof Error ? e.message : String(e)}` });
                }
                tell();
              }),
            );
            return finished(env, results);
          } finally {
            clearInterval(ticking);
          }
        },
        failed: failedSteps(results, [s.id]),
      },
    };
  },
});

const brollApply = defineAction({
  id: "broll.apply",
  description:
    "Place the open review's footage (the shots ticked that have it) on a new B-roll track above the talk, each over its span, fitted to the region, in one undo step, and close the review; the talk's audio is untouched. Only when the user asks",
  args: z.strictObject({}),
  resolve: (_, ctx) => {
    const r = need(ctx.session);
    if (r.shots.some((s) => s.making)) throw new Error("footage is still being made: wait for it, or untick those shots");
    const steps = brollSteps(r, ctx.project, ctx.registry);
    if (!steps.length) throw new Error(r.shots.some((s) => s.candidate) ? "no shot with footage is ticked" : "no footage yet: generate the shots first (broll.generate)");
    return {
      label: "Add B-roll",
      steps,
      after: (res) => [
        { command: "broll.close" },
        { command: "selection.set", args: { clips: steps.flatMap((s, i) => (s.command === "asset.place" ? [(res[i] as string[])[0]!] : [])), linked: false } },
      ],
    };
  },
});

/**
 * AI B-roll: generated footage over a stretch of the talk, planned from what is said there (OpenAI, with web
 * research), made through Replicate on the user's token, previewed in place on the canvas, placed in one undo step.
 */
export const broll = defineFeature({
  id: "broll",
  version: 1,
  panels: [{ open: (s) => !!brollReview(s), cancel: "broll.close", apply: { action: "broll.apply" } }],
  secrets: [{ id: TOKEN, title: "Replicate API token" }],
  preferences: [
    {
      id: "brollModel",
      title: "B-roll model",
      description: "The text-to-video model B-roll's footage is made with, through Replicate on your token",
      options: VIDEO_MODELS.map((m) => ({
        id: m.id,
        title: m.title,
        description: `About $${(m.perSecond["1080p"] ?? m.perSecond["720p"])!.toFixed(2)} a second of footage; makes ${m.aspects.join(", ")}, ${m.durations[0]}-${m.durations.at(-1)} s a shot`,
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
  sessionPreview: (s, project, registry) => {
    const r = brollReview(s);
    return r ? brollSteps(r, project, registry) : undefined;
  },
  queries: [
    defineQuery({
      id: "broll.estimate",
      description: "What generating the open review's shots would cost (dollars, by the chosen model's price per second), all of them and each, with the model and its resolution; each shot's `compare`: what broll.compare would cost, and with how many models. `for` is echoed back, so a caller can tell the answer to its latest ask",
      args: z.strictObject({ for: z.string().optional() }),
      run: ({ for: asked }, { session, pref }) => {
        const r = session ? brollReview(session) : undefined;
        if (!r) throw new Error("B-roll's review isn't open: broll.review opens it");
        const { model, resolution, limit } = brollSettings(pref);
        return { for: asked, model: model.title, resolution, limit, longest: model.durations.at(-1), total: estimate(r.shots, pref), shots: r.shots.map((s) => {
          const all = comparison(s.end - s.start, pref);
          return { id: s.id, seconds: lengthFor(model, s.end - s.start), cost: shotCost(model, resolution, s.end - s.start), compare: { models: all.length, cost: all.reduce((sum, m) => sum + m.cost, 0) } };
        }) };
      },
    }),
  ],
  actions: [brollPlan, brollGenerate, brollCompare, brollApply],
});
