import { z } from "zod";
import {
  animatedValue,
  clipEnd,
  defineAction,
  defineCommand,
  defineFeature,
  envelopeBlocks,
  envelopePoints,
  mediaTimeAt,
  secondsToTicks,
  snapSeconds,
  ticksToSeconds,
  type ActionContext,
  type ActionStep,
  type Clip,
  type EnvelopePoint,
  type Ticks,
  timelineTimeAt,
} from "@beacon/model";
import { findClip } from "../timeline";
import { dropTargets, selectDropped } from "../timeline/actions";

const TARGET = "audio.volume";
/** Fades are about a second. */
const FADE = 1;
/** Silencing ramps the volume over this long at each end, so it doesn't click. */
const RAMP = 0.05;

const volumeOf = (c: Clip) => Number((c.props.audio as { volume?: number } | undefined)?.volume ?? 1);
const toTimeline = (c: Clip, media: Ticks) => ticksToSeconds(timelineTimeAt(c, media));

/** The clip's audio points with times on the timeline (seconds). */
export function audioPoints(c: Clip): { time: number; value: number }[] {
  return envelopePoints(volumeOf(c), c.animations, TARGET).map((p) => ({ time: toTimeline(c, p.time), value: p.value }));
}

/** The volume at a timeline time. */
function volumeAt(c: Clip, t: number): number {
  return Number(animatedValue(volumeOf(c), TARGET, c.animations, mediaTimeAt(c, secondsToTicks(t))));
}

const setPoints = (c: Clip, points: { time: number; value: number }[]): ActionStep => ({ command: "volume.setPoints", args: { clip: c.id, points } });

/** Selected clips with audio, else those under the playhead (or in the range) on unlocked tracks. */
function audioClips(ctx: ActionContext): Clip[] {
  const has = (c: Clip) => ctx.registry.hasTrait(c.type, "audio");
  const picked = ctx.scope.tracks.flatMap((t) => t.clips.filter((c) => ctx.session.selection.includes(c.id) && has(c)));
  if (picked.length) return picked;
  const [a, b] = ctx.session.range ? [ctx.session.range.in, ctx.session.range.out] : [ctx.session.playhead, ctx.session.playhead];
  return ctx.scope.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.filter((c) => has(c) && ticksToSeconds(c.start) <= b && ticksToSeconds(clipEnd(c)) >= a));
}

/** The clips' points with `[a, b]` replaced by `put` (timeline seconds). */
function replaceSpan(c: Clip, a: number, b: number, put: (keep: (t: number) => number) => { time: number; value: number }[]) {
  const before = (t: number) => volumeAt(c, t);
  const outside = audioPoints(c).filter((p) => p.time < a - 1e-6 || p.time > b + 1e-6);
  return [...outside, ...put(before)].sort((x, y) => x.time - y.time);
}

/**
 * Audio points: a clip's volume
 * envelope, stored as the `audio.volume` base value and linear animation
 * blocks from point to point in media time, so split pieces share it. Fades,
 * silencing and restoring write points.
 */
