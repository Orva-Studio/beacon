import { z } from "zod";
import { defineAction, defineFeature, type ActionContext, type Clip } from "@beacon/model";

/**
 * Show or hide a kind of clip's picture in one go (the user, 2026-10-24: from the command palette): the selected ones
 * of that kind, else every one on the timeline (locked tracks left alone). Any showing: all hidden (0%); else all
 * shown (100%). One undo step.
 */
function toggle(id: string, what: string, kind: (c: Clip, ctx: ActionContext) => boolean, group: string, of: (c: Clip) => number) {
  return defineAction({
    id,
    description: `Toggle the ${what} between hidden (opacity 0%) and shown (100%): the selected ${what} clips, else every one on the timeline. Any of them showing: all are hidden; else all are shown`,
    args: z.strictObject({}),
    resolve: (_, ctx) => {
      const tracks = ctx.scope.tracks.map((t) => ({ locked: !!t.locked, clips: t.clips.filter((c) => kind(c, ctx)) }));
      const picked = tracks.flatMap((t) => t.clips.filter((c) => ctx.session.selection.includes(c.id)).map((c) => ({ c, locked: t.locked })));
      // A selection is what's meant even when it's locked: never every other one instead.
      if (picked.length && picked.every((p) => p.locked)) throw new Error(`the selected ${what} is on a locked track`);
      const clips = picked.length ? picked.filter((p) => !p.locked).map((p) => p.c) : tracks.filter((t) => !t.locked).flatMap((t) => t.clips);
      if (!clips.length) throw new Error(`no ${what} on the timeline`);
      const field = `${group}.opacity`;
      const showing = clips.some((c) => of(c) > 0 || c.animations.some((a) => typeof a.to[field] === "number" && (a.to[field] as number) > 0));
      const label = `${showing ? "Hide" : "Show"} ${what[0]!.toUpperCase()}${what.slice(1)}`;
      const opacity = showing ? 0 : 1;
      // Animated opacity would bring the picture back after its block: each block's end goes the same way.
      const animated = clips.flatMap((c) => c.animations.filter((a) => field in a.to).map((a) => ({ command: "animation.set", args: { clip: c.id, animation: a.id, to: { ...a.to, [field]: opacity } } })));
      return { label, steps: [{ command: "clip.set", args: { clips: clips.map((c) => c.id), props: { [group]: { opacity } } } }, ...animated] };
    },
  });
}

const opacity = (group: string) => (c: Clip) => ((c.props[group] as { opacity?: number } | undefined)?.opacity ?? 1);

export const toggles = defineFeature({
  id: "toggles",
  version: 1,
  actions: [
    toggle("cursor.toggle", "cursor", (c, ctx) => ctx.registry.hasTrait(c.type, "cursor") && c.type === "screen", "cursor", opacity("cursor")),
    // A recording's camera: its video that isn't the screen.
    toggle("camera.toggle", "camera", (c, ctx) => c.type === "video" && ctx.project.assets[c.assetId ?? ""]?.kind === "recording", "transform", opacity("transform")),
  ],
});
