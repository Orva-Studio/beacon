import { z } from "zod";
import {
  adoptTrackProps,
  animatedValue,
  clipEnd,
  defineAction,
  defineCommand,
  defineFeature,
  isFree,
  TrackSchema,
  type Clip,
  type Track,
  clone,
  cutToWindow,
  drawNested,
  nestedAudio,
} from "@beacon/model";

const groupSchema = z.strictObject({
  /** The group's own canvas, in pixels; its tracks are laid out on it. */
  width: z.number().positive(),
  height: z.number().positive(),
  /** Bottom → top; clip times are on the group's inner timeline. */
  tracks: z.array(TrackSchema),
});

type Look = { x: number; y: number; scaleX: number; scaleY: number; rotation: number; rotationX: number; rotationY: number; opacity: number };
const IDENTITY_LOOK: Look = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 };

/** A child's transform on the canvas once its group's is folded in (both centre-origin, y up; rotation counter-clockwise). */
function compose(g: Look, c: Look): Look {
  // A child sits relative to its group's canvas centre, which the group's transform places like any content centre.
  const vx = c.x * g.scaleX;
  const vy = c.y * g.scaleY;
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  return {
    x: g.x + vx * cos - vy * sin,
    y: g.y + vx * sin + vy * cos,
    scaleX: c.scaleX * g.scaleX,
    scaleY: c.scaleY * g.scaleY,
    rotation: c.rotation + g.rotation,
    // Tilts add exactly only when one of the two is flat, which is how they are used.
    rotationX: (c.rotationX ?? 0) + (g.rotationX ?? 0),
    rotationY: (c.rotationY ?? 0) + (g.rotationY ?? 0),
    opacity: c.opacity * g.opacity,
  };
}

const Ids = z.array(z.string().min(1)).min(1);

/**
 * A clip holding its own tracks on its own canvas, shown through a time
 * window (mediaStart / duration), drawn to one texture so effects apply to
 * the group as a whole.
 */
