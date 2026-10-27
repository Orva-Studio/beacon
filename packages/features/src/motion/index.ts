import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { renderHtml } from "@beacon/media";
import {
  clipEnd,
  defineAction,
  defineCommand,
  defineFeature,
  defineQuery,
  eachRawClip,
  findClip,
  secondsToTicks,
  ticksToSeconds,
  type ActionContext,
  type ActionPlan,
  type ActionStep,
  type Asset,
  type Clip,
  type CommandContext,
  type Project,
  type RGBA,
  type Session,
  type SessionCommandDef,
  type TaskEnv,
  type TextSpec,
} from "@beacon/model";
import { streamOf } from "../media";
import { heardWords, regionOfClip, timelineSpan, trackIndex } from "../broll";
import { CustomStylesSchema, styleFromFile, type CustomStyle } from "../broll/styles";
import { KIND_GUIDE, KINDS, PieceSchema, tidy } from "./blocks";
import { compose, revise, writeIdea, type Said } from "./compose";
import { css, page, template } from "./html";
import { DEFAULT_LOOK, lookOf, LOOKS } from "./looks";

export { KINDS, KIND_GUIDE, type Piece } from "./blocks";
export { LOOKS, type Look } from "./looks";
export { CONTRACT as MOTION_CONTRACT, page as motionPage } from "./html";

const TRACK = "Motion graphics";
const OPENAI = "openai-api-key";
const ANTHROPIC = "anthropic-api-key";
const FIRECRAWL = "firecrawl-api-key";
/** Who writes it, as the user reads it. */
const WHO: Record<string, string> = { openai: "OpenAI", claude: "Claude", apple: "Apple's on-device model" };
/** Who writes motion graphics: its own choice, in Settings › AI, apart from B-roll's planner. */
const PLANNER = "motionPlanner";
/** A placeholder added at the playhead lasts this long. */
const PLACEHOLDER_SECONDS = 4;
/** Seconds of talk either side of a clip Write reads for context. */
const CONTEXT = 10;
/** Frames per second motion graphics are drawn at, whatever the project's: smooth, and quick to draw. */
const FPS = 30;

const motionGroup = z.strictObject({
  /** Auto's prompt, as Write wrote it from the words under the clip, and why. */
  prompt: z.string().max(1000),
  why: z.string(),
  /** Which prompt it is made from: Auto's (`prompt`) or the one typed (`manual`). */
  source: z.enum(["auto", "manual"]),
  manual: z.string().max(1000),
  /** Its design (a Look's id), and whether words come in as they are said or all at once. */
  look: z.string(),
  timing: z.enum(["speech", "together"]),
  /** An image (an asset) whose design Make recreates and animates. */
  reference: z.string().optional(),
  /** One of the user's skills (`motion.skills`) Make and Revise follow: its look and rules. */
  skill: z.string().optional(),
  /** Every composition made (the inside of its page's body) and its drawing, an earlier one picked again; `shown` is the one in the clip. */
  takes: z.array(z.strictObject({ prompt: z.string(), html: z.string(), assetId: z.string().optional(), cost: z.number().nonnegative().optional(), by: z.string().optional() })),
  shown: z.number().int().min(-1),
});
export type MotionProps = z.infer<typeof motionGroup>;

/** An empty placeholder's box (`props.motionBox`): its size on the canvas until it is drawn, then gone. */
const boxGroup = z.strictObject({ width: z.number().positive(), height: z.number().positive() });

/** What motion graphics are doing for which clips (`session.features.motion`): prompts written, graphics made, and why the last try failed. */
export interface MotionState {
  writing: string[];
  making: string[];
  errors: Record<string, string>;
}
const IDLE: MotionState = { writing: [], making: [], errors: {} };
export const motionState = (s: Session) => (s.features.motion as MotionState | undefined) ?? IDLE;
export const motionOf = (c: Clip) => c.props.motion as MotionProps | undefined;


const fail = (message: string): never => {
  throw new Error(message);
};

/** The Text annotation's font: a Look's when it names none. */
function textFont(ctx: Pick<CommandContext, "registry">): string {
  const callout = ctx.registry.annotations.get("text")?.props.callout as { text: TextSpec } | undefined;
  return callout?.text.font ?? "Helvetica Neue";
}

/** Every motion graphics clip in the project, inside groups too. */
function motionClips(doc: Project): Clip[] {
  const out: Clip[] = [];
  eachRawClip(doc, (o) => {
    if ((o as Clip).type === "motion") out.push(o as Clip);
  });
  return out;
}

