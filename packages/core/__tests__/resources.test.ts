import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURES } from "@beacon/features";
import { defineFeature, FeatureRegistry } from "@beacon/model";
import { LocalCore, type CoreEvent } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const VIDEO = join(FIXTURES, "video.mp4");
const IMAGE = join(FIXTURES, "image.png");
const dir = mkdtempSync(join(tmpdir(), "beacon-resources-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the speech model: a fixture served over file://, and an analysis of video that needs it. */
function registry(file: string, sha256: string) {
  const fake = defineFeature({
    id: "needs-a-model",
    version: 1,
    resources: [{ id: "test-model", title: "Test model", description: "For the test", url: `file://${file}`, sha256, bytes: statSync(file).size, folder: "models", file: "test.bin" }],
    jobAnalyzers: [
      {
        id: "uses-model",
        description: "Reads the model",
        version: 1,
        needs: "test-model",
        applies: (a) => a.kind === "video",
        analyze: async (_a, _p, env) => ({ modelBytes: statSync(env.resource("test-model")).size }),
      },
    ],
  });
  return new FeatureRegistry([...FEATURES, fake]);
}

test.skipIf(![VIDEO, IMAGE].every(existsSync))("an analysis whose resource isn't downloaded waits; the download is checked, and what waited starts after", async () => {
  const sha = createHash("sha256").update(readFileSync(IMAGE)).digest("hex");
  const cacheDir = join(dir, "cache");

  // A download whose hash isn't the one pinned is refused, and nothing is kept.
  const wrong = new LocalCore({ cacheDir, registry: registry(IMAGE, "0".repeat(64)) });
  await expect(wrong.fetchResource("test-model").then((j) => j.done)).rejects.toThrow("SHA-256");
  expect(existsSync(join(cacheDir, "models", "test.bin"))).toBe(false);
  expect(existsSync(join(cacheDir, "models", "test.bin.part"))).toBe(false);

  const core = new LocalCore({ cacheDir, registry: registry(IMAGE, sha) });
  expect(await core.resources()).toContainEqual(expect.objectContaining({ id: "test-model", present: false }));
  const h = await core.create({ path: join(dir, "p.beproj") });
  const events: CoreEvent[] = [];
  core.watch(h, (e) => events.push(e));
  const r = await core.import(h, [VIDEO]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  expect(r.needs).toContain("test-model");
  expect(events.find((e) => e.kind === "needs")).toMatchObject({ resource: { id: "test-model", present: false } });
  await expect(core.analyze(h, "uses-model", r.assets[0]!)).rejects.toThrow("isn't downloaded");

  const job = await core.fetchResource("test-model");
  expect((await core.fetchResource("test-model")).id).toBe(job.id);
  await job.done;
  expect(await core.resources()).toContainEqual(expect.objectContaining({ id: "test-model", present: true }));
  // The analysis that waited has started on its own.
  const started = (await core.jobs()).find((j) => j.kind === "uses-model" && j.asset === r.assets[0]);
  expect(started).toBeDefined();
  await (await core.analyze(h, "uses-model", r.assets[0]!)).done;
  expect(core.derived<{ modelBytes: number }>(h, r.assets[0]!, "uses-model")).toEqual({ modelBytes: statSync(IMAGE).size });
  await core.close(h);
}, 60_000);
