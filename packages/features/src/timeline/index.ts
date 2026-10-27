import { z } from "zod";
import {
  blockAt,
  defineCommand,
  defineFeature,
  defineQuery,
  EASINGS,
  EasingSchema,
  EffectInstanceSchema,
  mediaTimeAt,
  projectDuration,
  clipSpeed,
  rationalToNumber,
  roundSeconds,
  secondsToTicks,
  snapSeconds,
  ticksToSeconds,
  trackName,
  type Clip,
  type Project,
  type Ticks,
  type FeatureRegistry,
  clone,
  freshEffect,
  findClip,
  onTrack,
  IdSchema as Id,
  SecondsSchema as Seconds,
} from "@beacon/model";
import { visualSize } from "../media";
import { actions, animationActions } from "./actions";
import { clipCommands, packMagnetic } from "./clips";


export { rippleDeleteRanges } from "./clips";

const commands = [
  defineCommand({
    id: "clip.set",
    description:
      "Set clips' property values: `props` maps prop group → fields to change (e.g. {transform: {scaleX: 0.5}, crop: {left: 100}}); other fields keep their values. With `at` (timeline seconds), an animated field changes where it is at that time: the end value of the animation block in effect there, or the base value before any. Prop groups per clip type are in the beacon://reference/commands resource",
    args: z
      .strictObject({ clip: Id.optional(), clips: z.array(Id).min(1).optional(), props: z.record(z.string(), z.record(z.string(), z.unknown())), at: Seconds.optional() })
      .refine((a) => (a.clip === undefined) !== (a.clips === undefined), { message: "give `clip` or `clips`, not both" }),
    apply(doc, { clip, clips, props, at }, ctx) {
      for (const id of clips ?? [clip!]) {
        const loc = findClip(doc, ctx.registry, id);
        const c = loc.clip;
        const media = at === undefined ? undefined : mediaTimeAt(c, onTrack(doc, loc, at));
        for (const [group, values] of Object.entries(props)) {
          const def = ctx.registry.group(c.type, group);
          if (!def) throw new Error(`clip type "${c.type}" has no prop group "${group}"`);
          const base: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(values)) {
            const block = media === undefined ? undefined : blockAt(c.animations, `${group}.${field}`, media);
            if (block) block.to[`${group}.${field}`] = value;
            else base[field] = value;
          }
          c.props[group] = { ...def.defaults(), ...(c.props[group] as object | undefined), ...base };
        }
      }
    },
  }),
  defineCommand({
    id: "clip.pasteProperties",
    description:
      "Apply copied properties (from the editor's `properties.copy`, in its session) to clips: each prop group that applies to a clip's type replaces its own, and the copied effects that apply replace the clip's effects: with `type` (the clip type copied from), every effect such a clip could have, so one the copy didn't have is removed; without it, only those of the same types (Paste Properties)",
    args: z.strictObject({
      clips: z.array(Id).min(1),
      props: z.record(z.string(), z.record(z.string(), z.unknown())),
      effects: z.array(EffectInstanceSchema).default([]),
      type: z.string().min(1).optional(),
    }),
    apply(doc, { clips, props, effects, type }, ctx) {
      for (const id of clips) {
        const { clip: c } = findClip(doc, ctx.registry, id);
        const groups = new Set(ctx.registry.groupsFor(c.type).map((g) => g.id));
        for (const [group, values] of Object.entries(props)) if (groups.has(group)) c.props[group] = clone(values);
        const fits = effects.filter((e) => ctx.registry.effectFits(e.type, c.type));
        const types = new Set(fits.map((e) => e.type));
        const replaced = (e: { type: string }) => types.has(e.type) || (type !== undefined && ctx.registry.effectFits(e.type, type));
        c.effects = [...c.effects.filter((e) => !replaced(e)), ...fits.map((e) => freshEffect(e, ctx.newId))];
      }
    },
  }),
  defineCommand({
    id: "animation.add",
    description:
      "Add an animation block to a clip: over `duration` seconds ending at timeline time `end`, the properties in `to` (\"group.field\" → value, e.g. {\"transform.scaleX\": 1}) move from their current values to these. Values hold until the next block. Returns the block id",
    args: z.strictObject({ clip: Id, end: Seconds, duration: Seconds, easing: EasingSchema.default("linear"), to: z.record(z.string(), z.unknown()) }),
    apply(doc, { clip, end, duration, easing, to }, ctx) {
      const loc = findClip(doc, ctx.registry, clip);
      const c = loc.clip;
      const id = ctx.newId("anim");
      c.animations.push({ id, end: mediaTimeAt(c, onTrack(doc, loc, end)), duration: Math.round(secondsToTicks(duration) * clipSpeed(c)), easing, to });
      c.animations.sort((x, y) => x.end - y.end);
      return id;
    },
  }),
  defineCommand({
    id: "animation.set",
    description: "Change an animation block: its end (timeline seconds), duration, easing or target values (`to` replaces the whole map)",
    args: z.strictObject({ clip: Id, animation: Id, end: Seconds.optional(), duration: Seconds.optional(), easing: EasingSchema.optional(), to: z.record(z.string(), z.unknown()).optional() }),
    apply(doc, { clip, animation, end, duration, easing, to }, ctx) {
      const loc = findClip(doc, ctx.registry, clip);
      const c = loc.clip;
      const a = c.animations.find((x) => x.id === animation);
      if (!a) throw new Error(`clip "${clip}" has no animation "${animation}"`);
      if (end !== undefined) a.end = mediaTimeAt(c, onTrack(doc, loc, end));
      if (duration !== undefined) a.duration = Math.round(secondsToTicks(duration) * clipSpeed(c));
      if (easing) a.easing = easing;
      if (to) a.to = to;
      c.animations.sort((x, y) => x.end - y.end);
    },
  }),
  defineCommand({
    id: "animation.remove",
    description: "Remove an animation block from a clip",
    args: z.strictObject({ clip: Id, animation: Id }),
    apply(doc, { clip, animation }, ctx) {
      const { clip: c } = findClip(doc, ctx.registry, clip);
      const i = c.animations.findIndex((x) => x.id === animation);
      if (i < 0) throw new Error(`clip "${clip}" has no animation "${animation}"`);
      c.animations.splice(i, 1);
    },
  }),
  defineCommand({
    id: "effect.add",
    description: "Add an effect to a clip with its default params, overridden by `params` (e.g. type \"round-corners\", \"drop-shadow\"; every effect id and its params is in the beacon://reference/commands resource). Returns the effect id",
    args: z.strictObject({ clip: Id, type: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}), enabled: z.boolean().default(true) }),
    apply(doc, { clip, type, params, enabled }, ctx) {
      const { clip: c } = findClip(doc, ctx.registry, clip);
      const id = ctx.newId("fx");
      c.effects.push({ id, type, enabled, params: { ...ctx.registry.effect(type).defaults(), ...params } });
      return id;
    },
  }),
  defineCommand({
    id: "effect.set",
    description:
      "Change an effect's params (merged), turn it on or off, or set the part of the clip it applies to: `span` in timeline seconds (its bar dragged on the timeline), null for the whole clip",
    args: z.strictObject({
      clip: Id,
      effect: Id,
      params: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      span: z.strictObject({ start: Seconds, end: Seconds }).nullable().optional(),
    }),
    apply(doc, { clip, effect, params, enabled, span }, ctx) {
      const loc = findClip(doc, ctx.registry, clip);
      const c = loc.clip;
      const fx = c.effects.find((e) => e.id === effect);
      if (!fx) throw new Error(`clip "${clip}" has no effect "${effect}"`);
      if (params) fx.params = { ...fx.params, ...params };
      if (enabled !== undefined) fx.enabled = enabled;
      if (span === null) delete fx.span;
      else if (span) {
        if (span.end <= span.start) throw new Error("an effect's span must end after it starts");
        fx.span = { start: mediaTimeAt(c, onTrack(doc, loc, span.start)), end: mediaTimeAt(c, onTrack(doc, loc, span.end)) };
      }
    },
  }),
  defineCommand({
    id: "effect.remove",
    description: "Remove an effect from a clip",
    args: z.strictObject({ clip: Id, effect: Id }),
    apply(doc, { clip, effect }, ctx) {
      const { clip: c } = findClip(doc, ctx.registry, clip);
      const i = c.effects.findIndex((e) => e.id === effect);
      if (i < 0) throw new Error(`clip "${clip}" has no effect "${effect}"`);
      c.effects.splice(i, 1);
    },
  }),
  defineCommand({
    id: "marker.add",
    description: "Add a timeline marker at a time in seconds. Returns its id",
    args: z.strictObject({ time: Seconds, name: z.string() }),
    apply(doc, { time, name }, ctx) {
      const id = ctx.newId("marker");
      doc.markers.push({ id, time: snapSeconds(time, doc.settings.fps), name });
      doc.markers.sort((a, b) => a.time - b.time);
      return id;
    },
  }),
  defineCommand({
    id: "marker.remove",
    description: "Remove a timeline marker",
    args: z.strictObject({ marker: Id }),
    apply(doc, { marker }) {
      const i = doc.markers.findIndex((m) => m.id === marker);
      if (i < 0) throw new Error(`no marker "${marker}"`);
      doc.markers.splice(i, 1);
    },
  }),
];

