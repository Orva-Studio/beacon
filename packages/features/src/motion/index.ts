import { z } from "zod";
import { fontFamilies, textLayout } from "@beacon/media";
import {
  clipEnd,
  clipSpeed,
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  drawNested,
  eachRawClip,
  findClip,
  secondsToTicks,
  ticksToSeconds,
  type ActionContext,
  type ActionStep,
  type Clip,
  type CommandContext,
  type Project,
  type Session,
  type SessionCommandDef,
  type TextSpec,
  type Track,
} from "@beacon/model";
import { heardWords, timelineSpan, trackIndex } from "../broll";
import { BACKGROUNDS, build, KIND_GUIDE, KINDS, PieceSchema, type Part } from "./blocks";
import { DEFAULT_LOOK, lookOf, LOOKS } from "./looks";
import { compose, writeIdea, type Said } from "./compose";

export { BACKGROUNDS, KINDS, KIND_GUIDE, type Background, type Piece } from "./blocks";
export { LOOKS, type Look } from "./looks";

const TRACK = "Motion graphics";
const OPENAI = "openai-api-key";
/** A placeholder added at the playhead lasts this long. */
const PLACEHOLDER_SECONDS = 4;
/** Seconds of talk either side of a clip Write reads for context. */
const CONTEXT = 10;

const motionGroup = z.strictObject({
  /** Auto's prompt, as Write wrote it from the words under the clip, and why. */
  prompt: z.string().max(1000),
  why: z.string(),
  /** Which prompt it is made from: Auto's (`prompt`) or the one typed (`manual`). */
  source: z.enum(["auto", "manual"]),
  manual: z.string().max(1000),
  /** Every graphic made, its prompt and pieces kept so an earlier one can be picked again; `shown` is the one in the clip. */
  takes: z.array(z.strictObject({ prompt: z.string(), pieces: z.array(PieceSchema) })),
  shown: z.number().int().min(-1),
  /** Its design (a Look's id) and what is behind it. */
  look: z.string(),
  background: z.enum(BACKGROUNDS),
});
export type MotionProps = z.infer<typeof motionGroup>;

/** What motion graphics are doing for which clips (`session.features.motion`): prompts written, graphics made, and why the last try failed. */
export interface MotionState {
  writing: string[];
  making: string[];
  errors: Record<string, string>;
}
const IDLE: MotionState = { writing: [], making: [], errors: {} };
export const motionState = (s: Session) => (s.features.motion as MotionState | undefined) ?? IDLE;
export const motionOf = (c: Clip) => c.props.motion as MotionProps | undefined;

type Box = { width: number; height: number; tracks: Track[] };

/** The Text annotation's font: a Look's when it names none, or one this Mac hasn't. */
function textFont(ctx: Pick<CommandContext, "registry">): string {
  const callout = ctx.registry.annotations.get("text")?.props.callout as { text: TextSpec } | undefined;
  return callout?.text.font ?? "Helvetica Neue";
}

/**
 * The clip's graphic built again from the take it shows, in its Look and background, at the size its box shows: the
 * box's scale goes into its size, so text isn't stretched. Edits made inside the clip are replaced.
 */
function rebuild(c: Clip, ctx: CommandContext) {
  const m = motionOf(c)!;
  const box = c.props.group as Box;
  const t = { scaleX: 1, scaleY: 1, ...(c.props.transform as Partial<Record<"scaleX" | "scaleY", number>> | undefined) };
  box.width = Math.max(1, Math.round(box.width * Math.abs(t.scaleX)));
  box.height = Math.max(1, Math.round(box.height * Math.abs(t.scaleY)));
  if (c.props.transform) Object.assign(c.props.transform, { scaleX: Math.sign(t.scaleX) || 1, scaleY: Math.sign(t.scaleY) || 1 });
  const families = new Set(fontFamilies());
  const parts = build(m.takes[m.shown]!.pieces, {
    width: box.width,
    height: box.height,
    length: ticksToSeconds(c.duration) * clipSpeed(c),
    look: lookOf(m.look),
    fallbackFont: textFont(ctx),
    hasFont: (f) => families.has(f),
    background: m.background,
    layout: textLayout,
  });
  if (!parts.length) throw new Error("that graphic has nothing to draw");
  box.tracks = parts.map((p) => ({
    id: ctx.newId("track"),
    name: (p.props.callout as { text?: { text: string } } | undefined)?.text?.text.replace("{n}", "#") ?? "Shape",
    clips: [toClip(p, ctx)],
  }));
  c.mediaStart = 0;
}

