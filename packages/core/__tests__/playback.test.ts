import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AudioOutput } from "@beacon/media";
import { DEFAULT_CACHE_DIR } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const SMALL = join(FIXTURES, "small.cmproj");
const dir = mkdtempSync(join(tmpdir(), "ot-playback-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The cache moved from ~/Library/Caches/opentasia to .../Beacon with its proxy records still
// pointing at the old folder, and playing drew nothing while the playhead moved (2026-10-13).
test.skipIf(!existsSync(SMALL))(
  "playing draws frames when proxy records point at a moved cache or at files that can't be read",
  async () => {
    const cache = join(dir, "cache");
    mkdirSync(join(cache, "derived"), { recursive: true });
    mkdirSync(join(cache, "proxies"), { recursive: true });
    for (const f of readdirSync(DEFAULT_CACHE_DIR)) if (f.startsWith("frames-")) cpSync(join(DEFAULT_CACHE_DIR, f), join(cache, f));

    const core = new LocalCore({ cacheDir: cache });
    const h = await core.create({ path: join(dir, "small.beproj"), cmproj: SMALL });
    const doc = core.doc(h);
    const def = core.registry.jobAnalyzers.get("proxy")!;
    const records: string[] = [];
    for (const asset of Object.values(doc.assets)) {
      if (!def.applies(asset)) continue;
      const key = new Bun.CryptoHasher("sha256").update(`${asset.path}\0${asset.fingerprint}`).digest("hex").slice(0, 16);
      const videos = (asset.derived.media as { streams: { kind: string }[] }).streams.filter((s) => s.kind === "video");
      const streams = Object.fromEntries(
        videos.map((_, i) => {
          const name = `${key}-v${i}.hevc.mp4`;
          // Moved into the new cache folder, but empty: it can't be decoded either.
          writeFileSync(join(cache, "proxies", name), "");
          return [i, { path: join(dir, "old-cache/proxies", name), factor: 0.5 }];
        }),
      );
      const record = join(cache, "derived", `proxy-v${def.version}-${key}.json`);
      writeFileSync(record, JSON.stringify({ streams, audio: {} }));
      records.push(record);
    }
    expect(records.length).toBeGreaterThan(0);

    const view = core.attachView(h, { offscreen: { width: 640, height: 360 } }, { silent: true, proxies: false });
    view.show(10);
    view.flush();
    // Only records of what is on screen are read.
    expect(records.filter((r) => readFileSync(r, "utf8").includes(join(cache, "proxies"))).length).toBeGreaterThan(0);

    const before = view.stats()!;
    view.play(10);
    await Bun.sleep(2000);
    view.pause();
    const after = view.stats()!;
    expect(after.shown - before.shown).toBeGreaterThan(45);
    expect(after.seq).toBeGreaterThan(before.seq + 45);
    core.detachView(h);
    await core.close(h);
  },
  120_000,
);

test("the audio clock says how far ahead of what is heard its sound has gone, so a new speed doesn't repeat it", async () => {
  const out = new AudioOutput();
  try {
    // An empty mix plays silence, so nothing is heard, but the device's clock and latency are real.
    out.play([], 10);
    await Bun.sleep(300);
    const heard = out.time()!;
    const sent = out.halt()!;
    expect(heard).toBeGreaterThan(10);
    expect(sent).toBeGreaterThanOrEqual(heard);
    expect(sent - heard).toBeLessThan(1);
    // Halting stopped it.
    expect(out.time()).toBeUndefined();
    expect(out.halt()).toBeUndefined();
  } finally {
    out.close();
  }
});

test("a seek while playing starts where it says, even close to where playback was", async () => {
  const core = new LocalCore({ cacheDir: join(dir, "seek-cache") });
  const h = await core.create({ path: join(dir, "seek.beproj") });
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 0, duration: 5 });
  const view = core.attachView(h, { offscreen: { width: 320, height: 180 } }, { silent: true, proxies: false });
  try {
    view.play(1, 1);
    await Bun.sleep(300);
    // 0.2 s back, within what a change of speed would treat as "where playback is".
    view.play(1.1, 1);
    await Bun.sleep(60);
    const playhead = (await core.session(h)).playhead;
    expect(playhead).toBeGreaterThanOrEqual(1.1);
    expect(playhead).toBeLessThan(1.25);
  } finally {
    view.pause();
    view.close();
    await core.close(h);
  }
});
