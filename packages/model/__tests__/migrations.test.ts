import { expect, test } from "bun:test";
import { CORE_MIGRATIONS, createProject, defineFeature, FeatureRegistry, migrateProject, SCHEMA_VERSION } from "../src";
import { testFeature } from "./fixture";

const clipsV2 = defineFeature({
  ...testFeature,
  version: 2,
  migrations: [
    {
      version: 2,
      migrate: (doc: any) => {
        for (const clip of doc.tracks.flatMap((t: any) => t.clips)) {
          clip.props = { look: { opacity: clip.props.alpha } };
        }
        return doc;
      },
    },
  ],
});

test("core then feature migrations bring an old document up to date without touching the input", () => {
  const old = {
    schemaVersion: 0,
    features: { "test-clips": 1 },
    settings: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, sampleRate: 48000, background: "#000000" },
    assets: {},
    tracks: [{ id: "t1", name: "Screen", clips: [{ id: "c1", type: "video", start: 0, duration: 10, props: { alpha: 0.5 }, effects: [], animations: [] }] }],
    markers: [],
  };
  const frozen = JSON.stringify(old);
  const core = [
    {
      version: 1,
      migrate: (d: any) => {
        const { frameRate, ...settings } = d.settings;
        return { ...d, settings: { ...settings, fps: frameRate } };
      },
    },
    ...CORE_MIGRATIONS,
  ];

  const doc = migrateProject(old, new FeatureRegistry([clipsV2]), core);
  expect(JSON.stringify(old)).toBe(frozen);
  expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
  expect(doc.settings.fps).toEqual({ num: 30, den: 1 });
  expect(doc.features).toEqual({ "test-clips": 2 });
  expect(doc.tracks[0]!.clips[0]!.props).toEqual({ look: { opacity: 0.5 } });
});

test("v3: a document from before sections gets none", () => {
  const registry = new FeatureRegistry([testFeature]);
  const { sections: _, ...doc } = createProject(registry);
  const migrated = migrateProject({ ...doc, schemaVersion: 2 }, registry);
  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.sections).toEqual([]);
});

test("documents from a newer Beacon are refused", () => {
  const registry = new FeatureRegistry([testFeature]);
  const doc = createProject(registry);
  expect(() => migrateProject({ ...doc, schemaVersion: SCHEMA_VERSION + 1 }, registry)).toThrow("newer");
  expect(() => migrateProject({ ...doc, features: { "test-clips": 9 } }, registry)).toThrow("newer");
});

test("a missing migration step is an error, not a skip", () => {
  const registry = new FeatureRegistry([{ ...clipsV2, version: 3 }]);
  const doc = { ...createProject(new FeatureRegistry([testFeature])), features: { "test-clips": 1 } };
  expect(() => migrateProject(doc, registry)).toThrow("no migration to version 3");
});
