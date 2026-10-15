import { z } from "zod";
import {
  animatedValue,
  clipEnd,
  copyClips,
  defineAction,
  editedValue,
  mediaTimeAt,
  projectDuration,
  secondsToTicks,
  ticksToSeconds,
  type ActionContext,
  type ActionPlan,
  type ActionStep,
  type Clip,
  walkClips,
} from "@beacon/model";
import { visualSize } from "../media";

const none = z.strictObject({});

/** The selected clips that still exist, on the timeline or in the opened group. */
function selected({ scope, session }: ActionContext): Clip[] {
  return scope.tracks.flatMap((t) => t.clips.filter((c) => session.selection.includes(c.id)));
}

/**
 * The clips a panel item dropped on `clip` applies to (a drag onto
 * media): every selected clip when it is one of them, else that clip alone;
 * without `clip`, the selection.
 */
export function dropTargets(ctx: ActionContext, clip?: string): Clip[] {
  if (!clip) return selected(ctx);
  if (ctx.session.selection.includes(clip)) return selected(ctx);
  const c = ctx.scope.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
  if (!c) throw new Error(`no clip "${clip}"${ctx.scope.group ? " in the open group" : " on the timeline"}`);
  return [c];
}

/** After a drop on an unselected clip, it becomes the selection, so its properties show what was added. */
export const selectDropped = (ctx: ActionContext, clip?: string): ActionStep[] =>
  clip && !ctx.session.selection.includes(clip) ? [{ command: "selection.set", args: { clips: [clip], linked: false } }] : [];

const playhead = (ctx: ActionContext) => ctx.session.playhead;

function mainTimelineOnly(ctx: ActionContext, what: string) {
  if (ctx.scope.group) throw new Error(`close the group (⌃⇧U) to ${what}`);
}

const seconds = (t: number) => ticksToSeconds(t);

/**
 * Delete, Cut and their ripple forms:
 * the selected clips, else the in/out range across unlocked tracks. A ripple
 * moves the playhead to where the removed part began.
 */
function remove(ctx: ActionContext, { ripple, copy, label }: { ripple: boolean; copy: boolean; label: string }): ActionPlan {
  // Selected effect bars are what Delete and Cut remove.
  if (!ripple && ctx.session.effects.length) {
    const many = ctx.session.effects.length > 1;
    return {
      label: `${copy ? "Cut" : "Delete"} ${many ? "Effects" : "Effect"}`,
      before: copy ? [{ command: "effects.copy" }] : [],
      steps: ctx.session.effects.map((e) => ({ command: "effect.remove", args: { clip: e.clip, effect: e.id } })),
    };
  }
  // A selected animation arrow is what Delete removes.
  if (!ripple && !copy && ctx.session.animation) {
    const { clip, id } = ctx.session.animation;
    return { label: "Delete Animation", steps: [{ command: "animation.remove", args: { clip, animation: id } }] };
  }
  const clips = selected(ctx);
  const range = ctx.session.range;
  // Removing an empty range still closes it; there is just nothing to copy.
  const what = clips.length ? { clips: clips.map((c) => c.id) } : range ? { range: [secondsToTicks(range.in), secondsToTicks(range.out)] as [number, number] } : {};
  // `clipboard.copy` reads an opened group's clips at main-timeline times; check against the same.
  const shown = { ...ctx.project, tracks: ctx.scope.tracks };
  const before: ActionStep[] = copy && copyClips(shown, what, (c) => ctx.registry.hasTrait(c.type, "hold")) ? [{ command: "clipboard.copy" }] : [];
  if (clips.length) {
    const from = seconds(Math.min(...clips.map((c) => c.start)));
    return {
      label,
      before,
      steps: [{ command: "clip.remove", args: { clips: clips.map((c) => c.id), linked: false, ripple } }],
      after: () => (ripple ? [{ command: "playhead.set", args: { time: from } }] : []),
    };
  }
  if (!range) throw new Error("select media or set an in/out range first");
  mainTimelineOnly(ctx, "delete a time range");
  return {
    label,
    before,
    steps: [{ command: ripple ? "timeline.rippleDelete" : "timeline.deleteRanges", args: { ranges: [{ start: range.in, end: range.out }] } }],
    // The range stays after a Delete, showing the gap it left; a ripple closes it.
    after: () => (ripple ? [{ command: "range.clear" }, { command: "playhead.set", args: { time: range.in } }] : []),
  };
}

