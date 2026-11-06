#!/usr/bin/env bun
/**
 * The TypeScript file readers fed damaged files (PLAN Phase 14's gate): a project's project.json (read, migrated,
 * validated as opening does) and a take's recording.json and cursor.jsonl. Each must refuse with an Error, never hang
 * or throw something else. The `.trec` readers have theirs in Rust (`beacon-media`'s fuzz test).
 *
 *   bun scripts/fuzz-readers.ts [seconds per reader, default 30]
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@beacon/features";
import { loadBrecCursor, recording } from "../packages/media/src/brec";
import { ProjectStore } from "@beacon/model";
import { LocalCore, readProject } from "@beacon/core";

const seconds = Number(process.argv[2] ?? 30);
const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const dir = mkdtempSync(join(tmpdir(), "beacon-fuzz-"));
let seed = 0x9e3779b9;
const rand = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % Math.max(1, n));

const ODD: unknown[] = [null, -1, 0, 1e308, -1e308, Number.MAX_SAFE_INTEGER, "", "x".repeat(10_000), [], {}, true, "../../etc", { id: "x" }];

/** A copy with one value somewhere deleted, swapped for an odd one, or an array emptied or doubled. */
function mutateJson(v: unknown): unknown {
  const copy = structuredClone(v) as Record<string, unknown>;
  const paths: (string | number)[][] = [];
  const walk = (o: unknown, path: (string | number)[]) => {
    if (paths.length > 5000 || typeof o !== "object" || o === null) return;
    for (const k of Array.isArray(o) ? o.keys() : Object.keys(o)) {
      paths.push([...path, k]);
      walk((o as Record<string | number, unknown>)[k], [...path, k]);
    }
  };
  walk(copy, []);
  if (!paths.length) return ODD[rand(ODD.length)];
  for (let n = 1 + rand(3); n > 0; n--) {
    const path = paths[rand(paths.length)]!;
    let parent: Record<string | number, unknown> = copy;
    for (const k of path.slice(0, -1)) parent = parent?.[k] as Record<string | number, unknown>;
    if (typeof parent !== "object" || parent === null) continue;
    const key = path.at(-1)!;
    const op = rand(4);
    if (op === 0) delete parent[key];
    else if (op === 1) parent[key] = ODD[rand(ODD.length)];
    else if (Array.isArray(parent[key])) parent[key] = op === 2 ? [] : [...(parent[key] as unknown[]), ...(parent[key] as unknown[])];
    else parent[key] = structuredClone(ODD[rand(ODD.length)]);
  }
  return copy;
}

/** The same as text, bytes damaged instead: cut short, characters dropped or doubled. */
function mutateText(s: string): string {
  const i = rand(s.length);
  return [s.slice(0, i), s.slice(0, i) + s.slice(i + 1 + rand(8)), s.slice(0, i) + s.slice(i, i + rand(50)).repeat(2) + s.slice(i)][rand(3)]!;
}

async function fuzz(name: string, run: (n: number) => void | Promise<void>) {
  const end = Date.now() + seconds * 1000;
  let cases = 0;
  let refused = 0;
  let slowest = 0;
  const failures: string[] = [];
  while (Date.now() < end) {
    const t = performance.now();
    try {
      await run(cases);
    } catch (e) {
      if (e instanceof Error) refused++;
      else failures.push(`case ${cases}: threw ${String(e)}`);
    }
    const took = performance.now() - t;
    slowest = Math.max(slowest, took);
    if (took > 2000) failures.push(`case ${cases}: ${Math.round(took)} ms`);
    cases++;
  }
  console.log(`${name}: ${cases} damaged files, ${refused} refused, slowest ${slowest.toFixed(1)} ms${failures.length ? `\n  ${failures.slice(0, 10).join("\n  ")}` : ""}`);
  return failures.length;
}

const registry = createRegistry();
// A real project to damage: the fixtures' small Camtasia project, imported.
const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
const project = join(dir, "seed.beproj");
await core.close(await core.create({ path: project, cmproj: join(FIXTURES, "small.cmproj") }));
const projectJson = readFileSync(join(project, "project.json"), "utf8");
const take = join(dir, "take.brec");
cpSync(join(FIXTURES, "take.brec"), take, { recursive: true });
const [recJson, cursor] = [readFileSync(join(take, "recording.json"), "utf8"), readFileSync(join(take, "cursor.jsonl"), "utf8")];

let failed = 0;
failed += await fuzz("project.json", (n) => {
  writeFileSync(join(project, "project.json"), n % 4 === 0 ? mutateText(projectJson) : JSON.stringify(mutateJson(JSON.parse(projectJson))));
  new ProjectStore(registry, readProject(project, registry).doc);
});
failed += await fuzz("recording.json + cursor.jsonl", (n) => {
  writeFileSync(join(take, "recording.json"), n % 4 === 0 ? mutateText(recJson) : JSON.stringify(mutateJson(JSON.parse(recJson))));
  writeFileSync(join(take, "cursor.jsonl"), n % 3 === 0 ? mutateText(cursor) : cursor.split("\n").map((l) => (l && rand(3) === 0 ? JSON.stringify(mutateJson(JSON.parse(l))) : l)).join("\n"));
  recording(take);
  loadBrecCursor(take);
});
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
