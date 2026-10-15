import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const dir = mkdtempSync(join(tmpdir(), "beacon-portable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stored = (project: string) => JSON.parse(readFileSync(join(project, "project.json"), "utf8"));

async function importQuietly(core: LocalCore, h: string, files: string[]) {
  const r = await core.import(h, files);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  return r;
}

test.skipIf(!existsSync(VIDEO))("media inside a project is stored relative to it, so a copied project keeps it; outside media stays absolute", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const from = join(dir, "Original.beproj");
  const h = await core.create({ path: from });
  mkdirSync(join(from, "media"));
  copyFileSync(VIDEO, join(from, "media", "inside.mp4"));
  const [inside, outside] = (await importQuietly(core, h, [join(from, "media", "inside.mp4"), VIDEO])).assets as [string, string];
  await core.close(h);

  const disk = stored(from);
  expect(disk.schemaVersion).toBe(2);
  expect(disk.assets[inside].path).toBe("media/inside.mp4");
  expect(disk.assets[outside].path).toBe(VIDEO);

  const to = join(dir, "Copy.beproj");
  cpSync(from, to, { recursive: true });
  rmSync(join(to, "lock"), { force: true });
  const copy = await core.open(to);
  expect(core.doc(copy).assets[inside]!.path).toBe(join(to, "media", "inside.mp4"));
  expect(await core.missing(copy)).toEqual([]);
  await core.close(copy);
}, 60_000);

test.skipIf(!existsSync(VIDEO))("a schema 1 project, its paths all absolute, is migrated on open: inside paths become relative on disk", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const project = join(dir, "Old.beproj");
  const h = await core.create({ path: project });
  mkdirSync(join(project, "media"));
  copyFileSync(VIDEO, join(project, "media", "clip.mp4"));
  const [asset] = (await importQuietly(core, h, [join(project, "media", "clip.mp4")])).assets as [string];
  await core.close(h);

  const v1 = stored(project);
  v1.schemaVersion = 1;
  v1.assets[asset].path = join(project, "media", "clip.mp4");
  writeFileSync(join(project, "project.json"), JSON.stringify(v1));

  const again = await core.open(project);
  expect(core.doc(again).assets[asset]!.path).toBe(join(project, "media", "clip.mp4"));
  const disk = stored(project);
  expect(disk.schemaVersion).toBe(2);
  expect(disk.assets[asset].path).toBe("media/clip.mp4");
  await core.close(again);
}, 60_000);