const commands = [
  defineCommand({
    id: "motion.use",
    description:
      "Show a drawing of a motion graphics clip's composition in it: `asset` (a drawing motion.make or motion.render made) with `html`, `prompt`, who wrote it (`by`: openai, claude, apple) and what it cost in dollars (`cost`) (a new take), or with `take` (that take drawn again); or `take` alone, an earlier take picked again. It plays from the clip's start at the size it was drawn, where the clip is; with `keep` (a drawing up to the clip's end in the composition's time) from where the clip's start was trimmed to",
    args: z.strictObject({ clip: z.string().min(1), asset: z.string().min(1).optional(), take: z.int().nonnegative().optional(), html: z.string().optional(), prompt: z.string().optional(), cost: z.number().nonnegative().optional(), by: z.string().optional(), keep: z.boolean().default(false) }),
    apply(doc, { clip, asset, take, html, prompt, cost, by, keep }, ctx) {
      const { clip: c, track } = findClip(doc, ctx.registry, clip);
      const m = motionOf(c);
      if (c.type !== "motion" || !m) throw new Error(`clip "${clip}" isn't a motion graphic`);
      if (track.locked) throw new Error(`track "${track.name}" is locked`);
      if (html !== undefined) {
        if (!asset) throw new Error("a new take needs its drawing (`asset`)");
        m.takes.push({ prompt: prompt ?? "", html, assetId: asset, ...(cost ? { cost } : {}), ...(by ? { by } : {}) });
        m.shown = m.takes.length - 1;
      } else if (take !== undefined) {
        const t = m.takes[take] ?? fail(`the clip has no take ${take}`);
        if (asset) t.assetId = asset;
        if (!t.assetId || !doc.assets[t.assetId]) throw new Error(`take ${take} has no drawing: draw it again (motion.render)`);
        m.shown = take;
      } else throw new Error("give `html` (a new take) or `take`");
      const id = m.takes[m.shown]!.assetId!;
      const a = doc.assets[id] ?? fail(`no asset "${id}"`);
      const s = streamOf(a, "video", 0);
      // Drawn at the size it shows: no scale, so text stays sharp; a flip stays a flip.
      const t = c.props.transform as { x: number; y: number; scaleX: number; scaleY: number; rotation?: number } | undefined;
      // An uneven crop had the visible part off the clip's centre: the clip moves there, so the drawing shows where it did.
      const crop = { left: 0, top: 0, right: 0, bottom: 0, ...(c.props.crop as Partial<Record<"left" | "top" | "right" | "bottom", number>> | undefined) };
      const [dx, dy] = [((crop.left - crop.right) / 2) * (t?.scaleX ?? 1), ((crop.top - crop.bottom) / 2) * (t?.scaleY ?? 1)];
      if (dx || dy) {
        const moved = (c.props.transform ??= { ...ctx.registry.propGroups.get("transform")!.defaults() }) as NonNullable<typeof t>;
        const [cos, sin] = [Math.cos(moved.rotation ?? 0), Math.sin(moved.rotation ?? 0)];
        moved.x += cos * dx + sin * dy;
        moved.y -= -sin * dx + cos * dy;
      }
      const shown = c.props.transform as typeof t;
      if (shown) Object.assign(shown, { scaleX: Math.sign(shown.scaleX) || 1, scaleY: Math.sign(shown.scaleY) || 1 });
      delete c.props.crop;
      delete c.props.motionBox;
      c.props.media = { stream: 0 };
      c.assetId = id;
      if (!keep) c.mediaStart = 0;
      delete c.speed;
      c.duration = Math.max(1, Math.min(c.duration, secondsToTicks(s.duration) - (c.mediaStart ?? 0)));
    },
  }),
  defineCommand({
    id: "motion.reference",
    description: "Give a motion graphics clip a reference image (`asset`, an image asset) whose design motion.make recreates in HTML and animates, or take it away (`asset: null`); motion.refer adds the image from a file",
    args: z.strictObject({ clip: z.string().min(1), asset: z.string().min(1).nullable() }),
    apply(doc, { clip, asset }, ctx) {
      const { clip: c } = findClip(doc, ctx.registry, clip);
      const m = motionOf(c);
      if (c.type !== "motion" || !m) throw new Error(`clip "${clip}" isn't a motion graphic`);
      if (asset === null) delete m.reference;
      else {
        if (doc.assets[asset]?.kind !== "image") throw new Error(`asset "${asset}" isn't an image`);
        m.reference = asset;
      }
    },
  }),
  defineCommand({
    id: "motion.style",
    description:
      "Change motion graphics clips' Look (`look`, a motion.looks id), `timing` (speech: each word as it is said; together: all at once) or `skill` (a motion.skills id the next Make and Revise follow, one not there read as none; null: none): `clips`, else every motion graphic in the project. Their drawings change once motion.render draws them again; a skill only changes what is made next",
    args: z.strictObject({ clips: z.array(z.string().min(1)).optional(), look: z.string().min(1).optional(), timing: z.enum(["speech", "together"]).optional(), skill: z.string().min(1).nullable().optional() }),
    apply(doc, { clips, look, timing, skill }, ctx) {
      if (look && !LOOKS.some((l) => l.id === look)) throw new Error(`no Look "${look}"; there are: ${LOOKS.map((l) => l.id).join(", ")}`);
      const chosen = clips ? clips.map((id) => findClip(doc, ctx.registry, id).clip) : motionClips(doc);
      for (const c of chosen) {
        const m = motionOf(c);
        if (c.type !== "motion" || !m) throw new Error(`clip "${c.id}" isn't a motion graphic`);
        if (look) m.look = look;
        if (timing) m.timing = timing;
        if (skill === null) delete m.skill;
        else if (skill) m.skill = skill;
      }
      return chosen.map((c) => c.id);
    },
  }),
];