export const volume = defineFeature({
  id: "volume",
  panelItems: [{ id: "audio:fade-in" }, { id: "audio:fade-out" }],
  version: 1,
  commands: [
    defineCommand({
      id: "volume.setPoints",
      description:
        "Replace a clip's audio points (its volume envelope): `points` are timeline seconds and gains (1 = as recorded, 0 = silent), joined by straight lines; the volume holds at the first point's value before it and the last's after it. An empty list leaves the volume flat at its current base",
      args: z.strictObject({ clip: z.string().min(1), points: z.array(z.strictObject({ time: z.number(), value: z.number().nonnegative() })) }),
      apply(doc, { clip, points }, ctx) {
        const loc = findClip(doc, ctx.registry, clip);
        const c = loc.clip;
        if (!c.props.audio && !ctx.registry.groupsFor(c.type).some((g) => g.id === "audio")) throw new Error(`clip "${clip}" has no audio`);
        // Points before a clip's start (a split piece's share of the envelope) can sit at negative timeline times.
        const media: EnvelopePoint[] = points.map((p) => ({ time: mediaTimeAt(c, Math.sign(p.time) * snapSeconds(Math.abs(p.time), doc.settings.fps) - loc.offset), value: p.value }));
        // One point per time: the last given wins.
        const unique = [...new Map(media.map((p) => [p.time, p])).values()];
        const { base, blocks } = envelopeBlocks(unique, TARGET, ctx.newId);
        c.animations = [...c.animations.filter((a) => !(TARGET in a.to)), ...blocks].sort((x, y) => x.end - y.end);
        const def = ctx.registry.groupsFor(c.type).find((g) => g.id === "audio")!;
        c.props.audio = { ...def.defaults(), ...(c.props.audio as object | undefined), ...(base === undefined ? {} : { volume: base }) };
      },
    }),
  ],
  actions: [
    defineAction({
      id: "edit.addAudioPoint",
      description: "Add an audio point at the playhead to the selected clips' volume (⌃⌥A), at the volume they have there",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        const t = ctx.session.playhead;
        const clips = audioClips(ctx).filter((c) => ticksToSeconds(c.start) <= t && t <= ticksToSeconds(clipEnd(c)));
        if (!clips.length) throw new Error("select audio under the playhead first");
        return { label: "Add Audio Point", steps: clips.map((c) => setPoints(c, replaceSpan(c, t, t, (v) => [{ time: t, value: v(t) }]))) };
      },
    }),
    defineAction({
      id: "edit.fade",
      description:
        "Fade the selected clips' audio in from silence at their start, or out to silence at their end, over `duration` seconds (Audio Effects: Fade In / Fade Out); with `clip`, as dropping it on that clip: its audio, or the whole selection's when it is selected",
      args: z.strictObject({ kind: z.enum(["in", "out"]), duration: z.number().positive().default(FADE), clip: z.string().min(1).optional() }),
      resolve: ({ kind, duration, clip }, ctx) => {
        const clips = clip ? dropTargets(ctx, clip).filter((c) => ctx.registry.hasTrait(c.type, "audio")) : audioClips(ctx);
        if (!clips.length) throw new Error(clip ? "fades apply to media with audio" : "select audio first");
        return {
          label: kind === "in" ? "Fade In" : "Fade Out",
          after: () => selectDropped(ctx, clip),
          steps: clips.map((c) => {
            const [s, e] = [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))];
            const d = Math.min(duration, e - s);
            return kind === "in"
              ? setPoints(c, replaceSpan(c, s, s + d, (v) => [{ time: s, value: 0 }, { time: s + d, value: v(s + d) }]))
              : setPoints(c, replaceSpan(c, e - d, e, (v) => [{ time: e - d, value: v(e - d) }, { time: e, value: 0 }]));
          }),
        };
      },
    }),
    defineAction({
      id: "edit.silenceAudio",
      description: "Silence the selected clips' audio (or every clip's audio, with nothing selected) in the in/out range, ramping at its ends; without a range, the whole of the selected clips (⌥S)",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        const clips = audioClips(ctx);
        if (!clips.length) throw new Error("select audio or set an in/out range first");
        const r = ctx.session.range;
        return {
          label: "Silence Audio",
          steps: clips.flatMap((c) => {
            // The whole clip: its points go too, or the volume would come back after the first one.
            if (!r) return [setPoints(c, []), { command: "clip.set", args: { clip: c.id, props: { audio: { volume: 0 } } } }];
            const [a, b] = [Math.max(r.in, ticksToSeconds(c.start)), Math.min(r.out, ticksToSeconds(clipEnd(c)))];
            const ramp = Math.min(RAMP, (b - a) / 2);
            return setPoints(c, replaceSpan(c, a, b, (v) => [{ time: a, value: v(a) }, { time: a + ramp, value: 0 }, { time: b - ramp, value: 0 }, { time: b, value: v(b) }]));
          }),
        };
      },
    }),
    defineAction({
      id: "edit.restoreAudio",
      description: "Remove the audio points in the in/out range from the selected clips (or every clip, with nothing selected); without a range, reset the selected clips' volume to as recorded (⌥R)",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        const clips = audioClips(ctx);
        if (!clips.length) throw new Error("select audio or set an in/out range first");
        const r = ctx.session.range;
        return {
          label: "Restore Audio",
          steps: clips.flatMap((c) =>
            r
              ? [setPoints(c, audioPoints(c).filter((p) => p.time < r.in - 1e-6 || p.time > r.out + 1e-6))]
              : [setPoints(c, []), { command: "clip.set", args: { clip: c.id, props: { audio: { volume: 1 } } } }],
          ),
        };
      },
    }),
  ],
});