/** Every motion graphics clip in the project, inside groups too. */
function motionClips(doc: Project): Clip[] {
  const out: Clip[] = [];
  eachRawClip(doc, (o) => {
    if ((o as Clip).type === "motion") out.push(o as Clip);
  });
  return out;
}

function toClip(part: Part, ctx: CommandContext): Clip {
  return {
    id: ctx.newId("clip"),
    type: part.type,
    start: secondsToTicks(part.start),
    duration: secondsToTicks(part.duration),
    mediaStart: 0,
    props: part.props,
    effects: part.effects.map((fx) => ({ id: ctx.newId("fx"), type: fx.type, enabled: true, params: { ...ctx.registry.effect(fx.type).defaults(), ...fx.params } })),
    animations: part.animations.map((a) => ({ id: ctx.newId("anim"), end: secondsToTicks(a.end), duration: secondsToTicks(a.duration), easing: a.easing, to: a.to })),
  };
}

const fail = (message: string): never => {
  throw new Error(message);
};

const commands = [
  defineCommand({
    id: "motion.use",
    description:
      "Show a graphic in a motion graphics clip: `pieces` (a new take, kept with its `prompt`), or `take`, the index of one made before. Its text, shapes and animations are built in the clip's box as it is sized now; edits made inside the clip are replaced",
    args: z.union([z.strictObject({ clip: z.string().min(1), take: z.int().nonnegative() }), z.strictObject({ clip: z.string().min(1), prompt: z.string(), pieces: z.array(PieceSchema).min(1) })]),
    apply(doc, args, ctx) {
      const { clip: c, track } = findClip(doc, ctx.registry, args.clip);
      const m = motionOf(c);
      if (c.type !== "motion" || !m) throw new Error(`clip "${args.clip}" isn't a motion graphic`);
      if (track.locked) throw new Error(`track "${track.name}" is locked`);
      if ("pieces" in args) {
        m.takes.push({ prompt: args.prompt, pieces: args.pieces });
        m.shown = m.takes.length - 1;
      } else {
        if (!m.takes[args.take]) throw new Error(`the clip has no take ${args.take}`);
        m.shown = args.take;
      }
      rebuild(c, ctx);
    },
  }),
  defineCommand({
    id: "motion.style",
    description:
      "Change motion graphics clips' Look (`look`, a motion.looks id) or background (none, dim, card): `clips`, else every motion graphic in the project (how Use for All applies a Look). Those made are built again in it; edits made inside them are replaced",
    args: z.strictObject({ clips: z.array(z.string().min(1)).optional(), look: z.string().min(1).optional(), background: z.enum(BACKGROUNDS).optional() }),
    apply(doc, { clips, look, background }, ctx) {
      if (look && !LOOKS.some((l) => l.id === look)) throw new Error(`no Look "${look}"; there are: ${LOOKS.map((l) => l.id).join(", ")}`);
      const targets = clips ? clips.map((id) => findClip(doc, ctx.registry, id).clip) : motionClips(doc);
      for (const c of targets) {
        const m = motionOf(c);
        if (c.type !== "motion" || !m) throw new Error(`clip "${c.id}" isn't a motion graphic`);
        if (look) m.look = look;
        if (background) m.background = background;
        if (m.shown >= 0) rebuild(c, ctx);
      }
    },
  }),
];

