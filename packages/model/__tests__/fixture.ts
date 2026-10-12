import { z } from "zod";
import { defineCommand, defineFeature, FeatureRegistry, createProject, ProjectStore, type Project } from "../src";

const clipCommands = [
  defineCommand({
    id: "clip.set",
    description: "Set clip timing or props",
    args: z.object({ clip: z.string(), start: z.int().optional(), props: z.record(z.string(), z.unknown()).optional() }),
    apply(doc, { clip, start, props }) {
      const c = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clip);
      if (!c) throw new Error(`no clip ${clip}`);
      if (start !== undefined) c.start = start;
      if (props) c.props.look = { opacity: 1, ...(c.props.look as object | undefined), ...props };
    },
  }),
  defineCommand({
    id: "clip.remove",
    description: "Remove a clip",
    args: z.object({ clip: z.string() }),
    apply(doc, { clip }) {
      for (const t of doc.tracks) t.clips = t.clips.filter((c) => c.id !== clip);
    },
  }),
];

export const testFeature = defineFeature({
  id: "test-clips",
  version: 1,
  clipTypes: [{ id: "video", description: "test video clip", traits: ["visual"] }],
  props: [
    {
      id: "look",
      description: "test look",
      traits: ["visual"],
      schema: z.strictObject({ opacity: z.number().min(0).max(1) }),
      defaults: () => ({ opacity: 1 }),
      animatable: ["opacity"],
    },
  ],
  commands: clipCommands,
});

export function setup(): { registry: FeatureRegistry; store: ProjectStore; initial: Project } {
  let n = 0;
  const registry = new FeatureRegistry([testFeature]);
  const initial = createProject(registry);
  const store = new ProjectStore(registry, initial, { newId: (p) => `${p}-${++n}` });
  return { registry, store, initial };
}