const s = (t: Ticks) => roundSeconds(ticksToSeconds(t));


function clipSummary(project: Project, registry: FeatureRegistry, clip: Clip) {
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
  return {
    id: clip.id,
    type: clip.type,
    start: s(clip.start),
    end: s(clip.start + clip.duration),
    mediaStart: s(clip.mediaStart ?? 0),
    ...(clip.speed ? { speed: rationalToNumber(clip.speed) } : {}),
    ...(asset ? { asset: asset.id, file: asset.path.split("/").pop() } : {}),
    ...((size) => (size ? { size } : {}))(visualSize(project, registry, clip)),
    ...(clip.linkId ? { linkId: clip.linkId } : {}),
    props: clip.props,
    effects: clip.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, params: e.params })),
    animations: clip.animations.map((a) => ({ id: a.id, mediaEnd: s(a.end), duration: s(a.duration), easing: a.easing, to: a.to })),
  };
}

function describe(project: Project): string {
  const { width, height, fps, background } = project.settings;
  const lines = [
    `${width}x${height} @ ${(fps.num / fps.den).toFixed(3).replace(/\.?0+$/, "")} fps, background ${background}, duration ${s(projectDuration(project))}s`,
    `assets: ${Object.values(project.assets).map((a) => `${a.id} (${a.kind}, ${a.path.split("/").pop()})`).join(", ") || "none"}`,
    `tracks (bottom to top):`,
  ];
  for (const [i, t] of project.tracks.entries()) {
    const flags = [t.hidden && "hidden", t.muted && "muted", t.locked && "locked"].filter(Boolean).join(", ");
    lines.push(`  ${t.id} "${trackName(t, i)}"${flags ? ` [${flags}]` : ""}: ${t.clips.length} clips`);
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const extra = [
        c.linkId && `link ${c.linkId}`,
        c.speed && `speed ${rationalToNumber(c.speed).toFixed(3)}`,
        c.animations.length && `${c.animations.length} animations`,
        c.effects.length && `effects ${c.effects.map((e) => e.type).join("/")}`,
      ].filter(Boolean);
      lines.push(`    ${c.id} ${c.type} ${s(c.start)}-${s(c.start + c.duration)}s from ${s(c.mediaStart ?? 0)}s${extra.length ? `; ${extra.join("; ")}` : ""}`);
    }
  }
  if (project.markers.length) lines.push(`markers: ${project.markers.map((m) => `${s(m.time)}s "${m.name}"`).join(", ")}`);
  return lines.join("\n");
}

