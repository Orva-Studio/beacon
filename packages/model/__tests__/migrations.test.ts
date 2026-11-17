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
  expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  expect(migrated.sections).toEqual([]);
});

test("v4: a clip with the same effect twice keeps one, the last, nested clips too", () => {
  const fx = (id: string, type: string) => ({ id, type, enabled: true, params: {} });
  const clip = (id: string, effects: unknown[], props = {}) => ({ id, type: "video", start: 0, duration: 10, props, effects, animations: [] });
  const inner = clip("c2", [fx("d", "blur"), fx("e", "blur")]);
  const doc = { tracks: [{ id: "t1", clips: [clip("c1", [fx("a", "round-corners"), fx("b", "cursor-shadow"), fx("c", "round-corners")], { group: { tracks: [{ id: "t2", clips: [inner] }] } })] }] };
  const out = CORE_MIGRATIONS.find((m) => m.version === 4)!.migrate(structuredClone(doc)) as any;
  expect(out.tracks[0].clips[0].effects.map((e: { id: string }) => e.id)).toEqual(["b", "c"]);
  expect(out.tracks[0].clips[0].props.group.tracks[0].clips[0].effects.map((e: { id: string }) => e.id)).toEqual(["e"]);
});

// Before 7, a document had markers and no comments.
const old = (registry: FeatureRegistry) => {
  const { comments: _, ...doc } = createProject(registry);
  return { ...doc, markers: [] };
};

test("v5 and v6: sections as they were", () => {
  const registry = new FeatureRegistry([testFeature]);
  const section = { id: "s1", start: 0, end: 30_000, name: "Intro" };
  expect(migrateProject({ ...old(registry), schemaVersion: 4, sections: [section] }, registry).sections).toEqual([section]);
  expect(migrateProject({ ...old(registry), schemaVersion: 5, sections: [{ ...section, color: "green" }] }, registry).sections).toEqual([{ ...section, color: "green" }]);
  expect(() => migrateProject({ ...old(registry), schemaVersion: 6, sections: [{ ...section, color: "teal" }] }, registry)).toThrow();
});

test("v7: comments leave sections for their own list, markers become comments at a moment; an answered comment and a section that was only a comment go", () => {
  const registry = new FeatureRegistry([testFeature]);
  const doc = {
    ...old(registry),
    schemaVersion: 6,
    markers: [{ id: "m1", time: 90_000, name: "check audio" }, { id: "m2", time: 10_000, name: "" }],
    sections: [
      { id: "s1", start: 0, end: 30_000, name: "Intro", comment: "zoom in", color: "green" },
      { id: "s2", start: 30_000, end: 60_000, name: "", comment: "remove the circle" },
      { id: "s3", start: 60_000, end: 80_000, name: "Demo", comment: "add a caption", reply: "Added it" },
    ],
  };
  const migrated = migrateProject(doc, registry);
  expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  expect("markers" in migrated).toBe(false);
  expect(migrated.sections).toEqual([
    { id: "s1", start: 0, end: 30_000, name: "Intro", color: "green" },
    { id: "s3", start: 60_000, end: 80_000, name: "Demo" },
  ]);
  expect(migrated.comments).toEqual([
    { id: "s1-comment", start: 0, end: 30_000, text: "zoom in" },
    { id: "m2", start: 10_000, text: "" },
    { id: "s2-comment", start: 30_000, end: 60_000, text: "remove the circle" },
    { id: "m1", start: 90_000, text: "check audio" },
  ]);
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
