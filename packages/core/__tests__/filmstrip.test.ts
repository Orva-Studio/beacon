import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type Filmstrip } from "@beacon/media";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const TREC = join(FIXTURES, "recording-2.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-filmstrip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Grey pixels of a picture (`-vf` crops or scales it first), and its size. */
async function grey(file: string, vf: string, ...input: string[]): Promise<Uint8Array> {
  const p = Bun.spawn([tool("ffmpeg"), "-v", "error", ...input, "-i", file, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}
const differ = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + Math.abs(v - b[i]!), 0) / a.length;

/** The `k`th frame of a strip, cut out of its sprite. */
function cell(f: Filmstrip, strip: Filmstrip["fine"], k: number) {
  const per = f.cols * f.rows;
  const [col, row] = [(k % per) % f.cols, Math.floor((k % per) / f.cols)];
  return grey(strip.files[Math.floor(k / per)]!, `crop=${f.width}:${f.height}:${col * f.width}:${row * f.height}`);
}

test.skipIf(!existsSync(TREC))("a recording's screen and camera get filmstrips once their proxies are made: a frame a second and one every 10 s, each the frame shown at its time; cached for the next open", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "cache") });
  core.setAutomatic((analyzer) => analyzer !== "transcript");
  await core.setSettings({ autoProxy: { recording: true, video: true }, proxyMode: "fast" });
  const h = await core.create({ path: join(dir, "f.beproj") });
  const { assets } = await core.import(h, [TREC]);
  const order: string[] = [];
  core.watch(h, (e) => e.kind === "job" && e.job.asset === assets[0] && e.job.state !== "running" && order.push(`${e.job.kind} ${e.job.state}`));
  const started: string[] = [];
  core.watch(h, (e) => e.kind === "job" && e.job.state === "running" && e.job.progress === 0 && !started.includes(e.job.kind) && started.push(e.job.kind));
  // Fast makes two preview jobs at once: the filmstrip still waits for the proxy it reads.
  core.attachView(h, { offscreen: { width: 64, height: 36 } }, { silent: true, proxies: true });
  let strips: { streams: Record<number, Filmstrip> } | undefined;
  for (let i = 0; i < 1200 && !(strips = core.derived(h, assets[0]!, "filmstrip")); i++) await Bun.sleep(100);
  expect(strips).toBeDefined();
  expect(order.indexOf("proxy done")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("proxy done")).toBeLessThan(order.indexOf("filmstrip done"));
  expect(started.indexOf("filmstrip")).toBeGreaterThan(started.indexOf("proxy"));

  // 105 s: two sprites of 60 a second, one of 60 every 10 s; 72 px tall, the stream's shape.
  const [screen, camera] = [strips!.streams[0]!, strips!.streams[1]!];
  expect([screen.width, screen.height, camera.width, camera.height]).toEqual([110, 72, 128, 72]);
  for (const f of [screen, camera]) expect([f.fine.files.length, f.coarse.files.length]).toEqual([2, 1]);

  // Each frame is the screen at its time: closer to the original there than to the original 5 s away.
  const original = (t: number) => grey(TREC, `scale=${screen.width}:${screen.height}:flags=area`, "-ss", String(t));
  for (const [strip, k] of [[screen.fine, 70], [screen.fine, 12], [screen.coarse, 9]] as const) {
    const t = k * strip.every;
    const thumb = await cell(screen, strip, k);
    const [here, away] = [differ(thumb, await original(t)), differ(thumb, await original(t > 50 ? t - 5 : t + 5))];
    expect(here).toBeLessThan(8);
    expect(here).toBeLessThan(away);
  }
  await core.close(h);

  // Reopened, the filmstrip is read from the cache: no job runs.
  const again = new LocalCore({ cacheDir: join(dir, "cache") });
  again.setAutomatic((analyzer) => analyzer !== "transcript");
  const h2 = await again.open(join(dir, "f.beproj"));
  again.attachView(h2, { offscreen: { width: 64, height: 36 } }, { silent: true, proxies: true });
  expect(again.derived<object>(h2, assets[0]!, "filmstrip")).toEqual(strips!);
  expect((await again.jobs()).filter((j) => j.kind === "filmstrip")).toEqual([]);
  await again.close(h2);
}, 180_000);