const white = [1, 1, 1, 1];
const region = (kind: string, intensity: number, title: string) => ({
  type: "region",
  title,
  props: { region: { kind, width: 640, height: 360, cornerRadius: 6, intensity, invert: false } },
});
/**
 * The Annotations panel's items, with the settings the user's
 * projects use most: white Suisse Intl
 * text with a drop shadow, a black rounded rectangle, spotlight, blur and pixelate.
 */
const ANNOTATIONS: Record<string, { type: string; title: string; props: Record<string, unknown>; effects?: { type: string; params: Record<string, unknown> }[] }> = {
  text: {
    type: "callout",
    title: "Add Text",
    effects: [{ type: "drop-shadow", params: {} }],
    props: { callout: { shape: "text", width: 900, height: 200, cornerRadius: 8, text: { text: "Text", font: "Suisse Intl", weight: 500, italic: false, size: 96, color: white, tracking: 0, lineSpacing: 0, align: "center", valign: "center" } } },
  },
  rectangle: { type: "callout", title: "Add Rectangle", props: { callout: { shape: "rectangle", width: 640, height: 360, cornerRadius: 8, fill: [0, 0, 0, 1] } } },
  spotlight: region("spotlight", 0.5, "Add Spotlight"),
  blur: region("blur", 2, "Add Blur"),
  pixelate: region("pixelate", 0.33, "Add Pixelate"),
};

const placed = { duration: z.number().positive().default(5), time: z.number().nonnegative().optional(), track: z.string().min(1).optional() };

const selectPasted = (results: unknown[]): ActionStep[] => [{ command: "selection.set", args: { clips: results[0] as string[], linked: false } }];

