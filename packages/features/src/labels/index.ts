import { z } from "zod";
import { defineAction, defineFeature } from "@beacon/model";

/** Camtasia's Add Color Label colours. */
export const LABEL_COLORS = ["red", "purple", "blue", "green", "yellow", "orange"] as const;

/**
 * A colour label marking a clip apart from others of its kind (other formatting, another place): drawn as a
 * stripe along the top of its timeline bar, so the bar keeps its kind's colour. Editing only; nothing renders.
 */
export const labels = defineFeature({
  id: "labels",
  version: 1,
  props: [
    {
      id: "label",
      description: `A colour label on the timeline, to tell the clip apart from others of its kind: ${LABEL_COLORS.join(", ")}, or null for none`,
      traits: ["visual", "audio", "caption"],
      schema: z.strictObject({ color: z.enum(LABEL_COLORS).nullable() }),
      defaults: () => ({ color: null }),
    },
  ],
  actions: [
    defineAction({
      id: "edit.label",
      description: `Give the selected clips a colour label (Add Color Label): ${LABEL_COLORS.join(", ")}, or null to remove it`,
      args: z.strictObject({ color: z.enum(LABEL_COLORS).nullable() }),
      resolve: ({ color }, ctx) => {
        const clips = ctx.scope.tracks.flatMap((t) => t.clips.filter((c) => ctx.session.selection.includes(c.id))).map((c) => c.id);
        if (!clips.length) throw new Error("select clips first");
        return { label: color ? "Add Color Label" : "Remove Color Label", steps: [{ command: "clip.set", args: { clips, props: { label: { color } } } }] };
      },
    }),
  ],
});
