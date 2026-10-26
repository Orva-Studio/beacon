import { z } from "zod";
import { textLayout } from "@beacon/media";
import { clipEnd, defineAction, defineCommand, defineFeature, defineQuery, secondsToTicks, ticksToSeconds, type ActionStep, type Clip, type CommandContext, type Project, type TextSpec, type Track } from "@beacon/model";
import { trackIndex } from "../broll";
import { blockOf, BLOCKS, type BlockEnv, type Part } from "./blocks";

export { BLOCKS, type BlockDef } from "./blocks";

const TRACK = "Motion graphics";

/** The Text annotation's look, so a block's words look like text added by hand. */
function textLook(ctx: CommandContext): BlockEnv["text"] {
  const preset = ctx.registry.annotations.get("text");
  const callout = preset?.props.callout as { text: TextSpec } | undefined;
  if (!callout) throw new Error("the Text annotation is missing");
  const { width: _w, height: _h, scale: _s, ...spec } = callout.text;
  return { spec, effects: (preset!.effects ?? []).map((fx) => ({ type: fx.type, params: fx.params ?? {} })) };
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

const fill = defineCommand({
  id: "motion.fill",
  description: "Build a motion graphics block (`motion.blocks` lists them) inside an empty group clip on the main timeline, filling its fields; how motion.add makes one",
  args: z.strictObject({ clip: z.string().min(1), block: z.string().min(1), fields: z.record(z.string(), z.unknown()) }),
  apply(doc: Project, { clip, block, fields }, ctx) {
    const def = blockOf(block);
    const g = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clip);
    if (!g || g.type !== "group") throw new Error(`"${clip}" is not a group on the main timeline`);
    const group = g.props.group as { width: number; height: number; tracks: Track[] };
    if (group.tracks.length) throw new Error("the group isn't empty");
    const parsed = def.fields.safeParse(fields);
    if (!parsed.success) throw new Error(`${def.title}: ${z.prettifyError(parsed.error)}`);
    const env: BlockEnv = { width: group.width, height: group.height, length: ticksToSeconds(g.duration), text: textLook(ctx), layout: textLayout };
    group.tracks = def.build(parsed.data, env).map((parts) => ({
      id: ctx.newId("track"),
      name: parts.map((p) => (p.props.callout as { text?: { text: string } } | undefined)?.text?.text ?? "").join(" ").trim(),
      clips: parts.map((p) => toClip(p, ctx)),
    }));
    return clip;
  },
});

const add = defineAction({
  id: "motion.add",
  description:
    "Add a motion graphics block (`motion.blocks` lists them with their fields): over the in/out range if one is set, else at `time` (default the playhead) for `duration` seconds (default the block's), on a Motion graphics track above the talk. It is a plain group of text and shape clips with animations, edited afterwards like any group; one undo step",
  args: z.strictObject({
    block: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
    time: z.number().nonnegative().optional(),
    duration: z.number().positive().optional(),
  }),
  resolve: ({ block, fields, time, duration }, ctx) => {
    if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to add motion graphics");
    const def = blockOf(block);
    const parsed = def.fields.safeParse(fields);
    if (!parsed.success) throw new Error(`${def.title}: ${z.prettifyError(parsed.error)}`);
    const range = time === undefined && duration === undefined ? ctx.session.range : null;
    const from = range ? range.in : (time ?? ctx.session.playhead);
    const length = range ? range.out - range.in : (duration ?? def.seconds);
    const { width, height } = ctx.project.settings;
    const props = { group: { width, height, tracks: [] } };
    const above = trackIndex(ctx.project, ctx.registry, from, from + length);
    const free = ctx.project.tracks.find(
      (t, i) => i >= above && t.name === TRACK && !t.locked && t.clips.every((c) => ticksToSeconds(clipEnd(c)) <= from || ticksToSeconds(c.start) >= from + length),
    );
    const steps: ActionStep[] = free
      ? [{ command: "clip.place", args: { type: "group", props, duration: length, time: from, track: free.id } }]
      : [
          { command: "track.add", args: { name: TRACK, index: above } },
          { command: "clip.place", args: (r: unknown[]) => ({ type: "group", props, duration: length, time: from, track: r[0] }) },
        ];
    steps.push({ command: "motion.fill", args: (r: unknown[]) => ({ clip: r.at(-1), block, fields: parsed.data }) });
    return {
      label: `Add ${def.title}`,
      steps,
      after: (r) => [{ command: "selection.set", args: { clips: [r.at(-1) as string], linked: false } }, ...(range ? [{ command: "range.clear" }] : [])],
    };
  },
});

/** Motion graphics: blocks from a catalog (Title…) built from callouts and animation blocks, placed as a plain group. */
export const motion = defineFeature({
  id: "motion",
  version: 1,
  commands: [fill],
  actions: [add],
  queries: [
    defineQuery({
      id: "motion.blocks",
      description: "The motion graphics blocks motion.add makes: each one's id, what it is, its fields (as JSON Schema) and how long it lasts by default",
      args: z.strictObject({}),
      run: () => BLOCKS.map((b) => ({ id: b.id, title: b.title, description: b.description, seconds: b.seconds, fields: z.toJSONSchema(b.fields) })),
    }),
  ],
});
