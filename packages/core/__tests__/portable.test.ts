import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const CMPROJ = join(FIXTURES, "small.cmproj");

test.skipIf(!existsSync(VIDEO))("a standalone project copies imports into its media folder; the original stays where it was", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const project = join(dir, "Standalone.beproj");
  const h = await core.create({ path: project, standalone: true });
  expect(core.doc(h).settings.standalone).toBe(true);
  const [asset] = (await importQuietly(core, h, [VIDEO])).assets as [string];
  const a = core.doc(h).assets[asset]!;
  expect(a.path).toBe(join(project, "media", "video.mp4"));
  expect(existsSync(a.path) && existsSync(VIDEO)).toBe(true);
  // A second import of the same file gets a name of its own.
  const [again] = (await importQuietly(core, h, [VIDEO])).assets as [string];
  expect(core.doc(h).assets[again]!.path).toBe(join(project, "media", "video 2.mp4"));
  await core.close(h);
  expect(stored(project).assets[asset].path).toBe("media/video.mp4");
}, 60_000);

test.skipIf(!existsSync(VIDEO))("turning standalone on copies in what is outside, as one undo step", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const project = join(dir, "Later.beproj");
  const h = await core.create({ path: project });
  const [asset] = (await importQuietly(core, h, [VIDEO])).assets as [string];
  expect(core.doc(h).assets[asset]!.path).toBe(VIDEO);
  const fingerprint = core.doc(h).assets[asset]!.fingerprint;

  await expect(core.transaction(h, "both", [{ command: "project.settings.set", args: { standalone: true } }])).rejects.toThrow("on its own");
  const r = await core.run(h, "project.settings.set", { standalone: true });
  expect(r.label).toBe("Make Project Standalone");
  const copy = join(project, "media", "video.mp4");
  expect(core.doc(h).assets[asset]!.path).toBe(copy);
  // Its times are kept, so it is the same media to the cache and to Locate.
  expect(core.doc(h).assets[asset]!.fingerprint).toBe(fingerprint);
  expect(existsSync(copy)).toBe(true);

  await core.undo(h);
  expect(core.doc(h).settings.standalone).toBeUndefined();
  expect(core.doc(h).assets[asset]!.path).toBe(VIDEO);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(CMPROJ))("a standalone project made from a Camtasia project copies the media it uses", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const project = join(dir, "FromCamtasia.beproj");
  const h = await core.create({ path: project, cmproj: CMPROJ, standalone: true });
  const assets = Object.values(core.doc(h).assets);
  expect(assets.length).toBeGreaterThan(0);
  const missing = new Set(await core.missing(h));
  const found = assets.filter((a) => !missing.has(a.id));
  expect(found.length).toBeGreaterThan(0);
  for (const a of found) expect(a.path.startsWith(join(project, "media") + "/")).toBe(true);
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(VIDEO))("Save As copies the project with what is inside it; standalone, outside media too; Show in Finder reveals the folder", async () => {
  const revealed: string[] = [];
  const core = new LocalCore({ cacheDir: join(dir, "cache"), reveal: (p) => revealed.push(p) });
  const from = join(dir, "Episode.beproj");
  const h = await core.create({ path: from });
  mkdirSync(join(from, "recordings", "take.brec"), { recursive: true });
  copyFileSync(VIDEO, join(from, "recordings", "take.brec", "screen.mp4"));
  const [inside, outside] = (await importQuietly(core, h, [join(from, "recordings", "take.brec", "screen.mp4"), VIDEO])).assets as [string, string];
  await core.run(h, "project.settings.set", { background: "#112233" });

  await expect(core.saveAs(h, join(from, "inner.beproj"))).rejects.toThrow("inside itself");
  const plain = await core.saveAs(h, join(dir, "Episode copy.beproj"));
  expect(existsSync(join(plain, "lock"))).toBe(false);
  const a = await core.open(plain);
  expect(core.doc(a).settings.background).toBe("#112233");
  expect(core.doc(a).assets[inside]!.path).toBe(join(plain, "recordings", "take.brec", "screen.mp4"));
  expect(core.doc(a).assets[outside]!.path).toBe(VIDEO);
  expect(await core.missing(a)).toEqual([]);
  await core.close(a);

  const whole = await core.saveAs(h, join(dir, "Episode to share.beproj"), { standalone: true });
  await expect(core.saveAs(h, whole)).rejects.toThrow("already exists");
  const b = await core.open(whole);
  expect(core.doc(b).settings.standalone).toBe(true);
  expect(core.doc(b).assets[outside]!.path).toBe(join(whole, "media", "video.mp4"));
  expect(stored(whole).assets[outside].path).toBe("media/video.mp4");
  await core.reveal(b);
  expect(revealed).toEqual([whole]);
  await core.close(b);

  // The original is untouched and still open.
  expect(core.doc(h).assets[outside]!.path).toBe(VIDEO);
  expect(core.doc(h).settings.standalone).toBeUndefined();
  await core.close(h);
}, 60_000);

test.skipIf(!existsSync(VIDEO))("a standalone project copies what a link points at, and its Save As copies nothing twice", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  const original = join(dir, "elsewhere.mp4");
  copyFileSync(VIDEO, original);
  const link = join(dir, "link.mp4");
  symlinkSync(original, link);
  const project = join(dir, "Linked.beproj");
  const h = await core.create({ path: project, standalone: true });
  const [asset] = (await importQuietly(core, h, [link])).assets as [string];
  const copy = join(project, "media", "link.mp4");
  expect(core.doc(h).assets[asset]!.path).toBe(copy);
  expect(lstatSync(copy).isSymbolicLink()).toBe(false);
  rmSync(original);
  expect(await core.missing(h)).toEqual([]);

  let from = h;
  for (const name of ["Linked 2.beproj", "Linked 3.beproj"]) {
    const to = await core.saveAs(from, join(dir, name));
    expect(readdirSync(join(to, "media"))).toEqual(["link.mp4"]);
    expect(stored(to).assets[asset].path).toBe("media/link.mp4");
    if (from !== h) await core.close(from);
    from = await core.open(to);
    expect(await core.missing(from)).toEqual([]);
  }
  await core.close(from);
  await core.close(h);
}, 60_000);