/** The editing commands as the editor runs them: on the selection, the range and the playhead. */
export const actions = [
  defineAction({
    id: "edit.delete",
    description: "Delete the selected clips, leaving gaps; with nothing selected, the in/out range from every unlocked track (⌫)",
    args: none,
    resolve: (_, ctx) => remove(ctx, { ripple: false, copy: false, label: "Delete" }),
  }),
  defineAction({
    id: "edit.rippleDelete",
    description:
      "Delete the selected clips (or the in/out range) and close the gap: later clips on their tracks move left together; copies them too (⌘⌫)",
    args: none,
    resolve: (_, ctx) => remove(ctx, { ripple: true, copy: true, label: "Ripple Delete" }),
  }),
  defineAction({
    id: "edit.cut",
    description: "Copy the selected clips (or the in/out range) and delete them, leaving a gap (⌘X)",
    args: none,
    resolve: (_, ctx) => remove(ctx, { ripple: false, copy: true, label: "Cut" }),
  }),
  defineAction({
    id: "edit.rippleCut",
    description: "Copy the selected clips (or the in/out range), delete them and close the gap (⇧⌘X)",
    args: none,
    resolve: (_, ctx) => remove(ctx, { ripple: true, copy: true, label: "Ripple Cut" }),
  }),
  defineAction({
    id: "edit.copy",
    description: "Copy the selected effects, else the selected clips, or with nothing selected what the in/out range covers (⌘C)",
    args: none,
    resolve: (_, ctx) => ({ label: "Copy", before: [{ command: ctx.session.effects.length ? "effects.copy" : ctx.session.animation ? "animation.copy" : "clipboard.copy" }] }),
  }),
  defineAction({
    id: "edit.paste",
    description:
      "Paste the copied clips at the playhead, onto the tracks they came from if free there, else the lowest free tracks, and select them. With other clips selected, the copied clips' effects go onto them instead, as do copied effects (⌘V)",
    args: none,
    resolve: (_, ctx) => {
      const { session } = ctx;
      const copied = session.properties;
      // A copied arrow goes onto each selected clip: from the playhead when it is over the clip, else where it sat in its own.
      if (!session.clipboard && copied?.animations?.length) {
        const clips = selected(ctx);
        if (!clips.length) throw new Error("select the clips to paste the animation onto");
        const steps = clips.flatMap((c) =>
          copied.animations!.map((a) => {
            const [cs, ce] = [seconds(c.start), seconds(clipEnd(c))];
            const at = session.playhead >= cs && session.playhead < ce ? session.playhead : cs + a.offset;
            const start = at < ce ? at : cs;
            return { command: "animation.add", args: { clip: c.id, end: Math.min(ce, start + a.duration), duration: Math.min(a.duration, ce - start), easing: a.easing, to: a.to } };
          }),
        );
        return { label: "Paste Animation", steps };
      }
      if (!session.clipboard && copied && !Object.keys(copied.props).length && copied.effects.length) {
        const clips = selected(ctx);
        if (!clips.length) throw new Error("select the clips to paste the effects onto");
        return { label: copied.effects.length > 1 ? "Paste Effects" : "Paste Effect", steps: [{ command: "clip.pasteProperties", args: { clips: clips.map((c) => c.id), props: {}, effects: copied.effects } }] };
      }
      // The user's rule: a copied clip pasted onto other selected clips gives them its effects; with nothing else selected it pastes the clip.
      if (session.clipboard) {
        // Neither the copied clips nor pasted copies of them (selected after ⌘V, so ⌘V ⌘V pastes twice).
        const same = (a: Clip, b: Clip) => a.id === b.id || (a.type === b.type && a.assetId === b.assetId && a.mediaStart === b.mediaStart && a.duration === b.duration);
        const onto = selected(ctx).filter((c) => !session.clipboard!.items.some((i) => same(i.clip, c)));
        if (onto.length) {
          const effects = session.clipboard.items.flatMap((i) => i.clip.effects);
          if (!effects.length) throw new Error("the copied clip has no effects to paste onto the selection; press Escape and ⌘V to paste the clip itself");
          return { label: effects.length > 1 ? "Paste Effects" : "Paste Effect", steps: [{ command: "clip.pasteProperties", args: { clips: onto.map((c) => c.id), props: {}, effects } }] };
        }
      }
      mainTimelineOnly(ctx, "paste");
      if (!session.clipboard) throw new Error("nothing has been copied");
      return { label: "Paste", steps: [{ command: "clip.paste", args: { clipboard: session.clipboard, at: session.playhead } }], after: selectPasted };
    },
  }),
  defineAction({
    id: "edit.duplicate",
    description: "Duplicate the selected clips right after them, on free tracks, without touching the clipboard (⌘D)",
    args: none,
    resolve: (_, ctx) => {
      mainTimelineOnly(ctx, "duplicate");
      const clips = selected(ctx);
      if (!clips.length) throw new Error("select media first");
      const board = copyClips(ctx.project, { clips: clips.map((c) => c.id) }, (c) => ctx.registry.hasTrait(c.type, "hold"))!;
      const at = seconds(Math.max(...clips.map(clipEnd)));
      return { label: "Duplicate", steps: [{ command: "clip.paste", args: { clipboard: board, at } }], after: selectPasted };
    },
  }),
  defineAction({
    id: "edit.split",
    description: "Split the selected clips at the playhead, or every clip under it when nothing is selected (⌘T)",
    args: none,
    resolve: (_, ctx) => {
      const clips = selected(ctx);
      const at = playhead(ctx);
      // Inside a group, "every clip" means the group's.
      const all = ctx.scope.group ? ctx.scope.tracks.filter((t) => !t.locked).flatMap((t) => t.clips) : undefined;
      const which = clips.length ? clips : all;
      return { label: "Split", steps: [{ command: "clip.split", args: which ? { at, clips: which.map((c) => c.id), linked: false } : { at } }] };
    },
  }),
  defineAction({
    id: "edit.splitAll",
    description: "Split every clip on unlocked tracks at the playhead (⇧⌘T)",
    args: none,
    resolve: (_, ctx) =>
      ctx.scope.group
        ? { label: "Split All", steps: [{ command: "clip.split", args: { at: playhead(ctx), clips: ctx.scope.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.map((c) => c.id)), linked: false } }] }
        : { label: "Split All", steps: [{ command: "clip.split", args: { at: ctx.session.playhead } }] },
  }),
  defineAction({
    id: "edit.trimToPlayhead",
    description: "Trim the start or end of the selected clips under the playhead (or every clip under it, if none is selected) to the playhead (Edit > Playhead > Trim Start/End to Playhead)",
    args: z.strictObject({ edge: z.enum(["start", "end"]) }),
    resolve: ({ edge }, ctx) => {
      const at = secondsToTicks(playhead(ctx));
      const pool = selected(ctx).length ? selected(ctx) : ctx.scope.tracks.filter((t) => !t.locked).flatMap((t) => t.clips);
      const under = pool.filter((c) => c.start < at && clipEnd(c) > at);
      if (!under.length) throw new Error("no media under the playhead");
      return {
        label: edge === "start" ? "Trim Start to Playhead" : "Trim End to Playhead",
        steps: under.map((c) => ({ command: "clip.trim", args: { clip: c.id, [edge]: playhead(ctx), linked: false } })),
      };
    },
  }),
  defineAction({
    id: "edit.addMedia",
    description:
      "Put media from the Media Bin on the timeline (Add to Timeline at Playhead, Add to End of Timeline, or a drag from the bin): at `time` (default the playhead), or after the last clip with `end`, on `track` when dropped on one, and select it",
    args: z.strictObject({ asset: z.string().min(1), time: z.number().nonnegative().optional(), end: z.boolean().optional(), track: z.string().min(1).optional() }),
    resolve: ({ asset, time, end, track }, ctx) => {
      mainTimelineOnly(ctx, "add media");
      const at = end ? ticksToSeconds(projectDuration(ctx.project)) : (time ?? ctx.session.playhead);
      return {
        label: "Add Media",
        steps: [{ command: "asset.place", args: { asset, time: at, ...(track ? { track } : {}) } }],
        after: (results) => [{ command: "selection.set", args: { clips: results[0] as string[], linked: false } }],
      };
    },
  }),
  defineAction({
    id: "edit.addAnnotation",
    description:
      "Add an annotation for `duration` seconds (default 5) at `time` (default the playhead) on the lowest free track, or on `track` when dropped on one, and select it: a `preset` from the Annotations panel (text, rectangle, spotlight, blur, pixelate), or a callout or region clip given by `type`, `props` and `effects`",
    args: z.union([
      z.strictObject({ preset: z.enum(Object.keys(ANNOTATIONS) as [keyof typeof ANNOTATIONS]), ...placed }),
      z.strictObject({
        type: z.string().min(1),
        props: z.record(z.string(), z.unknown()),
        effects: z.array(z.strictObject({ type: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) })).default([]),
        title: z.string().default("Add Annotation").describe("Undo history label"),
        ...placed,
      }),
    ]),
    resolve: (args, ctx) => {
      mainTimelineOnly(ctx, "add an annotation");
      const { type, props, effects = [], title } = "preset" in args ? ANNOTATIONS[args.preset]! : args;
      const { duration, time, track } = args;
      return {
        label: title,
        steps: [{ command: "clip.place", args: { type, props, effects, duration, time: time ?? ctx.session.playhead, ...(track ? { track } : {}) } }],
        after: (results) => [{ command: "selection.set", args: { clips: [results[0] as string], linked: false } }],
      };
    },
  }),
  defineAction({
    id: "edit.deleteMedia",
    description: "Delete media from the Media Bin, with every clip that uses it; several items at once are one undo step",
    args: z.strictObject({ asset: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
    resolve: ({ asset }, ctx) => {
      const assets = new Set(typeof asset === "string" ? [asset] : asset);
      for (const a of assets) if (!ctx.project.assets[a]) throw new Error(`no asset "${a}"`);
      const gone = (l: { clip: Clip }) => assets.has(l.clip.assetId!);
      // A group or stitched clip made only of this media goes as a whole, rather than staying behind empty.
      const uses = (c: Clip) => {
        const inner = [...walkClips([{ id: "", name: "", clips: [c] }], ctx.registry)].filter((l) => l.clip.assetId);
        return { any: inner.some(gone), all: inner.length > 0 && inner.every(gone), inner };
      };
      const clips = ctx.project.tracks.flatMap((t) =>
        t.clips.flatMap((c) => {
          const u = uses(c);
          return u.all ? [c.id] : u.any ? u.inner.filter(gone).map((l) => l.clip.id) : [];
        }),
      );
      return {
        label: "Delete Media",
        before: clips.length ? [{ command: "selection.set", args: { clips: ctx.session.selection.filter((c) => !clips.includes(c)) } }] : [],
        steps: [...(clips.length ? [{ command: "clip.remove", args: { clips, linked: false } }] : []), ...[...assets].map((a) => ({ command: "asset.remove", args: { asset: a } }))],
      };
    },
  }),
  defineAction({
    id: "edit.selectMedia",
    description: "Select the clips that use a Media Bin item (Select on Timeline)",
    args: z.strictObject({ asset: z.string().min(1) }),
    resolve: ({ asset }, ctx) => {
      const clips = ctx.scope.tracks.flatMap((t) => t.clips.filter((c) => c.assetId === asset)).map((c) => c.id);
      if (!clips.length) throw new Error("this media isn't on the timeline");
      return { label: "Select on Timeline", before: [{ command: "selection.set", args: { clips, linked: false } }] };
    },
  }),
  defineAction({
    id: "edit.addMarker",
    description: "Add a timeline marker at the playhead (⇧M)",
    args: none,
    resolve: (_, ctx) => {
      mainTimelineOnly(ctx, "add a marker");
      return { label: "Add Marker", steps: [{ command: "marker.add", args: { time: ctx.session.playhead, name: "" } }] };
    },
  }),
  defineAction({
    id: "edit.copyProperties",
    description: "Copy the selected clip's properties and effects (⇧⌘C)",
    args: none,
    resolve: () => ({ label: "Copy Properties", before: [{ command: "properties.copy" }] }),
  }),
  defineAction({
    id: "edit.pasteProperties",
    description: "Apply the copied properties and effects to the selected clips (⇧⌘V)",
    args: none,
    resolve: (_, ctx) => {
      const copied = ctx.session.properties;
      if (!copied) throw new Error("no properties have been copied");
      const clips = selected(ctx);
      if (!clips.length) throw new Error("select media first");
      return { label: "Paste Properties", steps: [{ command: "clip.pasteProperties", args: { clips: clips.map((c) => c.id), ...copied } }] };
    },
  }),
  defineAction({
    id: "edit.addEffect",
    description:
      "Add an effect (by id, as the Visual Effects and Cursor Effects panels list them) to every selected clip it applies to; with `clip`, as dropping it on that clip: to it, or to the whole selection when it is selected",
    args: z.strictObject({ type: z.string().min(1), clip: z.string().min(1).optional() }),
    resolve: ({ type, clip }, ctx) => {
      const def = ctx.registry.effect(type);
      const clips = dropTargets(ctx, clip).filter((c) => def.traits.some((t) => ctx.registry.hasTrait(c.type, t)));
      if (!clips.length) throw new Error(clip ? `"${type}" doesn't apply to that media` : `select media that "${type}" applies to first`);
      return { label: `Add ${type}`, steps: clips.map((c) => ({ command: "effect.add", args: { clip: c.id, type } })), after: () => selectDropped(ctx, clip) };
    },
  }),
  defineAction({
    id: "edit.nudge",
    description: "Move the selected visual clips on the canvas by canvas pixels, at the playhead (arrow keys: 1 pixel, with Shift 10); `y` is up",
    args: z.strictObject({ x: z.number().default(0), y: z.number().default(0) }),
    resolve: ({ x, y }, ctx) => {
      const clips = selected(ctx).filter((c) => ctx.registry.hasTrait(c.type, "visual"));
      if (!clips.length) throw new Error("select visual media first");
      return {
        label: "Nudge",
        steps: clips.map((c) => {
          const now = (f: string) => Number(stored(ctx, c, "transform", f, 0));
          return { command: "clip.set", args: { clip: c.id, at: playhead(ctx), props: { transform: { x: now("x") + x, y: now("y") + y } } } };
        }),
      };
    },
  }),
  defineAction({
    id: "edit.scale",
    description:
      "Scale the selected visual clips at the playhead: to fit the canvas or fill it, centred (Scale to Fit ⌥⌘F, Scale to Fill ⇧F), or to a percent of their size in place (Pan and Scale to 25/50/100/200%, ⌃⌘1-4)",
    args: z.strictObject({ to: z.union([z.enum(["fit", "fill"]), z.number().positive()]) }),
    resolve: ({ to }, ctx) => {
      const { width: W, height: H } = ctx.project.settings;
      const steps: ActionStep[] = [];
      for (const c of selected(ctx)) {
        if (!ctx.registry.hasTrait(c.type, "visual")) continue;
        if (typeof to === "number") {
          steps.push({ command: "clip.set", args: { clip: c.id, at: playhead(ctx), props: { transform: { scaleX: to / 100, scaleY: to / 100 } } } });
          continue;
        }
        const size = visualSize(ctx.project, c);
        if (!size) continue;
        const crop = (f: string) => Number(at(ctx, c, "crop", f, 0));
        const w = size[0] - crop("left") - crop("right");
        const h = size[1] - crop("top") - crop("bottom");
        const k = (to === "fit" ? Math.min : Math.max)(W / w, H / h);
        // Centre what is shown, which sits off the content's centre when the crop is uneven.
        const x = (-(crop("left") - crop("right")) / 2) * k;
        const y = ((crop("top") - crop("bottom")) / 2) * k;
        steps.push({ command: "clip.set", args: { clip: c.id, at: playhead(ctx), props: { transform: { scaleX: k, scaleY: k, x, y } } } });
      }
      if (!steps.length) throw new Error("select visual media first");
      return { label: to === "fit" ? "Scale to Fit" : to === "fill" ? "Scale to Fill" : `Scale to ${to}%`, steps };
    },
  }),
];

/** Animatable visual fields an added animation block carries, so editing at its end changes them. */
const ANIMATED: Record<string, Record<string, number>> = {
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

export const animationActions = [
  defineAction({
    id: "edit.addAnimation",
    description:
      "Add an animation block (an arrow on the clip) to the selected visual clips, from the playhead over `duration` seconds, ease in/out, and move the playhead to its end: then property and canvas edits there set where it animates to (Custom, ⇧A). `preset` \"restore\" animates back to the clip's base values instead. With `clip` and `time` (timeline seconds), as dropping it on that clip there: on it (or the whole selection when it is selected), starting at `time`, moved earlier if needed to fit in the clip",
    args: z.strictObject({
      duration: z.number().positive().default(1),
      preset: z.enum(["custom", "restore"]).default("custom"),
      clip: z.string().min(1).optional(),
      time: z.number().nonnegative().optional(),
    }),
    resolve: ({ duration, preset, clip, time }, ctx) => {
      const clips = dropTargets(ctx, clip).filter((c) => ctx.registry.hasTrait(c.type, "visual"));
      if (!clips.length) throw new Error(clip ? "animations apply to visual media" : "select visual media first");
      const target = clip ? clips.find((c) => c.id === clip) : undefined;
      const from = time ?? playhead(ctx);
      const start = target ? Math.max(ticksToSeconds(target.start), Math.min(from, ticksToSeconds(clipEnd(target)) - duration)) : from;
      const steps: ActionStep[] = [];
      let end = start + duration;
      let last = "";
      for (const c of clips) {
        // Only clips the playhead (or the drop) is on: a block outside a clip's window would never show.
        if (start < ticksToSeconds(c.start)) continue;
        const e = Math.min(start + duration, ticksToSeconds(clipEnd(c)));
        if (e <= start) continue;
        end = e;
        const to: Record<string, number> = {};
        for (const [group, fields] of Object.entries(ANIMATED)) {
          for (const [field, base] of Object.entries(fields)) {
            const own = (c.props[group] as Record<string, number> | undefined)?.[field] ?? base;
            to[`${group}.${field}`] = preset === "restore" ? own : Number(at(ctx, c, group, field, base));
          }
        }
        steps.push({ command: "animation.add", args: { clip: c.id, end: e, duration: e - start, easing: "easeInOut", to } });
        last = c.id;
      }
      if (!steps.length) throw new Error("the playhead isn't on the selected media, or is at its end");
      return {
        label: preset === "restore" ? "Add Restore Animation" : "Add Animation",
        steps,
        after: (results) => [
          ...selectDropped(ctx, clip),
          { command: "playhead.set", args: { time: end } },
          { command: "animation.select", args: { clip: last, animation: results.at(-1) as string } },
        ],
      };
    },
  }),
];

/** The value an edit at the playhead changes: mid-animation, the block's end value rather than the one shown. */
function stored(ctx: ActionContext, clip: Clip, group: string, field: string, fallback: unknown): unknown {
  const t = Math.min(Math.max(secondsToTicks(playhead(ctx)), clip.start), clipEnd(clip));
  return editedValue(clip, group, field, mediaTimeAt(clip, t), fallback);
}

/** A property's value at the playhead, through the clip's animations. */
function at(ctx: ActionContext, clip: Clip, group: string, field: string, fallback: unknown): unknown {
  const t = Math.min(Math.max(secondsToTicks(playhead(ctx)), clip.start), clipEnd(clip));
  return animatedValue((clip.props[group] as Record<string, unknown> | undefined)?.[field] ?? fallback, `${group}.${field}`, clip.animations, mediaTimeAt(clip, t));
}