const sessionCommands: SessionCommandDef[] = [
  {
    id: "motion.status",
    description: "Mark motion graphics clips as having their prompt written or being made, or not (motion.write, motion.make and motion.render do), with why the last try failed (`error`, null to clear)",
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

/** The motion graphics clips an action works on: those given, else the selected ones. */
function targets(ctx: ActionContext, ids?: string[]): Clip[] {
  const all = ctx.scope.tracks.flatMap((t) => t.clips);
  const chosen = ids ? [...new Set(ids)].map((id) => all.find((c) => c.id === id) ?? fail(`no clip "${id}" on the timeline`)) : all.filter((c) => ctx.session.selection.includes(c.id));
  const motion = chosen.filter((c) => c.type === "motion");
  if (!motion.length) throw new Error(ids ? "those clips aren't motion graphics" : "select a motion graphics clip first (the AI panel's Motion Graphics tile adds one)");
  return motion;
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

const key = (env: { secret: (id: string) => Promise<string | undefined> }, planner: string) => async () =>
  planner === "claude"
    ? ((await env.secret(ANTHROPIC)) ?? fail("no Anthropic API key: add one in Settings › AI, or choose another maker in Settings › AI"))
    : ((await env.secret(OPENAI)) ?? fail("no OpenAI API key: add one in Settings › AI, or choose another maker in Settings › AI"));

/** What drawing a clip needs, read from it when the action starts: its box (as it shows now), length and Look. */
/**
 * How a clip's composition is drawn now. `keep`: a composition already made for it (drawn again, revised, edited)
 * is drawn up to the clip's end in its own time, so a clip trimmed at its start keeps playing from where it was cut.
 */
function drawing(clip: Clip, ctx: Pick<ActionContext, "project" | "registry">, keep: boolean) {
  const m = motionOf(clip)!;
  const [, , w, h] = regionOfClip(clip, ctx.project, ctx.registry);
  // Even, as the encoder wants.
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(w), height: even(h), length: ticksToSeconds((keep ? (clip.mediaStart ?? 0) : 0) + clip.duration), look: lookOf(m.look), timing: m.timing, fallbackFont: textFont(ctx), keep };
}

/** A composition drawn into the project's media/Motion graphics folder, its page kept beside it, as `asset.add` takes it. */
async function draw(env: TaskEnv, html: string, d: ReturnType<typeof drawing>, name: string, progress: (f: number) => void): Promise<Omit<Asset, "id">> {
  const dir = join(env.mediaDir, "Motion graphics");
  mkdirSync(dir, { recursive: true });
  const stem = name.replace(/[^\p{L}\p{N} ]+/gu, " ").trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 40).trim() || "Motion graphic";
  // Taken by creating it, so two drawings at once never pick the same name.
  let out = join(dir, `${stem}.mov`);
  for (let n = 2; ; n++) {
    try {
      writeFileSync(out, "", { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      out = join(dir, `${stem} ${n}.mov`);
    }
  }
  const doc = page(html, d);
  writeFileSync(out.replace(/\.mov$/, ".html"), doc);
  await renderHtml({ html: doc, width: d.width, height: d.height, fps: FPS, seconds: d.length, out, progress });
  const asset = await env.asset(out, "video");
  return { ...asset, name: `Motion graphic: ${name.slice(0, 60)}` };
}

const add = defineAction({
  id: "motion.add",
  description:
    "Add a motion graphics placeholder clip (the AI panel's Motion Graphics tile): over the in/out range if one is set, else at `time` (default the playhead) for `duration` seconds, on a Motion graphics track above the talk, its box the whole canvas, with an optional typed `prompt` (Manual). It shows nothing in an export until it is made: move and trim it, size its box on the canvas, then motion.write writes its prompt from the words under it and motion.make makes it",
  args: z.strictObject({ time: z.number().nonnegative().optional(), duration: z.number().positive().optional(), prompt: z.string().max(1000).optional() }),
  resolve: ({ time, duration, prompt }, ctx) => {
    if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to add motion graphics");
    const range = time === undefined && duration === undefined ? ctx.session.range : null;
    const from = range ? range.in : (time ?? ctx.session.playhead);
    const length = range ? range.out - range.in : (duration ?? PLACEHOLDER_SECONDS);
    const { width, height } = ctx.project.settings;
    const props = {
      motion: {
        prompt: "",
        why: "",
        source: prompt ? "manual" : "auto",
        manual: prompt ?? "",
        look: lookOf(String(ctx.pref("motionLook"))).id,
        ...(skills(ctx.pref).some((k) => k.id === lastSkill(ctx.pref)) ? { skill: lastSkill(ctx.pref) } : {}),
        timing: "speech",
        takes: [],
        shown: -1,
      } satisfies MotionProps,
      motionBox: { width, height },
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

/** Images OpenAI takes as a reference. */
const REFERENCE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

const refer = defineAction({
  id: "motion.refer",
  description:
    "Give a motion graphics clip (`clip`, else the selected one) a reference image from a file (`path`: PNG, JPEG, WebP or GIF), copied into the project's media/Motion graphics/References folder, whose design motion.make recreates in HTML and animates (OpenAI or Claude); `path: null` takes it away. One undo step",
  args: z.strictObject({ clip: z.string().min(1).optional(), path: z.string().min(1).nullable() }),
  resolve: ({ clip: id, path }, ctx) => {
    const clip = targets(ctx, id ? [id] : undefined)[0]!;
    if (path === null) return { label: "Remove Reference Image", steps: [{ command: "motion.reference", args: { clip: clip.id, asset: null } }] };
    if (!REFERENCE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) throw new Error(`a reference image is a ${REFERENCE_EXTENSIONS.join(", ")} file`);
    return {
      label: "Reference Image",
      task: {
        label: "Add Reference Image",
        run: async (env) => {
          const dir = join(env.mediaDir, "Motion graphics", "References");
          mkdirSync(dir, { recursive: true });
          const stem = basename(path, extname(path));
          let copy = join(dir, basename(path));
          // Taken by creating it, as a drawing's name is: never over another reference.
          for (let n = 2; ; n++) {
            try {
              writeFileSync(copy, "", { flag: "wx" });
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
              copy = join(dir, `${stem} ${n}${extname(path)}`);
            }
          }
          copyFileSync(path, copy);
          const asset = await env.asset(copy, "image");
          return () => ({
            label: "Reference Image",
            steps: [
              { command: "asset.add", args: asset },
              { command: "motion.reference", args: (r: unknown[]) => ({ clip: clip.id, asset: r[0] }) },
            ],
          });
        },
      },
    };
  },
});

const write = defineAction({
  id: "motion.write",
  description:
    "Write a motion graphics clip's Auto prompt (`clip`, else the selected one) from what is said under it: one sentence saying what it shows, with its exact words, by the model chosen in Settings › AI (preference motionPlanner: OpenAI by default, Claude or Apple's on-device model). Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const clip = targets(ctx, id ? [id] : undefined)[0]!;
    const state = motionState(ctx.session);
    if (state.writing.includes(clip.id) || state.making.includes(clip.id)) throw new Error("that clip is being written or made already");
    const said = saidUnder(clip, ctx);
    if (!said.words.length) throw new Error("nothing is said under the clip yet: wait for the transcript, move the clip over speech, or type a prompt (Manual)");
    const planner = String(ctx.pref(PLANNER));
    const ids = [clip.id];
    return {
      label: "Write Motion Graphics Prompt",
      before: [{ command: "motion.status", args: { clips: ids, writing: true } }],
      task: {
        label: "Write Motion Graphics Prompt",
        run: async (env) => {
          env.progress(0.1, `${WHO[planner] ?? planner} is writing the prompt`);
          const idea = await writeIdea(said, planner, key(env, planner));
          env.progress(1, "Prompt written");
          return (now) => {
            try {
              findClip(now.project, now.registry, clip.id);
            } catch {
              throw new Error("the motion graphics clip was deleted while its prompt was written");
            }
            return {
              label: "Write Motion Graphics Prompt",
              steps: [{ command: "clip.set", args: { clip: clip.id, props: { motion: { prompt: idea.prompt, why: idea.why, source: "auto" } } } }],
              after: () => [{ command: "motion.status", args: { clips: ids, writing: false } }],
            };
          };
        },
        failed: (error) => [{ command: "motion.status", args: { clips: ids, writing: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

type Drawn = { clip: string; asset: Omit<Asset, "id">; html: string; name: string; d: ReturnType<typeof drawing> } & ({ cost: number; by: string } | { take: number });

/**
 * The end of a make or a render: each drawing added to the Media Bin and shown in its clip, one undo step. A clip
 * resized, trimmed or restyled while it was made is drawn again to fit first (no AI, so what the AI wrote is kept).
 */
function shown(label: string, clips: string[], made: Drawn[]) {
  return (now: ActionContext): ActionPlan => {
    const steps: ActionStep[] = [];
    const again: Drawn[] = [];
    for (const m of made) {
      let clip: Clip;
      try {
        clip = findClip(now.project, now.registry, m.clip).clip;
      } catch {
        throw new Error("the motion graphics clip was deleted while it was made");
      }
      const d = drawing(clip, now, m.d.keep);
      if (page(m.html, d) !== page(m.html, m.d)) {
        again.push({ ...m, d });
        continue;
      }
      const added = steps.length;
      steps.push({ command: "asset.add", args: m.asset });
      steps.push({ command: "motion.use", args: (r: unknown[]) => ({ clip: m.clip, asset: r[added], keep: m.d.keep, ...("take" in m ? { take: m.take } : { html: m.html, prompt: m.name, cost: m.cost, by: m.by }) }) });
    }
    const redrawn = again.map((m) => m.clip);
    const done = clips.filter((c) => !redrawn.includes(c));
    return {
      label,
      steps,
      after: () => (done.length ? [{ command: "motion.status", args: { clips: done, making: false } }] : []),
      ...(again.length
        ? {
            task: {
              label: "Draw Motion Graphics to Fit",
              run: async (env: TaskEnv) => {
                const fit: Drawn[] = [];
                for (const [k, m] of again.entries()) {
                  const asset = await draw(env, m.html, m.d, m.name, (f) => env.progress((k + f) / again.length, "The clip changed while it was made: drawing it again to fit"));
                  fit.push({ ...m, asset });
                }
                return shown(label, redrawn, fit);
              },
              failed: (error: string) => [{ command: "motion.status", args: { clips: redrawn, making: false, ...(error === "cancelled" ? {} : { error }) } }],
            },
          }
        : {}),
    };
  };
}

const SKILLS = "motionSkills";
/** The skill new motion graphics take: the one last picked. */
const SKILL = "motionSkill";
/** A skill is a page or two of text; a file far larger isn't one. */
const MAX_SKILL_BYTES = 1 << 20;

/** The user's motion graphics skills, as Settings › AI keeps them (unreadable: none). */
function skills(pref: ActionContext["pref"]): CustomStyle[] {
  try {
    return CustomStylesSchema.parse(JSON.parse(String(pref(SKILLS) || "[]")));
  } catch {
    return [];
  }
}

const lastSkill = (pref: ActionContext["pref"]): string => {
  try {
    return String(JSON.parse(String(pref(SKILL))));
  } catch {
    return "";
  }
};

/** A clip's skill, as the author is given it; one deleted since it was picked is none. */
const skillOf = (m: MotionProps, pref: ActionContext["pref"]) => (m.skill ? skills(pref).find((k) => k.id === m.skill) : undefined);

/** A skill file's text (a `.md` skill, a `.txt`): only a regular file, not a pipe or a device, which would block. */
function readSkillFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${basename(path)} isn't a skill: not a file`);
    if (st.size > MAX_SKILL_BYTES) throw new Error(`${basename(path)} isn't a skill: ${Math.round(st.size / 1e6)} MB`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const make = defineAction({
  id: "motion.make",
  description:
    "Make a motion graphics clip (`clip`, else the selected one) from its prompt (Auto's or Manual's; still empty, the words said under it): the model chosen in Settings › AI writes it as an HTML composition, the clip's Look its default design, timed to the words said (OpenAI or Claude designs it; Apple's on-device model picks a title, lower third, number, list or text for a template), with a background of its own unless the prompt asks for alpha (transparent, no background), and WebKit draws it at the size of the clip's box, with its transparency, into the project's media/Motion graphics folder; shown in the clip as a new take with who made it (`by`) and what it was charged (`cost`, dollars), one undo step. Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional() }),
  resolve: ({ clip: id }, ctx) => {
    const clip = targets(ctx, id ? [id] : undefined)[0]!;
    const m = motionOf(clip)!;
    const state = motionState(ctx.session);
    if (state.writing.includes(clip.id) || state.making.includes(clip.id)) throw new Error("that clip is being written or made already");
    const said = saidUnder(clip, ctx);
    const prompt = (m.source === "auto" ? m.prompt : m.manual).trim() || said.words.map((w) => w.text).join(" ");
    if (!prompt) throw new Error("the clip has no prompt and nothing is said under it: type a prompt (Manual)");
    const planner = String(ctx.pref(PLANNER));
    const reference = m.reference ? ctx.project.assets[m.reference]?.path : undefined;
    if (reference && planner === "apple") throw new Error("a reference image needs OpenAI or Claude to make it: choose one in Settings › AI, or remove the image");
    const d = drawing(clip, ctx, false);
    const skill = skillOf(m, ctx.pref);
    const ids = [clip.id];
    return {
      label: "Make Motion Graphics",
      before: [{ command: "motion.status", args: { clips: ids, making: true } }],
      task: {
        label: "Make Motion Graphics",
        run: async (env) => {
          env.progress(0.05, planner === "apple" ? "Apple's on-device model is picking the graphic" : `${WHO[planner] ?? planner} is designing the graphic`);
          const meter = { cost: 0 };
          const web = { key: await env.secret(FIRECRAWL), progress: (stage: string) => env.progress(0.15, stage) };
          const html = await compose({ prompt, said, width: d.width, height: d.height, length: d.length, look: d.look, ...(reference ? { reference } : {}), ...(skill ? { skill } : {}) }, planner, key(env, planner), meter, web);
          env.progress(0.3, "Drawing it");
          const asset = await draw(env, html, d, prompt, (f) => env.progress(0.3 + f * 0.65, "Drawing it"));
          env.progress(1, "Made");
          return shown("Make Motion Graphics", ids, [{ clip: clip.id, asset, html, name: prompt, d, cost: meter.cost, by: planner }]);
        },
        failed: (error) => [{ command: "motion.status", args: { clips: ids, making: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

/** The take a clip shows, to change: refused while it is busy or before it is made. */
function shownTake(clip: Clip, ctx: ActionContext) {
  notBusy(clip, ctx);
  const m = motionOf(clip)!;
  return m.takes[m.shown] ?? fail("make the motion graphic first");
}

function notBusy(clip: Clip, ctx: ActionContext) {
  const busy = motionState(ctx.session);
  if (busy.writing.includes(clip.id) || busy.making.includes(clip.id)) throw new Error("that clip is being written or made already");
}

const reviseAction = defineAction({
  id: "motion.revise",
  description:
    "Change a made motion graphic (`clip`, else the selected one) as `note` asks (\"make the logo bigger\", \"slower\"), the rest kept: the model chosen in Settings › AI (OpenAI or Claude, not Apple's) is given the take it shows and rewrites it, then it is drawn as a new take with who made it and its cost, one undo step. Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional(), note: z.string().trim().min(1) }),
  resolve: ({ clip: id, note }, ctx) => {
    const clip = targets(ctx, id ? [id] : undefined)[0]!;
    const take = shownTake(clip, ctx);
    const planner = String(ctx.pref(PLANNER));
    if (planner === "apple") throw new Error("Revise needs OpenAI or Claude: choose one in Settings › AI (Apple's model only fills templates)");
    const m = motionOf(clip)!;
    const brief = (m.source === "auto" ? m.prompt : m.manual).trim() || take.prompt;
    const said = saidUnder(clip, ctx);
    const d = drawing(clip, ctx, true);
    const skill = skillOf(m, ctx.pref);
    const ids = [clip.id];
    return {
      label: "Revise Motion Graphics",
      before: [{ command: "motion.status", args: { clips: ids, making: true } }],
      task: {
        label: "Revise Motion Graphics",
        run: async (env) => {
          env.progress(0.05, `${WHO[planner] ?? planner} is revising the graphic`);
          const meter = { cost: 0 };
          const web = { key: await env.secret(FIRECRAWL), progress: (stage: string) => env.progress(0.15, stage) };
          const html = await revise({ prompt: brief, said, width: d.width, height: d.height, length: d.length, look: d.look, ...(skill ? { skill } : {}) }, take.html, note, planner, key(env, planner), meter, web);
          env.progress(0.3, "Drawing it");
          const name = `Revised: ${note}`;
          const asset = await draw(env, html, d, name, (f) => env.progress(0.3 + f * 0.65, "Drawing it"));
          env.progress(1, "Revised");
          return shown("Revise Motion Graphics", ids, [{ clip: clip.id, asset, html, name, d, cost: meter.cost, by: planner }]);
        },
        failed: (error) => [{ command: "motion.status", args: { clips: ids, making: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

const code = defineAction({
  id: "motion.code",
  description:
    "Draw a motion graphic (`clip`, else the selected one) from `html` written by hand (the inside of its page's <body>, as the take it shows has it: motion.page gives the whole page) as a new take made by \"you\", no AI and no cost, one undo step; a clip not made yet gets it as its first take, named from its prompt. Runs as a job",
  args: z.strictObject({ clip: z.string().min(1).optional(), html: z.string().trim().min(1) }),
  resolve: ({ clip: id, html }, ctx) => {
    const clip = targets(ctx, id ? [id] : undefined)[0]!;
    notBusy(clip, ctx);
    const m = motionOf(clip)!;
    const brief = m.takes[m.shown]?.prompt ?? (m.source === "auto" ? m.prompt : m.manual).trim();
    const d = drawing(clip, ctx, true);
    const ids = [clip.id];
    const name = brief.startsWith("Edited: ") ? brief : brief ? `Edited: ${brief}` : "Edited";
    return {
      label: "Edit Motion Graphics Code",
      before: [{ command: "motion.status", args: { clips: ids, making: true } }],
      task: {
        label: "Draw Motion Graphics",
        run: async (env) => {
          const asset = await draw(env, html, d, name, (f) => env.progress(f * 0.95, "Drawing it"));
          env.progress(1, "Drawn");
          return shown("Edit Motion Graphics Code", ids, [{ clip: clip.id, asset, html, name, d, cost: 0, by: "you" }]);
        },
        failed: (error) => [{ command: "motion.status", args: { clips: ids, making: false, ...(error === "cancelled" ? {} : { error }) } }],
      },
    };
  },
});

const render = defineAction({
  id: "motion.render",
  description:
    "Draw motion graphics clips (`clips`, else the selected ones) again from the take each shows, with no AI: in their Look and timing as they are now, at their box's size and length now (after motion.style, a resize or a trim). A clip whose drawing would come out the same (a Look or timing its composition doesn't use) is left as it is. Runs as a job",
  args: z.strictObject({ clips: z.array(z.string().min(1)).optional() }),
  resolve: ({ clips: ids }, ctx) => {
    const clips = targets(ctx, ids).filter((c) => motionOf(c)!.shown >= 0);
    if (!clips.length) throw new Error("nothing to draw again: make the motion graphic first");
    const busy = motionState(ctx.session);
    if (clips.some((c) => busy.writing.includes(c.id) || busy.making.includes(c.id))) throw new Error("that clip is being written or made already");
    const jobs = clips.flatMap((c) => {
      const m = motionOf(c)!;
      const job = { clip: c.id, take: m.shown, html: m.takes[m.shown]!.html, prompt: m.takes[m.shown]!.prompt, d: drawing(c, ctx, true) };
      // Drawn from this very page already (a Look or timing the composition doesn't use): nothing would change.
      const drawn = c.assetId ? ctx.project.assets[c.assetId]?.path.replace(/\.mov$/, ".html") : undefined;
      return drawn && existsSync(drawn) && readFileSync(drawn, "utf8") === page(job.html, job.d) ? [] : [job];
    });
    if (!jobs.length) return { label: "Draw Motion Graphics", steps: [] };
    const all = jobs.map((j) => j.clip);
    return {
      label: "Draw Motion Graphics",
      before: [{ command: "motion.status", args: { clips: all, making: true } }],
      task: {
        label: jobs.length === 1 ? "Draw Motion Graphics" : `Draw ${jobs.length} Motion Graphics`,
        run: async (env) => {
          const made: Drawn[] = [];
          for (const [k, j] of jobs.entries()) {
            const asset = await draw(env, j.html, j.d, j.prompt, (f) => env.progress((k + f) / jobs.length, `Drawing ${k + 1} of ${jobs.length}`));
            made.push({ clip: j.clip, asset, take: j.take, html: j.html, name: j.prompt, d: j.d });
          }
          env.progress(1, "Drawn");
          return shown("Draw Motion Graphics", all, made);
        },
        failed: (error) => [{ command: "motion.status", args: { clips: all, making: false, ...(error === "cancelled" ? {} : { error }) } }],
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
 * v3: drawn from HTML rather than built from callouts. Each take's pieces become a template's composition, the clip a
 * placeholder its box's size again (draw it again, motion.render, to see it), its background a backdrop.
 */
function toHtml(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const m = o.props?.motion as Record<string, unknown> | undefined;
    if (!m) return;
    const group = o.props!.group as { width: number; height: number } | undefined;
    const box = { width: group?.width ?? 1920, height: group?.height ?? 1080 };
    m.takes = ((m.takes as { prompt: string; pieces: unknown[] }[] | undefined) ?? []).map((t) => ({
      prompt: t.prompt,
      html: t.pieces
        .flatMap((p) => {
          const parsed = PieceSchema.safeParse(p);
          const piece = parsed.success ? tidy(parsed.data, 3600) : undefined;
          return piece ? [template(piece, [], box)] : [];
        })
        .join("\n"),
    }));
    const was = m.background;
    m.backdrop = was === "dim" ? { kind: "full", color: [0, 0, 0, 0.5] } : was === "card" ? { kind: "card", color: [0.05, 0.05, 0.06, 0.78] } : { kind: "none", color: [0, 0, 0, 0.6] };
    delete m.background;
    m.timing = "speech";
    delete o.props!.group;
    o.props!.motionBox = box;
  });
  return doc;
}

/**
 * v4: the background is the composition's own (the brief picks it), not a setting: a backdrop becomes the first thing in
 * each take's HTML, drawn as the page drew it (a card inset 5% of the box's shorter side).
 */
function backdropInHtml(doc: unknown): unknown {
  eachRawClip(doc, (o) => {
    const m = o.props?.motion as Record<string, unknown> | undefined;
    if (!m) return;
    const b = m.backdrop as { kind: string; color: RGBA } | undefined;
    if (b && b.kind !== "none") {
      const box = b.kind === "card" ? "inset: min(5vw, 5vh); border-radius: min(3vw, 3vh);" : "inset: 0;";
      const div = `<div style="position: absolute; ${box} background: ${css(b.color)}; animation: fade 0.3s ease-out both;"></div>\n`;
      for (const t of (m.takes as { html: string }[] | undefined) ?? []) t.html = div + t.html;
    }
    delete m.backdrop;
  });
  return doc;
}

/**
 * Motion graphics: placeholder clips over the talk, made from a prompt (typed, or written from the words under them)
 * into an HTML composition in a Look, timed to the speech, drawn by WebKit with its transparency. A clip keeps its
 * prompt and every take, and is drawn again when its Look, timing, size or length change.
 */
export const motion = defineFeature({
  id: "motion",
  version: 4,
  migrations: [
    { version: 2, migrate: withLooks },
    { version: 3, migrate: toHtml },
    { version: 4, migrate: backdropInHtml },
  ],
  clipTypes: [{ id: "motion", description: "Motion graphics: a placeholder (nothing in an export until made), then a composition drawn with its transparency from a prompt", traits: ["visual", "picture", "media", "video", "motion"] }],
  props: [
    {
      id: "motion",
      description:
        "What a motion graphics clip is made from: Auto's prompt (and why) as motion.write wrote it, or the one typed (`manual`), which one (`source`), its Look and timing, and the takes made (each its prompt, HTML and drawing), `shown` the one in the clip",
      traits: ["motion"],
      tab: { title: "Motion Graphics", icon: "sparkle", order: 2 },
      schema: motionGroup,
      defaults: () => ({ prompt: "", why: "", source: "auto", manual: "", look: DEFAULT_LOOK, timing: "speech", takes: [], shown: -1 }),
      identity: true,
    },
    {
      id: "motionBox",
      description: "An empty motion graphics placeholder's box, in canvas pixels before its transform; gone once it is drawn",
      traits: ["motion"],
      schema: boxGroup,
      defaults: () => ({ width: 1920, height: 1080 }),
      size: (box: { width: number; height: number }) => [box.width, box.height],
      identity: true,
    },
  ],
  commands,
  sessionCommands,
  actions: [add, refer, write, make, reviseAction, code, render],
  secrets: [
    { id: ANTHROPIC, title: "Anthropic API key" },
    { id: FIRECRAWL, title: "Firecrawl API key" },
  ],
  preferences: [
    {
      id: PLANNER,
      title: "Motion graphics made by",
      description: "Who writes motion graphics (Make) and their Auto prompts: OpenAI (the default), Claude or Apple's model; picked in Settings › AI",
      options: [
        { id: "apple", title: "Apple, on this Mac", description: "Apple's on-device model fills a template (a title, lower third, number, list or text): free, offline, no key, but plain" },
        { id: "openai", title: "OpenAI", description: "gpt-6.1-sol with your OpenAI API key designs each graphic in HTML (3D, maps, any style, a reference image), about $0.10–0.20 a Make on your account", secret: OPENAI, online: true },
        { id: "claude", title: "Claude", description: "Claude Opus 5.5 with your Anthropic API key designs each graphic in HTML (3D, maps, any style, a reference image), about $0.20–0.35 a Make on your account", secret: ANTHROPIC, online: true },
      ],
      default: "openai",
    },
    {
      id: "motionLook",
      title: "Motion graphics Look",
      description: "The Look a new motion graphic takes; picking one on a clip makes it the one new ones take",
      options: LOOKS.map((l) => ({ id: l.id, title: l.name, description: l.description })),
      default: DEFAULT_LOOK,
    },
    {
      id: SKILLS,
      title: "Motion graphics skills",
      description: "Your own motion graphics skills, for every project: each a name and its text (a skill's .md, or typed), whose look and rules Make and Revise follow",
      options: [],
      schema: CustomStylesSchema,
      default: "[]",
    },
    {
      id: SKILL,
      title: "Motion graphics skill",
      description: "The skill a new motion graphic takes (an id of motionSkills as a JSON string, \"\" for none); picking one on a clip makes it the one new ones take",
      options: [],
      schema: z.string().max(200),
      default: '""',
    },
  ],
  queries: [
    defineQuery({
      id: "motion.looks",
      description: "The Looks a motion graphic can take (its `motion.look`): each one's id, name, fonts, colours, shadow and motion",
      args: z.strictObject({}),
      run: () => LOOKS,
    }),
    defineQuery({
      id: "motion.skills",
      description: "The user's motion graphics skills (Settings › AI › Motion Graphics, kept for every project): each one's id, name and text; a clip picks one with motion.style `skill`",
      args: z.strictObject({}),
      run: (_, { pref }) => skills(pref),
    }),
    defineQuery({
      id: "motion.readSkill",
      description: "A skill read from a text file (`path`: a skill's SKILL.md, a .md or .txt): its name (the front matter's `name`, its first heading, else the file's name) and its text without the front matter, to add to motionSkills",
      args: z.strictObject({ path: z.string().min(1) }),
      run: ({ path }) => {
        const read = styleFromFile(basename(path) === "SKILL.md" ? basename(join(path, "..")) : basename(path), readSkillFile(path));
        if (!read.text) throw new Error(`${basename(path)} is empty`);
        return read;
      },
    }),
    defineQuery({
      id: "motion.page",
      description: "The whole page a motion graphic (`clip`) is drawn from, as WebKit gets it: the take it shows, or `html` (the inside of <body>) in its place, wrapped in its Look, runtime and libraries at its box's size and length; `window.__seek(t)` sets it to a time. For previewing an edit before motion.code",
      args: z.strictObject({ clip: z.string().min(1), html: z.string().optional() }),
      run: ({ clip: id, html }, ctx) => {
        const { clip } = findClip(ctx.project, ctx.registry, id);
        const m = motionOf(clip) ?? fail(`clip "${id}" isn't a motion graphic`);
        const d = drawing(clip, ctx, true);
        const body = html ?? m.takes[m.shown]?.html ?? fail("make the motion graphic first");
        return { page: page(body, d), width: d.width, height: d.height, length: d.length };
      },
    }),
    defineQuery({
      id: "motion.kinds",
      description: "The kinds of graphic Apple's on-device model picks from for a template (OpenAI designs freely): each kind and what it shows",
      args: z.strictObject({}),
      run: () => KINDS.map((k) => ({ kind: k, uses: KIND_GUIDE[k] })),
    }),
  ],
});
