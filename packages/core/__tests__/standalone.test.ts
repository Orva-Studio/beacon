import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CMPROJ = join(process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures"), "small.cmproj");
const dir = mkdtempSync(join(tmpdir(), "beacon-standalone-"));

// A copy that fails half way, as a full disk would: one file in, then an error.
const real = { ...(await import("../src/media-copy")) };
mock.module("../src/media-copy", () => ({
  ...real,
  copyIntoProject: async (project: string) => {
    mkdirSync(join(project, "media"), { recursive: true });
    writeFileSync(join(project, "media", "half.trec"), "");
    throw new Error("No space left on device");
  },
}));
// Module mocks last for the whole run: later test files get the real copy back.
afterAll(() => {
  mock.module("../src/media-copy", () => real);
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!existsSync(CMPROJ))("a standalone project whose media copy fails leaves no folder behind, so it can be tried again", async () => {
  const { LocalCore } = await import("../src");
  const core = new LocalCore({ configDir: join(dir, "config") });
  const path = join(dir, "Standalone.beproj");
  await expect(core.create({ path, cmproj: CMPROJ, standalone: true })).rejects.toThrow("No space left on device");
  expect(existsSync(path)).toBe(false);
});