const sessionCommands: SessionCommandDef[] = [
  {
    id: "motion.status",
    description: "Mark motion graphics clips as having their prompt written or being made, or not (motion.write and motion.make do), with why the last try failed (`error`, null to clear)",
    args: z.strictObject({ clips: z.array(z.string()), writing: z.boolean().optional(), making: z.boolean().optional(), error: z.string().nullable().optional() }),
    apply: (s, { clips, writing, making, error }: { clips: string[]; writing?: boolean; making?: boolean; error?: string | null }) => {
      const was = motionState(s);
      const mark = (list: string[], on?: boolean) => (on === undefined ? list : on ? [...new Set([...list, ...clips])] : list.filter((id) => !clips.includes(id)));
      const errors = { ...was.errors };
      for (const id of clips) if (error === null || writing || making) delete errors[id];
      if (error) for (const id of clips) errors[id] = error;
      s.features.motion = { writing: mark(was.writing, writing), making: mark(was.making, making), errors } satisfies MotionState;
    },
  },
];

/** The motion graphics clip an action works on: the one given, else the selected one. */
function target(ctx: ActionContext, id?: string): Clip {
  const all = ctx.scope.tracks.flatMap((t) => t.clips);
  const clip = id ? (all.find((c) => c.id === id) ?? fail(`no clip "${id}" on the timeline`)) : all.find((c) => ctx.session.selection.includes(c.id) && c.type === "motion");
  if (!clip || clip.type !== "motion") throw new Error(id ? `clip "${id}" isn't a motion graphic` : "select a motion graphics clip first (the AI panel's Motion Graphics tile adds one)");
  return clip;
}

/** What is said under a clip and around it, its words timed from the clip's start. */
function saidUnder(clip: Clip, ctx: ActionContext): Said {
  const [from, to] = timelineSpan(clip.id, ctx.project, ctx.registry) ?? [ticksToSeconds(clip.start), ticksToSeconds(clipEnd(clip))];
  const words = heardWords(ctx);
  const text = (ws: typeof words) => ws.map((w) => w.text).join(" ");
  return {
    words: words.filter((w) => w.end > from && w.start < to).map((w) => ({ text: w.text, start: Math.max(0, w.start - from), end: Math.min(to, w.end) - from })),
    before: text(words.filter((w) => w.end <= from && w.start >= from - CONTEXT)),
    after: text(words.filter((w) => w.start >= to && w.end <= to + CONTEXT)),
  };
}

/** Where the clip is and how long, so an answer that arrives after it moved or was trimmed isn't put in the wrong place. */
function shapeOf(id: string, ctx: Pick<ActionContext, "project" | "registry">) {
  try {
    const at = findClip(ctx.project, ctx.registry, id);
    return JSON.stringify([at.clip.start + at.offset, at.clip.duration]);
  } catch {
    return undefined;
  }
}

const key = (env: { secret: (id: string) => Promise<string | undefined> }) => async () => (await env.secret(OPENAI)) ?? fail("no OpenAI API key: add one in Settings › AI, or choose Apple as the planner");

const add = defineAction({
  id: "motion.add",
  description:
    "Add a motion graphics placeholder clip (the AI panel's Motion Graphics tile): over the in/out range if one is set, else at `time` (default the playhead) for `duration` seconds, on a Motion graphics track above the talk, its box the whole canvas, with an optional typed `prompt` (Manual). It shows nothing in an export until it is made: move and trim it, size its box on the canvas, then motion.write writes its prompt from the words under it and motion.make composes it",
  args: z.strictObject({ time: z.number().nonnegative().optional(), duration: z.number().positive().optional(), prompt: z.string().max(1000).optional() }),
  resolve: ({ time, duration, prompt }, ctx) => {
    if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to add motion graphics");
    const range = time === undefined && duration === undefined ? ctx.session.range : null;
    const from = range ? range.in : (time ?? ctx.session.playhead);
    const length = range ? range.out - range.in : (duration ?? PLACEHOLDER_SECONDS);
    const { width, height } = ctx.project.settings;
    const props = {
      motion: { prompt: "", why: "", source: prompt ? "manual" : "auto", manual: prompt ?? "", takes: [], shown: -1, look: lookOf(String(ctx.pref("motionLook"))).id, background: "none" } satisfies MotionProps,
      group: { width, height, tracks: [] },
    };
    const above = trackIndex(ctx.project, ctx.registry, from, from + length);
    const free = ctx.project.tracks.find((t, i) => i >= above && t.name === TRACK && !t.locked && t.clips.every((c) => ticksToSeconds(clipEnd(c)) <= from || ticksToSeconds(c.start) >= from + length));
    const steps: ActionStep[] = free
      ? [{ command: "clip.place", args: { type: "motion", props, duration: length, time: from, track: free.id } }]
      : [
          { command: "track.add", args: { name: TRACK, index: above } },
          { command: "clip.place", args: (r: unknown[]) => ({ type: "motion", props, duration: length, time: from, track: r[0] }) },
        ];
    return {
      label: "Add Motion Graphics",
      steps,
      after: (r) => [{ command: "selection.set", args: { clips: [r.at(-1) as string], linked: false } }, { command: "inspector.tab", args: { tab: "motion" } }, ...(range ? [{ command: "range.clear" }] : [])],
    };
  },
});