/** RFC 6901 JSON pointer, e.g. "/tracks/0/clips". */
function pointer(doc: unknown, path: string): unknown {
  if (!path || path === "/") return doc;
  let v: any = doc;
  for (const raw of path.replace(/^\//, "").split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (v === null || typeof v !== "object" || !(key in v)) throw new Error(`nothing at "${path}"`);
    v = v[key];
  }
  return v;
}

const queries = [
  defineQuery({
    id: "project.describe",
    description: "Plain-text summary of the project: settings, assets, every track and clip with times in seconds",
    args: z.strictObject({}),
    run: (_, { project }) => describe(project),
    resource: { uri: "beacon://project/summary", name: "Project summary", mimeType: "text/plain" },
    summary: true,
  }),
  defineQuery({
    id: "project.get",
    description: "The project document (times in ticks, 705,600,000 per second), or the part at a JSON pointer such as \"/tracks/0\"",
    args: z.strictObject({ path: z.string().default("") }),
    run: ({ path }, { project }) => pointer(project, path),
  }),
  defineQuery({
    id: "timeline.clips",
    description: "Clips with timeline times in seconds, optionally only those overlapping [from, to)",
    args: z.strictObject({ from: Seconds.optional(), to: Seconds.optional(), track: Id.optional() }),
    resource: { uri: "beacon://project/timeline", name: "Timeline clips", mimeType: "application/json" },
    run: ({ from, to, track }, { project, registry }) =>
      project.tracks
        .map((t, i) => [t, trackName(t, i)] as const)
        .filter(([t]) => !track || t.id === track)
        .map(([t, name]) => ({
          track: t.id,
          name,
          clips: t.clips
            .filter((c) => (to === undefined || ticksToSeconds(c.start) < to) && (from === undefined || ticksToSeconds(c.start + c.duration) > from))
            .sort((a, b) => a.start - b.start)
            .map((c) => clipSummary(project, registry, c)),
        })),
  }),
];

/** Generic timeline editing: tracks, clips, ripple deletes, animation blocks, effects and markers. */
export const timeline = defineFeature({
  id: "timeline",
  version: 1,
  commands: [...clipCommands, ...commands],
  queries,
  normalize: packMagnetic,
  actions: [...actions, ...animationActions],
  panelItems: [
    { id: "visual:clip-speed", label: "Clip Speed", title: "Play the clip faster or slower: its speed in the properties panel", command: "edit.clipSpeed", args: {}, traits: ["video", "audio", "stitched"] },
  ],
  preferences: [
    {
      id: "animationEasing",
      title: "Animation easing",
      description: "How a new animation (Add Animation, ⇧A, an animation tile) moves; picking an easing on an animation makes it the one new animations take",
      options: EASINGS,
      default: "easeInOut",
    },
  ],
});