export const groups = defineFeature({
  id: "groups",
  version: 1,
  clipTypes: [{ id: "group", description: "Clips grouped on their own canvas and timeline", traits: ["visual", "group"] }],
  props: [
    {
      id: "group",
      description: "Canvas size and nested tracks",
      traits: ["group"],
      schema: groupSchema,
      defaults: () => ({ width: 1920, height: 1080, tracks: [] }),
      nested: (v: { tracks: Track[] }) => v.tracks,
      size: (v: { width: number; height: number }) => [v.width, v.height],
    },
  ],
  commands: [
    defineCommand({
      id: "clip.group",
      description:
        "Group top-level clips into one group clip (⌘G): they keep their tracks' order and times inside it, on a canvas the size of the project's so nothing moves; the group goes on the topmost of their tracks that is free over its span, else a new track above. Returns the group's id",
      args: z.strictObject({ clips: Ids }),
      apply(doc, { clips }, ctx) {
        const picked = doc.tracks.flatMap((t, ti) => t.clips.filter((c) => clips.includes(c.id)).map((c) => ({ c, t, ti })));
        if (picked.length !== new Set(clips).size) throw new Error("only clips on the main timeline can be grouped");
        for (const { t } of picked) if (t.locked) throw new Error(`track "${t.name}" is locked`);
        const start = Math.min(...picked.map((p) => p.c.start));
        const end = Math.max(...picked.map((p) => clipEnd(p.c)));
        const ids = new Set(clips);
        const used = [...new Set(picked.map((p) => p.ti))].sort((a, b) => a - b);
        // Disabled and muted tracks stay so inside, so grouping changes nothing seen or heard.
        const inner: Track[] = used.map((ti) => ({
          id: ctx.newId("track"),
          name: doc.tracks[ti]!.name,
          ...(doc.tracks[ti]!.hidden ? { hidden: true } : {}),
          ...(doc.tracks[ti]!.muted ? { muted: true } : {}),
          ...(doc.tracks[ti]!.props ? { props: clone(doc.tracks[ti]!.props) } : {}),
          clips: doc.tracks[ti]!.clips.filter((c) => ids.has(c.id)).map((c) => ({ ...clone(c), start: c.start - start })),
        }));
        // On the topmost of their tracks, else just above it, so nothing that covered them comes on top.
        const top = used.at(-1)!;
        const home = isFree(doc.tracks[top]!, start, end, ids) ? top : undefined;
        for (const { c, t } of picked) t.clips.splice(t.clips.indexOf(c), 1);
        let track = home === undefined ? undefined : doc.tracks[home];
        if (!track) {
          track = { id: ctx.newId("track"), name: "", clips: [] };
          doc.tracks.splice(used.at(-1)! + 1, 0, track);
        }
        const id = ctx.newId("clip");
        const group: Clip = {
          id,
          type: "group",
          start,
          duration: end - start,
          mediaStart: 0,
          props: { group: { width: doc.settings.width, height: doc.settings.height, tracks: inner } },
          effects: [],
          animations: [],
        };
        track.clips.push(group);
        track.clips.sort((a, b) => a.start - b.start);
        return id;
      },
    }),
    defineCommand({
      id: "clip.ungroup",
      description:
        "Ungroup a group clip (⌘U): what shows through its window goes back on the timeline at the same times, with the group's position, scale, rotation and opacity folded into each visual clip; its first track goes where the group was and the rest on new tracks above. The group's crop, effects and animations are not carried over. Returns the clips' ids",
      args: z.strictObject({ clip: z.string().min(1) }),
      apply(doc, { clip }, ctx) {
        const ti = doc.tracks.findIndex((t) => t.clips.some((c) => c.id === clip));
        const g = doc.tracks[ti]?.clips.find((c) => c.id === clip);
        if (!g || g.type !== "group") throw new Error(`"${clip}" is not a group on the main timeline`);
        if (doc.tracks[ti]!.locked) throw new Error(`track "${doc.tracks[ti]!.name}" is locked`);
        if (g.speed) throw new Error("a group with a speed change can't be ungrouped");
        const { tracks } = g.props.group as { tracks: Track[] };
        const look: Look = { ...IDENTITY_LOOK, ...(g.props.transform as Partial<Look> | undefined) };
        const [a, b] = [g.mediaStart ?? 0, (g.mediaStart ?? 0) + g.duration];
        const offset = g.start - a;
        doc.tracks[ti]!.clips.splice(doc.tracks[ti]!.clips.indexOf(g), 1);
        const out: string[] = [];
        let above = ti + 1;
        tracks.forEach((inner, i) => {
          const clips = inner.clips.flatMap((c) => {
            const copy = cutToWindow(c, a, b, ctx.registry);
            if (!copy) return [];
            copy.start += offset;
            if (ctx.registry.groupsFor(copy.type).some((x) => x.id === "transform")) {
              const own = { ...IDENTITY_LOOK, ...(copy.props.transform as Partial<Look> | undefined) };
              // Animation end values are in the group's space too: fold the group into each, from the clip's look at that block's end.
              for (const block of copy.animations) {
                const keys = Object.keys(block.to).filter((k) => k.startsWith("transform."));
                if (!keys.length) continue;
                const at = Object.fromEntries(
                  (Object.keys(IDENTITY_LOOK) as (keyof Look)[]).map((f) => [f, Number(animatedValue(own[f], `transform.${f}`, c.animations, block.end))]),
                ) as Look;
                const folded = compose(look, at);
                for (const k of keys) block.to[k] = folded[k.slice("transform.".length) as keyof Look];
              }
              copy.props.transform = compose(look, own);
            }
            out.push(copy.id);
            return [copy];
          });
          if (!clips.length) return;
          const flags = { ...(inner.hidden ? { hidden: true } : {}), ...(inner.muted ? { muted: true } : {}) };
          const target = i === 0 && !inner.hidden && !inner.muted ? doc.tracks[ti]! : (() => {
            const t: Track = { id: ctx.newId("track"), name: inner.name, ...flags, clips: [] };
            doc.tracks.splice(above++, 0, t);
            return t;
          })();
          adoptTrackProps(target, inner.props);
          target.clips.push(...clips);
          target.clips.sort((x, y) => x.start - y.start);
        });
        return out;
      },
    }),
  ],
  actions: [
    defineAction({
      id: "edit.group",
      description: "Group the selected clips (⌘G) and select the group",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to group clips");
        const clips = ctx.project.tracks.flatMap((t) => t.clips.filter((c) => ctx.session.selection.includes(c.id)));
        if (!clips.length) throw new Error("select media first");
        return {
          label: "Group",
          steps: [{ command: "clip.group", args: { clips: clips.map((c) => c.id) } }],
          after: (r) => [{ command: "selection.set", args: { clips: [r[0] as string], linked: false } }],
        };
      },
    }),
    defineAction({
      id: "edit.ungroup",
      description: "Ungroup the selected groups (⌘U) and select their clips",
      args: z.strictObject({}),
      resolve: (_, ctx) => {
        if (ctx.scope.group) throw new Error("close the group (⌃⇧U) to ungroup it");
        const groups = ctx.project.tracks.flatMap((t) => t.clips.filter((c) => c.type === "group" && ctx.session.selection.includes(c.id)));
        if (!groups.length) throw new Error("select a group first");
        return {
          label: "Ungroup",
          steps: groups.map((g) => ({ command: "clip.ungroup", args: { clip: g.id } })),
          after: (r) => [{ command: "selection.set", args: { clips: (r as string[][]).flat(), linked: false } }],
        };
      },
    }),
  ],
  camtasia: {
    clipTypes: { Group: () => ({ type: "group" }) },
    params(media, clip, ctx) {
      if (clip.type !== "group") return;
      const volume = Number(ctx.value(media, "volume") ?? 1);
      if (volume !== 1) ctx.report(`group volume ${volume} not imported`);
      clip.props.group = {
        width: Number(media.attributes?.widthAttr ?? 1920),
        height: Number(media.attributes?.heightAttr ?? 1080),
        tracks: ctx.tracks(media.tracks ?? []),
      };
    },
  },
  evaluate: {
    audio: (clip, ctx) => (clip.type === "group" ? nestedAudio(clip, (clip.props.group as { tracks: Track[] } | undefined)?.tracks, ctx) : []),
    clip(e, ctx) {
      if (e.clip.type === "group" && e.props.group) drawNested(e, e.props.group as { width: number; height: number; tracks: Track[] }, ctx);
    },
  },
});
