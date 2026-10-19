import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCore, projectName } from "../src";
import { alive } from "../src/persist";

const IMAGE = join(process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures"), "image.png");
const dir = mkdtempSync(join(tmpdir(), "beacon-names-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("one check for a project's name, as rename, New Project and Save As take it", async () => {
  expect(projectName("  Episode 12.beproj ")).toBe("Episode 12");
  for (const bad of ["", "  ", ".hidden", "a/b", "a:b", ".beproj"]) expect(() => projectName(bad)).toThrow("can't be a project name");
  const core = new LocalCore({ configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "First.beproj") });
  await expect(core.rename(h, "a/b")).rejects.toThrow("can't be a project name");
  expect(await core.rename(h, "Second.beproj")).toBe(join(dir, "Second.beproj"));
});

test("a project with bad settings is refused before its folder is written", async () => {
  const core = new LocalCore({ configDir: join(dir, "config") });
  const path = join(dir, "Bad.beproj");
  await expect(core.create({ path, settings: { width: -5 } })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
});

test("a process of another user's (launchd) is alive, so its project lock and socket are kept", () => {
  expect(alive(1)).toBe(true);
  expect(alive(process.pid)).toBe(true);
});

test.skipIf(!existsSync(IMAGE))("an export makes its folder, after its checks", async () => {
  const core = new LocalCore({ configDir: join(dir, "config") });
  const h = await core.create({ path: join(dir, "Export.beproj") });
  const image = join(dir, "image.png");
  copyFileSync(IMAGE, image);
  await core.import(h, [image]);
  await expect(core.export(h, { output: join(dir, "Export.beproj", "inside", "out.mp4") })).rejects.toThrow("inside Export.beproj");
  expect(existsSync(join(dir, "Export.beproj", "inside"))).toBe(false);
  // One rule for core and the renderer: ProRes only in .mov.
  await expect(core.export(h, { output: join(dir, "prores.mp4"), codec: "prores" })).rejects.toThrow("ProRes exports to .mov, not .mp4");
  await expect(core.export(h, { output: join(dir, "prores.webm"), codec: "prores" })).rejects.toThrow("ProRes exports to .mov, not .webm");
  const out = join(dir, "new", "folder", "out.mp4");
  await (await core.export(h, { output: out, to: 0.2 })).done;
  expect(existsSync(out)).toBe(true);
  await core.close(h);
});

test("the schema gives each prop group's defaults, which the editor fills a clip's missing values from", () => {
  const props = new LocalCore({ configDir: join(dir, "config") }).schema().props;
  expect(props.find((p) => p.id === "audio")?.defaults).toEqual({ gain: 1, volume: 1, normalize: false });
  expect(props.find((p) => p.id === "border")?.defaults).toEqual({ thickness: 0, color: [1, 1, 1, 1] });
  expect(props.every((p) => p.defaults && typeof p.defaults === "object")).toBe(true);
});
