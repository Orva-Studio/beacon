import type { Migration } from "./feature";
import type { FeatureRegistry } from "./registry";
import { SCHEMA_VERSION, type Project } from "./schema";

/** Core migrations; `version: n` takes a document from n - 1 to n. */
export const CORE_MIGRATIONS: Migration[] = [
  // Asset paths inside the project folder may be relative on disk; the reader resolves them before this runs.
  { version: 2, migrate: (doc) => doc },
  { version: 3, migrate: (doc) => ({ ...(doc as object), sections: [] }) },
];

type Raw = Record<string, any>;

/** Every track in a document not yet migrated, nested ones (in groups) too: any object with a `clips` array. */
export function eachRawTrack(doc: unknown, fn: (track: Raw & { clips: unknown[] }) => void) {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    if (Array.isArray((v as Raw).clips)) fn(v as Raw & { clips: unknown[] });
    Object.values(v).forEach(visit);
  };
  visit(doc);
}

/** Every clip in a document not yet migrated, nested ones (in groups, stitched media) too. */
export function eachRawClip(doc: unknown, fn: (clip: Raw) => void) {
  eachRawTrack(doc, (track) => {
    for (const c of track.clips) if (c && typeof c === "object") fn(c as Raw);
  });
}

type Doc = Record<string, unknown> & { schemaVersion?: unknown; features?: Record<string, number> };

function asDoc(value: unknown, what: string): Doc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} returned ${value === null ? "null" : typeof value}, expected a project object`);
  }
  return value as Doc;
}

function runChain(doc: Doc, from: number, to: number, migrations: Migration[], what: string): Doc {
  for (let v = from + 1; v <= to; v++) {
    const step = migrations.filter((m) => m.version === v);
    if (step.length !== 1) throw new Error(`${what}: ${step.length ? "duplicate" : "no"} migration to version ${v}`);
    doc = asDoc(step[0]!.migrate(structuredClone(doc)), `${what} migration to ${v}`);
  }
  return doc;
}

/**
 * Brings a document from disk up to the current core schema and every
 * registered feature's data version: core first, then each feature in
 * registration order. Pure: the input is never modified. Refuses documents
 * written by a newer Beacon.
 */
export function migrateProject(raw: unknown, registry: FeatureRegistry, coreMigrations = CORE_MIGRATIONS): Project {
  let doc = asDoc(raw, "project file");
  const from = doc.schemaVersion;
  if (!Number.isInteger(from) || (from as number) < 0) throw new Error(`project has no valid schemaVersion`);
  if ((from as number) > SCHEMA_VERSION) {
    throw new Error(`project schema ${from} is newer than this Beacon (${SCHEMA_VERSION}); update the app`);
  }
  doc = runChain(doc, from as number, SCHEMA_VERSION, coreMigrations, "core");
  doc = { ...doc, schemaVersion: SCHEMA_VERSION, features: { ...doc.features } };

  for (const feature of registry.features.values()) {
    const have = doc.features![feature.id] ?? 0;
    if (have > feature.version) {
      throw new Error(`feature "${feature.id}" data version ${have} is newer than this Beacon (${feature.version})`);
    }
    if (have === feature.version) continue;
    // A document that has never recorded this feature holds none of its data,
    // so there is nothing to migrate; it is just stamped with the current version.
    if (have > 0) doc = runChain(doc, have, feature.version, feature.migrations ?? [], `feature "${feature.id}"`);
    doc = { ...doc, features: { ...doc.features, [feature.id]: feature.version } };
  }

  registry.validate(doc);
  return doc;
}
