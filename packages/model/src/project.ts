import type { FeatureRegistry } from "./registry";
import { SCHEMA_VERSION, type Project, type Settings } from "./schema";
import type { Ticks } from "./ticks";

export const DEFAULT_SETTINGS: Settings = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  sampleRate: 48_000,
  background: "#000000",
  loudnessTarget: -18,
};

/** An empty project stamped with every registered feature's data version. */
export function createProject(registry: FeatureRegistry, settings: Partial<Settings> = {}): Project {
  const doc: Project = {
    schemaVersion: SCHEMA_VERSION,
    features: Object.fromEntries([...registry.features.values()].map((f) => [f.id, f.version])),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: {},
    tracks: [],
    markers: [],
    sections: [],
  };
  registry.validate(doc);
  return doc;
}

/** Names offered for a new section, after the project's own: a short list, so the same parts are named alike. */
export const SECTION_NAMES = ["Hook", "Intro", "Explanation", "Demo", "Example", "Recap", "Outro", "Call to Action"];

/** End of the last clip on the timeline. */
export function projectDuration(project: Project): Ticks {
  return Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
}
