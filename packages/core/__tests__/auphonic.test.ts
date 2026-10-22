import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const RECORDING = join(FIXTURES, "recording.trec");
const dir = mkdtempSync(join(tmpdir(), "beacon-auphonic-"));

/**
 * Auphonic's API as tuneup uses it, standing in for the real one (which charges). "Echo" sends back what it was
 * given as Auphonic's encoder does (44.1 kHz stereo, 46 ms of padding before, 100 ms after), so it must be lined up
 * here; "Cutter" trims a second off, as a preset that cuts silences would, and "Snipper" 0.3 s from the middle (at 100 s).
 */
const uploads: { preset: string; key: string }[] = [];
const uploadedNames: string[] = [];
const downloaded: string[] = [];
let stalled = false;
let polls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = req.headers.get("authorization") ?? "";
    if (key !== "Bearer test-key") return new Response("bad key", { status: 401 });
    if (url.pathname === "/presets.json") return Response.json({ data: [{ uuid: "p-echo", preset_name: "Echo" }, { uuid: "p-cut", preset_name: "Cutter" }, { uuid: "p-snip", preset_name: "Snipper" }] });
    if (url.pathname === "/simple/productions.json") {
      const form = await req.formData();
      const preset = String(form.get("preset"));
      // As Auphonic does: whatever is sent (an M4A) comes back as a WAV.
      const sent = form.get("input_file") as File;
      uploadedNames.push(sent.name);
      await Bun.write(join(dir, "uploaded.m4a"), sent);
      Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-i", join(dir, "uploaded.m4a"), join(dir, "uploaded.wav")]);
      uploads.push({ preset, key });
      return Response.json({ data: { uuid: `prod-${preset}` } });
    }
    const m = url.pathname.match(/^\/production\/(prod-[\w-]+)(\/status|\/start)?\.json$/);
    if (m?.[2] === "/start") return Response.json({ data: {} });
    if (m?.[2] === "/status") return Response.json({ data: (polls++ % 2 ? { status: 3, status_string: "Done" } : { status: 1, status_string: "Audio Processing" }) });
    // As a real preset can: several formats, WAV listed first; Beacon takes the M4A.
    if (m) return Response.json({ data: { output_files: ["wav", "mp3", "m4a"].map((ext) => ({ format: ext, filename: `out.${ext}`, download_url: `${url.origin}/download/${m[1]}.${ext}` })) } });
    const got = url.pathname.match(/^\/download\/(prod-p-(?:echo|cut|snip))\.(\w+)$/);
    // The first download never answers, as a dropped connection didn't for the user: it's tried again.
    if (got && !stalled) {
      stalled = true;
      return new Promise<Response>(() => {});
    }
    if (got) {
      const out = join(dir, `${got[1]}.${got[2]}`);
      const cut = got[1] === "prod-p-cut" ? ["-ss", "1"] : [];
      let source = join(dir, "uploaded.wav");
      if (got[1] === "prod-p-snip") {
        // 0.3 s from 100 s out, by the samples (Beacon's FFmpeg has no filter for it).
        const raw = Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", source, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]).stdout;
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        await Bun.write(join(dir, "snip.pcm"), new Int16Array([...pcm.subarray(0, 100 * 48000), ...pcm.subarray(100.3 * 48000)]));
        Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", join(dir, "snip.pcm"), join(dir, "snip.wav")]);
        source = join(dir, "snip.wav");
      }
      Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-i", source, ...cut, "-af", "adelay=46:all=1,apad=pad_dur=0.1", "-ar", "44100", "-ac", "2", out]);
      downloaded.push(got[2]!);
      return new Response(Bun.file(out));
    }
    return new Response("not found", { status: 404 });
  },
});
process.env.BEACON_AUPHONIC_URL = server.url.origin;
process.env.BEACON_AUPHONIC_TIMEOUT_MS = "2000";
process.env.BEACON_AUPHONIC_POLL_MS = "10";
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const RATE = 8000;
const samples = (path: string) => new Float32Array(Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]).stdout.buffer);

