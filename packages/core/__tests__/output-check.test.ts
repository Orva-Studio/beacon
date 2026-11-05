import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const IMAGE = join(FIXTURES, "image.png");
const dir = mkdtempSync(join(tmpdir(), "beacon-output-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!existsSync(IMAGE))("an export can't reach a project folder or the project's media through a link", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config") });
  const project = join(dir, "p.beproj");
  const h = await core.create({ path: project });
  const image = join(dir, "still.png");
  copyFileSync(IMAGE, image);
  await core.import(h, [image]);
  try {
    // A folder outside, linked to the project's own folder.
    symlinkSync(project, join(dir, "looks-outside"));
    await expect(core.export(h, { output: join(dir, "looks-outside", "out.mp4") })).rejects.toThrow("write outside project folders");
    // A file outside, linked to the media it would overwrite.
    mkdirSync(join(dir, "exports"));
    symlinkSync(image, join(dir, "exports", "frame.png"));
    await expect(core.export(h, { output: join(dir, "exports", "frame.png"), overwrite: true })).rejects.toThrow("is media used by the project");
  } finally {
    await core.close(h);
  }
});

test("Save As copies a project's link to a folder outside it as a link, not what it points at", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache-s"), configDir: join(dir, "config-s") });
  const project = join(dir, "linked.beproj");
  const h = await core.create({ path: project });
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "id_ed25519"), "private");
  symlinkSync(secrets, join(project, "keys"));
  try {
    const copy = await core.saveAs(h, join(dir, "copy.beproj"));
    expect(lstatSync(join(copy, "keys")).isSymbolicLink()).toBe(true);
  } finally {
    await core.close(h);
  }
});
