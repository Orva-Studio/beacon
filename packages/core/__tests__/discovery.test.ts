import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appProjects, LocalCore, serveCore } from "../src";

const dir = mkdtempSync(join(tmpdir(), "beacon-discovery-"));
afterAll(() => {
  delete process.env.BEACON_SOCKET;
  rmSync(dir, { recursive: true, force: true });
});

test("project discovery asks each app only `hello`, and an app that never answers doesn't hold it up", async () => {
  // Accepts the connection and says nothing, as a frozen app would.
  const hung = join(dir, "hung.sock");
  const listener = Bun.listen({ unix: hung, socket: { data() {} } });
  process.env.BEACON_SOCKET = hung;
  const t0 = performance.now();
  expect(await appProjects()).toEqual([]);
  expect(performance.now() - t0).toBeLessThan(3000);
  listener.stop(true);

  const project = join(dir, "open.beproj");
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  await core.close(await core.create({ path: project }));
  const healthy = join(dir, "app.sock");
  const server = serveCore(core, { path: healthy, projects: () => [project] });
  process.env.BEACON_SOCKET = healthy;
  expect(await appProjects()).toEqual([project]);
  server.stop();
});