const write = defineAction({
  id: "motion.write",
  description:
    "Write a motion graphics clip's Auto prompt (`clip`, else the selected one) from what is said under it: one sentence saying what it shows, with its exact words, by the planner chosen in Settings › AI (Apple's on-device model by default, or OpenAI). Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const clip = target(ctx, id);
    const state = motionState(ctx.session);
    if (state.writing.includes(clip.id) || state.making.includes(clip.id)) throw new Error("that clip is being written or made already");
    const said = saidUnder(clip, ctx);
    if (!said.words.length) throw new Error("nothing is said under the clip yet: wait for the transcript, move the clip over speech, or type a prompt (Manual)");
    const planner = String(ctx.pref("brollPlanner"));
    const shape = shapeOf(clip.id, ctx);
    return {
      label: "Write Motion Graphics Prompt",
      before: [{ command: "motion.status", args: { clips: [clip.id], writing: true } }],
      task: {
        label: "Write Motion Graphics Prompt",
        run: async (env) => {
          env.progress(0.1, planner === "openai" ? "OpenAI is writing the prompt" : "Apple's on-device model is writing the prompt");
          const idea = await writeIdea(said, planner, key(env));
          env.progress(1, "Prompt written");
          return (now) => {
            const was = shapeOf(clip.id, now);
            if (!was) throw new Error("the motion graphics clip was deleted while its prompt was written");
            if (was !== shape) throw new Error("the motion graphics clip was moved or trimmed while its prompt was written: write it again");
            return {
              label: "Write Motion Graphics Prompt",
              steps: [{ command: "clip.set", args: { clip: clip.id, props: { motion: { prompt: idea.prompt, why: idea.why, source: "auto" } } } }],
              after: () => [{ command: "motion.status", args: { clips: [clip.id], writing: false } }],
            };
          };
        },
        failed: (error) => [{ command: "motion.status", args: { clips: [clip.id], writing: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

const make = defineAction({
  id: "motion.make",
  description:
    "Make a motion graphics clip (`clip`, else the selected one) from its prompt (Auto's or Manual's; still empty, the words said under it): the planner composes it from titles, lower thirds, numbers, lists and text (OpenAI mixes and times several, in parts of the box; Apple's on-device model picks one), and it is built in the clip's box as a new take, one undo step. Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const clip = target(ctx, id);
    const m = motionOf(clip)!;
    const state = motionState(ctx.session);
    if (state.writing.includes(clip.id) || state.making.includes(clip.id)) throw new Error("that clip is being written or made already");
    const said = saidUnder(clip, ctx);
    const prompt = (m.source === "auto" ? m.prompt : m.manual).trim() || said.words.map((w) => w.text).join(" ");
    if (!prompt) throw new Error("the clip has no prompt and nothing is said under it: type a prompt (Manual)");
    const planner = String(ctx.pref("brollPlanner"));
    const box = clip.props.group as Box;
    const t = { scaleX: 1, scaleY: 1, ...(clip.props.transform as Partial<Record<"scaleX" | "scaleY", number>> | undefined) };
    const request = { prompt, said, length: ticksToSeconds(clip.duration), width: box.width * Math.abs(t.scaleX), height: box.height * Math.abs(t.scaleY) };
    const shape = shapeOf(clip.id, ctx);
    return {
      label: "Make Motion Graphics",
      before: [{ command: "motion.status", args: { clips: [clip.id], making: true } }],
      task: {
        label: "Make Motion Graphics",
        run: async (env) => {
          env.progress(0.1, planner === "openai" ? "OpenAI is composing the graphic" : "Apple's on-device model is picking the graphic");
          const pieces = await compose(request, planner, key(env));
          env.progress(1, "Made");
          return (now) => {
            const was = shapeOf(clip.id, now);
            if (!was) throw new Error("the motion graphics clip was deleted while it was made");
            if (was !== shape) throw new Error("the motion graphics clip was moved or trimmed while it was made: make it again");
            return {
              label: "Make Motion Graphics",
              steps: [{ command: "motion.use", args: { clip: clip.id, prompt, pieces } }],
              after: () => [{ command: "motion.status", args: { clips: [clip.id], making: false } }],
            };
          };
        },
        failed: (error) => [{ command: "motion.status", args: { clips: [clip.id], making: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

/** v2: a Look and a background on every clip, as made before there were Looks. */
function withLooks(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const m = o.props?.motion as Record<string, unknown> | undefined;
    if (!m) return;
    m.look ??= DEFAULT_LOOK;
    m.background ??= "none";
  });
  return doc;
}

/**
 * Motion graphics: placeholder clips over the talk, made from a prompt (typed, or written from the words under them)
 * by the planner into titles, lower thirds, numbers, lists and text built from callouts and animation blocks. A clip
 * keeps its prompt and every take, and opens like a group to edit a word.
 */
export const motion = defineFeature({
  id: "motion",
  version: 2,
  migrations: [{ version: 2, migrate: withLooks }],
  clipTypes: [{ id: "motion", description: "Motion graphics: a placeholder (nothing in an export until made), then text, shapes and animations built from a prompt, opened like a group", traits: ["visual", "group", "motion"] }],
  props: [
    {
      id: "motion",
      description: "What a motion graphics clip is made from: Auto's prompt (and why) as motion.write wrote it, or the one typed (`manual`), which one (`source`), and the takes made (each its prompt and pieces), `shown` the one in the clip",
      traits: ["motion"],
      tab: { title: "Motion Graphics", icon: "sparkle", order: 2 },
      schema: motionGroup,
      defaults: () => ({ prompt: "", why: "", source: "auto", manual: "", takes: [], shown: -1, look: DEFAULT_LOOK, background: "none" }),
      identity: true,
    },
  ],
  commands,
  sessionCommands,
  preferences: [
    {
      id: "motionLook",
      title: "Motion graphics Look",
      description: "The Look a new motion graphic takes; picking one on a clip makes it the one new ones take",
      options: LOOKS.map((l) => ({ id: l.id, title: l.name, description: l.description })),
      default: DEFAULT_LOOK,
    },
  ],
  actions: [add, write, make],
  queries: [
    defineQuery({
      id: "motion.looks",
      description: "The Looks a motion graphic can take (its `motion.look`): each one's id, name, fonts, colours, shadow and motion",
      args: z.strictObject({}),
      run: () => LOOKS,
    }),
    defineQuery({
      id: "motion.kinds",
      description: "What a motion graphic is made from (the pieces motion.make composes and motion.use takes): each kind and the fields it uses",
      args: z.strictObject({}),
      run: () => KINDS.map((k) => ({ kind: k, uses: KIND_GUIDE[k] })),
    }),
  ],
  evaluate: {
    clip(e, ctx) {
      if (e.clip.type === "motion" && e.props.group) drawNested(e, e.props.group as Box, ctx);
    },
  },
});