test.skipIf(!existsSync(RECORDING))("Clean with Auphonic: the selected audio as heard goes up with the preset, and what comes back sits over it on a track of its own, the originals muted, one undo step; a preset that cuts is refused", async () => {
  const secrets = new Map<string, string>();
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const h = await core.create({ path: join(dir, "p.beproj") });
  const r = await core.import(h, [RECORDING]);
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const audio = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.type === "audio");
  await core.run(h, "selection.set", { clips: audio.map((c) => c.id), linked: false });
  const range = { from: 0, to: 8 };
  await (await core.export(h, { output: join(dir, "before.wav"), ...range })).done;

  // No key yet: the job says where to add one.
  const noKey = (await core.run(h, "audio.clean", { preset: "Echo" })).results.at(-1) as { job: string };
  await expect(waitJob(core, noKey.job)).rejects.toThrow(/no Auphonic API key: add one in Settings › Audio/);
  secrets.set("auphonic-api-key", "test-key");
  expect(((await core.query(h, "auphonic.presets", {})) as { name: string }[]).map((p) => p.name)).toEqual(["Echo", "Cutter", "Snipper"]);

  const steps = (await core.history(h)).undo.length;
  const started = (await core.run(h, "audio.clean", { preset: "Echo", polish: false })).results.at(-1) as { job: string };
  await waitJob(core, started.job);
  expect(uploads.at(-1)).toEqual({ preset: "p-echo", key: "Bearer test-key" });
  // An M4A goes up, not a WAV ten times its size.
  expect(uploadedNames.at(-1)).toEndWith(".m4a");
  const history = (await core.history(h)).undo;
  expect(history.length - steps).toBe(1);
  expect(history.at(-1)).toBe("Clean with Auphonic");
  const doc = core.doc(h);
  const cleaned = Object.values(doc.assets).find((a) => a.name?.endsWith("(Auphonic)"))!;
  expect(cleaned.path.startsWith(join(dir, "p.beproj", "media"))).toBe(true);
  expect(cleaned.path.endsWith(".cleaned.m4a")).toBe(true);
  // Lined up here: the sent audio's rate and length, Auphonic's padding gone.
  const probe = Bun.spawnSync([tool("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", cleaned.path]).stdout.toString().trim();
  expect(probe).toBe("48000");
  expect(downloaded.at(-1)).toBe("m4a");
  // It got there though the first download hung.
  expect(stalled).toBe(true);
  const placed = doc.tracks.flatMap((t) => t.clips).filter((c) => c.assetId === cleaned.id);
  expect(placed).toHaveLength(1);
  // On a new track right above the highest one it cleaned.
  const row = (id: string) => doc.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
  expect(row(placed[0]!.id)).toBe(Math.max(...audio.map((c) => row(c.id))) + 1);
  expect(doc.tracks[row(placed[0]!.id)]!.clips).toHaveLength(1);
  expect(ticksToSeconds(placed[0]!.start)).toBe(ticksToSeconds(Math.min(...audio.map((c) => c.start))));
  for (const c of audio) expect((doc.tracks.flatMap((t) => t.clips).find((x) => x.id === c.id)!.props.audio as { muted: boolean }).muted).toBe(true);
  expect((await core.session(h)).selection).toEqual([placed[0]!.id]);
  // Heard instead of the originals, it sounds the same, in step.
  await (await core.export(h, { output: join(dir, "after.wav"), ...range })).done;
  const [a, b] = [samples(join(dir, "before.wav")), samples(join(dir, "after.wav"))];
  expect(b.length).toBe(a.length);
  // An M4A goes up, so it comes back about a millisecond late (1/30 of a frame, inaudible): in step within 2 ms,
  // and once lined up as loud and the same, AAC's loss apart.
  let [lag, best] = [0, -Infinity];
  for (let d = -40; d <= 40; d++) {
    let sum = 0;
    for (let i = 40; i < a.length - 40; i++) sum += a[i]! * b[i + d]!;
    if (sum > best) [best, lag] = [sum, d];
  }
  expect(Math.abs(lag)).toBeLessThanOrEqual(RATE / 500);
  let [ea, eb] = [0, 0];
  for (let i = 40; i < a.length - 40; i++) [ea, eb] = [ea + a[i]! ** 2, eb + b[i + lag]! ** 2];
  expect(best / Math.sqrt(ea * eb)).toBeGreaterThan(0.98);
  expect(Math.abs(10 * Math.log10(eb / ea))).toBeLessThan(0.5);
  await core.undo(h);
  expect(core.doc(h).tracks.flatMap((t) => t.clips).some((c) => c.assetId === cleaned.id)).toBe(false);

  // With Polish, the cleaned clip has it.
  await core.run(h, "selection.set", { clips: audio.map((c) => c.id), linked: false });
  await waitJob(core, ((await core.run(h, "audio.clean", { preset: "p-echo" })).results.at(-1) as { job: string }).job);
  const polished = core.doc(h).tracks.flatMap((t) => t.clips).filter((c) => c.effects.some((e) => e.type === "polish"));
  expect(polished).toHaveLength(1);
  await core.undo(h);

  // A preset that cuts: refused, nothing placed, the file kept.
  await core.run(h, "selection.set", { clips: audio.map((c) => c.id), linked: false });
  const before = (await core.history(h)).undo.length;
  const cut = (await core.run(h, "audio.clean", { preset: "Cutter" })).results.at(-1) as { job: string };
  await expect(waitJob(core, cut.job)).rejects.toThrow(/turn off cutting.*kept as .*\.auphonic\.m4a/);
  expect((await core.history(h)).undo.length).toBe(before);
  // 0.3 s cut from the middle, the length nearly right: its end sits later than its start.
  const snip = (await core.run(h, "audio.clean", { preset: "Snipper" })).results.at(-1) as { job: string };
  await expect(waitJob(core, snip.job)).rejects.toThrow(/drifts \d+ ms from start to end/);
  expect((await core.history(h)).undo.length).toBe(before);

  // Moved while Auphonic cleans it: the result no longer fits, so it isn't placed; the file is kept, the move stands.
  const moving = (await core.run(h, "audio.clean", { preset: "Echo" })).results.at(-1) as { job: string };
  await core.run(h, "clip.move", { clip: audio[0]!.id, by: 1, linked: false });
  await expect(waitJob(core, moving.job)).rejects.toThrow(/edited while Auphonic cleaned it.*kept as .*\.cleaned/);
  expect((await core.history(h)).undo.length).toBe(before + 1);
  await core.undo(h);

  // Its sound changed while it cleans (the volume): refused as well.
  const louder = (await core.run(h, "audio.clean", { preset: "Echo" })).results.at(-1) as { job: string };
  await core.run(h, "clip.set", { clip: audio[0]!.id, props: { audio: { gain: 0.5 } } });
  await expect(waitJob(core, louder.job)).rejects.toThrow(/edited while Auphonic cleaned it/);
  await core.undo(h);
  // Its track muted while it cleans: refused, so the sound muted doesn't come back; on a muted track it isn't sent.
  const track = core.doc(h).tracks.find((t) => t.clips.some((c) => c.id === audio[0]!.id))!.id;
  const uploaded = uploads.length;
  const hushed = (await core.run(h, "audio.clean", { preset: "Echo" })).results.at(-1) as { job: string };
  while (uploads.length === uploaded) await Bun.sleep(10);
  await core.run(h, "track.set", { track, muted: true });
  await expect(waitJob(core, hushed.job)).rejects.toThrow(/edited while Auphonic cleaned it/);
  const sentBefore = uploads.length;
  await expect(core.run(h, "audio.clean", { preset: "Echo" })).rejects.toThrow(/select audio first/);
  expect(uploads.length).toBe(sentBefore);
  await core.undo(h);

  // Two cleans of the same audio at once: each its own file, but only the first placed (the second's originals
  // were muted by then).
  const twice = await Promise.all([1, 2].map(async () => ((await core.run(h, "audio.clean", { preset: "Echo", polish: false })).results.at(-1) as { job: string }).job));
  const ends = await Promise.allSettled(twice.map((job) => waitJob(core, job)));
  expect(ends.filter((e) => e.status === "fulfilled")).toHaveLength(1);
  expect(String((ends.find((e) => e.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/edited while Auphonic cleaned it/);
  const files = readdirSync(join(dir, "p.beproj", "media")).filter((f) => /\.cleaned( \d+)?\.m4a$/.test(f));
  expect(new Set(files).size).toBe(files.length);
  expect(Object.values(core.doc(h).assets).filter((a) => a.name?.endsWith("(Auphonic)"))).toHaveLength(1);
  await core.undo(h);

  // A group's audio, the group open: refused before anything is sent (the bounce would be silence, still charged).
  const group = (await core.run(h, "clip.group", { clips: audio.map((c) => c.id) })).results[0] as string;
  await core.run(h, "group.open", { clip: group });
  const sent = uploads.length;
  await expect(core.run(h, "audio.clean", { preset: "Echo", clips: [audio[0]!.id] })).rejects.toThrow(/main timeline/);
  expect(uploads.length).toBe(sent);
  await core.run(h, "group.close", {});
  await core.undo(h);
  await core.run(h, "selection.set", { clips: audio.map((c) => c.id), linked: false });

  // One panel at a time: a review opened over Clean with Auphonic closes it, and the other way round.
  const panels = async () => {
    const f = (await core.session(h)).features as { auphonic?: unknown; transcript?: { silences?: unknown } };
    return { auphonic: !!f.auphonic, silences: !!f.transcript?.silences };
  };
  await core.run(h, "auphonic.review", {});
  await core.run(h, "silences.review", {});
  expect(await panels()).toEqual({ auphonic: false, silences: true });
  await core.run(h, "auphonic.review", {});
  expect(await panels()).toEqual({ auphonic: true, silences: false });
  // Changing the open panel's settings keeps it open.
  await core.run(h, "auphonic.review", { polish: false });
  expect(await panels()).toEqual({ auphonic: true, silences: false });
  await core.run(h, "auphonic.close", {});
  await expect(core.run(h, "audio.clean", { preset: "Nope" }).then((x) => waitJob(core, (x.results.at(-1) as { job: string }).job))).rejects.toThrow(/no Auphonic preset "Nope"; there are: Echo, Cutter, Snipper/);
  await core.close(h);
}, 180_000);

async function waitJob(core: LocalCore, id: string) {
  for (;;) {
    const j = await core.job(id);
    if (j.state === "done") return j.result;
    if (j.state === "failed") throw new Error(j.error);
    await Bun.sleep(20);
  }
}
