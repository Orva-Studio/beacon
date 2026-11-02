import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@beacon/media";
import { ticksToSeconds } from "@beacon/model";
import { DerivedData } from "@beacon/render";
import { LocalCore } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AUDIO = join(FIXTURES, "audio.m4a");
const dir = mkdtempSync(join(tmpdir(), "beacon-music-"));

/** A steady tone `seconds` long, so the mix's level shows the music's volume and nothing else (Beacon's FFmpeg has no lavfi). */
function tone(path: string, seconds: number) {
  const pcm = Float32Array.from({ length: seconds * 48000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const r = Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-ac", "2", path], { stdin: new Uint8Array(pcm.buffer) });
  if (r.exitCode) throw new Error(r.stderr.toString());
}
tone(join(dir, "track.mp3"), 30);
tone(join(dir, "whoosh.wav"), 0.5);

/**
 * Epidemic Sound's MCP server, standing in for the real one (downloads count against a subscription): answers as
 * server-sent events, as it does; an edit is the track cut to the length asked for, ready on the second poll.
 */
const calls: { tool: string; args: any }[] = [];
let polls = 0;
const edits = new Map<string, number>();
const sse = (id: unknown, result: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } });
const answer = (id: unknown, data: unknown) => sse(id, { content: [{ type: "text", text: JSON.stringify({ data }) }] });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/files/")) {
      const m = url.pathname.match(/^\/files\/edit-(\d+(?:\.\d+)?)\.mp3$/);
      if (m) {
        const out = join(dir, `edit-${m[1]}.mp3`);
        Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-i", join(dir, "track.mp3"), "-t", m[1]!, out]);
        return new Response(Bun.file(out));
      }
      return new Response(Bun.file(join(dir, url.pathname.slice(7))));
    }
    if (req.headers.get("authorization") !== "Bearer es-key") return new Response("", { status: 401 });
    const body = (await req.json()) as { id?: number; method: string; params?: any };
    if (body.method === "initialize") return sse(body.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "0" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (req.headers.get("mcp-session-id") !== "s-1") return new Response("no session", { status: 400 });
    const { name, arguments: args } = body.params;
    calls.push({ tool: name, args });
    const audioFile = (ms: number, file: string) => ({ durationInMilliseconds: ms, lqmp3Url: `${url.origin}/files/${file}`, waveformUrl: "" });
    if (name === "SearchRecordings")
      return answer(body.id, {
        recordings: {
          nodes: [
            {
              recording: {
                id: "rec-1",
                title: "Bright Days",
                bpm: 120,
                coverArtUrl: "https://example.com/3000x3000.png",
                audioFile: audioFile(30_000, "track.mp3"),
                credits: [{ role: "COMPOSER", artist: { name: "Someone" } }, { role: "MAIN_ARTIST", artist: { name: "The Band" } }],
                stems: [{ type: "VOCALS" }, { type: "DRUMS" }],
                tags: [{ displayName: "happy", dimension: { name: "mood" } }, { displayName: "pop", dimension: { name: "genre" } }],
              },
            },
          ],
          meta: { total: 41 },
          pageInfo: { hasNextPage: true, endCursor: "c-2" },
        },
      });
    if (name === "SearchSoundEffects") return answer(body.id, { soundEffects: { nodes: [{ soundEffect: { id: "sfx-1", title: "Whoosh", audioFile: audioFile(500, "whoosh.wav") } }], meta: { total: 1 }, pageInfo: { hasNextPage: false } } });
    if (name === "DownloadRecording") return answer(body.id, { recordingDownload: { assetUrl: `${url.origin}/files/track.mp3` } });
    if (name === "DownloadSoundEffect") return answer(body.id, { soundEffectDownload: { assetUrl: `${url.origin}/files/whoosh.wav` } });
    if (name === "EditRecording") {
      edits.set("job-1", args.input.targetDurationMs / 1000);
      return answer(body.id, { recordingEdit: { id: "job-1", status: "PENDING" } });
    }
    if (name === "PollEditRecordingJob") return answer(body.id, { recordingEditJob: polls++ % 2 ? { id: args.id, status: "COMPLETED", edits: [{ id: "edit-1", durationMs: edits.get(args.id)! * 1000 }] } : { id: args.id, status: "IN_PROGRESS" } });
    if (name === "DownloadRecordingEdit") return answer(body.id, { recordingEditDownload: { assetUrl: `${url.origin}/files/edit-${edits.get(args.input.jobId)}.mp3` } });
    return sse(body.id, { isError: true, content: [{ type: "text", text: `no tool ${name}` }] });
  },
});
process.env.BEACON_EPIDEMIC_URL = `${server.url.origin}/mcp`;
process.env.BEACON_EPIDEMIC_POLL_MS = "10";
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function waitJob(core: LocalCore, id: string) {
  for (;;) {
    const j = await core.job(id);
    if (j.state === "done") return j.result;
    if (j.state === "failed") throw new Error(j.error);
    await Bun.sleep(20);
  }
}

const RATE = 8000;
const samples = (path: string) => {
  const raw = Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]).stdout;
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
};
const level = (s: Float32Array, a: number, b: number) => {
  const part = s.subarray(a * RATE, b * RATE);
  return 10 * Math.log10(part.reduce((e, v) => e + v * v, 0) / part.length);
};

test.skipIf(!existsSync(AUDIO))("Music from Epidemic Sound: searched with the user's key, a track fitted to the range on a Music track at the bottom and ducked under speech, cut and faded when asked; a sound effect at the playhead; nothing of theirs transcribed", async () => {
  const secrets = new Map<string, string>();
  const core = new LocalCore({ cacheDir: join(dir, "cache"), configDir: join(dir, "config"), secrets: { get: async (id) => secrets.get(id), set: async (id, v) => void (v === null ? secrets.delete(id) : secrets.set(id, v)) } });
  const h = await core.create({ path: join(dir, "p.beproj") });
  copyFileSync(AUDIO, join(dir, "talk.m4a"));
  const r = await core.import(h, [join(dir, "talk.m4a")], { at: 0 });
  for (const j of r.jobs) await core.cancelJob(j).catch(() => {});
  const talk = core.doc(h).assets[r.assets[0]!]!;
  // Speech from 2 s to 5 s and 7 s to 9 s.
  mkdirSync(join(core.cacheDir, "derived"), { recursive: true });
  writeFileSync(new DerivedData(core.registry, core.cacheDir, () => ({}) as never).cacheFile(talk, core.registry.jobAnalyzers.get("transcript")!), JSON.stringify({ streams: { 0: { model: "test", language: "en", words: [], speech: [[2, 5], [7, 9]] } } }));

  await expect(core.query(h, "music.search", { term: "happy" })).rejects.toThrow(/no Epidemic Sound key: add one in Settings › AI/);
  secrets.set("epidemic-sound-api-key", "wrong");
  await expect(core.query(h, "music.search", { term: "happy" })).rejects.toThrow(/refused the key: check it in Settings › AI/);
  secrets.set("epidemic-sound-api-key", "es-key");
  const found = (await core.query(h, "music.search", { term: "happy", moods: ["happy"], length: { min: 20 } })) as any;
  expect(found).toEqual({
    items: [{ id: "rec-1", title: "Bright Days", artist: "The Band", ms: 30_000, bpm: 120, preview: `${server.url.origin}/files/track.mp3`, cover: "https://example.com/300x300.png", moods: ["happy"], genres: ["pop"], vocals: true }],
    total: 41,
    next: "c-2",
  });
  expect(calls.at(-1)!.args).toEqual({ query: { term: "happy" }, filter: { duration: { min: 20_000, max: null }, moodSlugs: { matchType: "ANY", values: ["happy"] } }, first: 20 });

  // Over the range 0–10 s: Epidemic re-cuts it to 10 s.
  await core.run(h, "range.set", { in: 0, out: 10 });
  const steps = (await core.history(h)).undo.length;
  const added = (await core.run(h, "music.add", { id: "rec-1", title: "Bright Days" })).results.at(-1) as { job: string };
  await waitJob(core, added.job);
  expect(calls.find((c) => c.tool === "EditRecording")!.args).toEqual({ id: "rec-1", input: { targetDurationMs: 10_000, downloadAudioFormat: "MP3", forceDuration: true, skipStems: true, maxResults: 1 } });
  let doc = core.doc(h);
  expect((await core.history(h)).undo.length - steps).toBe(1);
  expect(doc.tracks[0]!.name).toBe("Music");
  const fitted = doc.tracks[0]!.clips[0]!;
  expect([ticksToSeconds(fitted.start), ticksToSeconds(fitted.duration)]).toEqual([0, 10]);
  const asset = doc.assets[fitted.assetId!]!;
  expect(asset.name).toBe("Bright Days");
  expect(asset.path).toBe(join(dir, "p.beproj", "media", "Bright Days (Epidemic Sound).mp3"));
  expect(asset.derived.library).toEqual({ source: "epidemic", kind: "music", id: "rec-1", title: "Bright Days", version: "edit:10.00" });
  // Library audio isn't transcribed: a song's words would become captions.
  expect(core.registry.jobAnalyzers.get("transcript")!.applies(asset)).toBe(false);
  expect((await core.session(h)).selection).toEqual([fitted.id]);

  // In the export, with the talk muted: at the full level where no one speaks, 0.18 / 0.5 of it under speech.
  const talkTrack = doc.tracks.find((t) => t.clips.some((c) => c.assetId === talk.id))!;
  await core.run(h, "track.set", { track: talkTrack.id, muted: true });
  await (await core.export(h, { output: join(dir, "mix.wav"), from: 0, to: 10 })).done;
  const mix = samples(join(dir, "mix.wav"));
  const dip = 20 * Math.log10(0.18 / 0.5);
  for (const [a, b] of [[3, 4.5], [7.5, 8.5]] as const) expect(level(mix, a, b) - level(mix, 0.5, 1.5)).toBeCloseTo(dip, 0);
  expect(level(mix, 5.5, 6.5) - level(mix, 0.5, 1.5)).toBeCloseTo(0, 0);
  await core.run(h, "track.set", { track: talkTrack.id, muted: false });

  // Cut to fit: the full track (30 s) cut at the range's end and faded out over its last second.
  await core.run(h, "range.set", { in: 12, out: 20 });
  const before = calls.length;
  await waitJob(core, ((await core.run(h, "music.add", { id: "rec-1", title: "Bright Days", fit: "cut" })).results.at(-1) as { job: string }).job);
  expect(calls.slice(before).map((c) => c.tool)).toEqual(["DownloadRecording"]);
  doc = core.doc(h);
  const cut = doc.tracks[0]!.clips.find((c) => c.id !== fitted.id)!;
  expect([ticksToSeconds(cut.start), ticksToSeconds(cut.duration)]).toEqual([12, 8]);
  // Both on the one Music track, which had room.
  expect(doc.tracks.filter((t) => t.name === "Music").length).toBe(1);
  await core.run(h, "track.set", { track: talkTrack.id, muted: true });
  await (await core.export(h, { output: join(dir, "cut.wav"), from: 12, to: 20 })).done;
  const faded = samples(join(dir, "cut.wav"));
  expect(level(faded, 7.9, 8)).toBeLessThan(level(faded, 6, 6.9) - 20);
  await core.run(h, "track.set", { track: talkTrack.id, muted: false });

  // The same version again is in the project already: placed at once, no download.
  await core.run(h, "range.set", { in: 22, out: 30 });
  const again = calls.length;
  const direct = await core.run(h, "music.add", { id: "rec-1", fit: "cut" });
  expect(direct.results.at(-1)).not.toHaveProperty("job");
  expect(calls.length).toBe(again);

  // A sound effect at the playhead, not the range, on an SFX track on top.
  await core.run(h, "playhead.set", { time: 3 });
  const sfx = (await core.query(h, "sfx.search", { term: "whoosh" })) as any;
  expect(sfx.items).toEqual([{ id: "sfx-1", title: "Whoosh", ms: 500, preview: `${server.url.origin}/files/whoosh.wav` }]);
  await waitJob(core, ((await core.run(h, "music.add", { id: "sfx-1", kind: "sfx", title: "Whoosh" })).results.at(-1) as { job: string }).job);
  doc = core.doc(h);
  expect(doc.tracks.at(-1)!.name).toBe("SFX");
  expect(ticksToSeconds(doc.tracks.at(-1)!.clips[0]!.start)).toBe(3);
  expect(doc.assets[doc.tracks.at(-1)!.clips[0]!.assetId!]!.path.endsWith("Whoosh (Epidemic Sound).wav")).toBe(true);

  // Ducked again flat, then undone.
  await core.run(h, "music.duck", { clips: [fitted.id], duck: false, level: 0.4 });
  expect(core.doc(h).tracks[0]!.clips[0]!.animations.length).toBe(0);
  expect((core.doc(h).tracks[0]!.clips[0]!.props.audio as { volume: number }).volume).toBe(0.4);
  await core.undo(h);
  expect(core.doc(h).tracks[0]!.clips[0]!.animations.length).toBeGreaterThan(0);

  // The panel: Apply adds its pick as set, and closes.
  await core.run(h, "range.set", { in: 40, out: 50 });
  await core.run(h, "music.review", { pick: { id: "rec-1", title: "Bright Days", ms: 30_000, vocals: true }, vocals: false });
  expect(((await core.session(h)).features.music as { pick: { id: string } }).pick.id).toBe("rec-1");
  const applied = (await core.run(h, "music.apply", {})).results.at(-1) as { job: string };
  expect((await core.session(h)).features.music).toBeUndefined();
  await waitJob(core, applied.job);
  // Without the singing, its instruments alone, cut to fit (Epidemic's edits are of the full mix).
  expect(calls.at(-1)).toEqual({ tool: "DownloadRecording", args: { id: "rec-1", options: { fileType: "MP3", stemType: "INSTRUMENTS" } } });
  await core.close(h);
}, 120_000);

test("Pop-ins: a sound on each picture coming onto the picture, those left out skipped, overlapping ones on another SFX track, one undo step; a sound already in the project isn't downloaded again", async () => {
  const secrets = new Map([["epidemic-sound-api-key", "es-key"]]);
  const core = new LocalCore({ cacheDir: join(dir, "pop-cache"), configDir: join(dir, "pop-config"), secrets: { get: async (id) => secrets.get(id), set: async () => {} } });
  const h = await core.create({ path: join(dir, "pops.beproj") });
  const png = join(dir, "logo.png");
  Bun.spawnSync([tool("ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "64x64", "-i", "pipe:0", "-frames:v", "1", png], { stdin: new Uint8Array(64 * 64).fill(200) });
  // Pictures at 2 s and 2.3 s (apart enough to be two) and 6 s; one at 2.1 s is the same pop-in as 2 s's.
  const at = async (time: number, track?: string) => (await core.import(h, [png], { at: time, ...(track ? { track } : {}) })).clips[0]!;
  const first = await at(2);
  await at(2.3);
  const late = await at(6);
  const t2 = (await core.run(h, "track.add", { name: "Logos" })).results[0] as string;
  await at(2.1, t2);
  await core.run(h, "edit.addAnnotation", { preset: "text", time: 4, duration: 1 });
  const found = (await core.query(h, "sfx.popIns", {})) as { time: number; clip: string; kind: string }[];
  expect(found.map((p) => [p.time, p.kind])).toEqual([[2, "picture"], [2.3, "picture"], [6, "picture"]]);
  expect(found[0]!.clip).toBe(first);

  await core.run(h, "music.review", { tab: "popins", popSound: { kind: "picture", pick: { id: "sfx-1", title: "Whoosh", ms: 500 } }, popOff: { clip: late, off: true } });
  const steps = (await core.history(h)).undo.length;
  const before = calls.length;
  await waitJob(core, ((await core.run(h, "music.apply", {})).results.at(-1) as { job: string }).job);
  expect(calls.slice(before).map((c) => c.tool)).toEqual(["DownloadSoundEffect"]);
  expect((await core.history(h)).undo.length - steps).toBe(1);
  const sfx = () => core.doc(h).tracks.filter((t) => t.name === "SFX");
  // 2 s's sound lasts to 2.5 s, so 2.3 s's goes on a second SFX track; 6 s was left out.
  expect(sfx().map((t) => t.clips.map((c) => ticksToSeconds(c.start)))).toEqual([[2], [2.3]]);
  expect((await core.session(h)).features.music).toBeUndefined();

  // Again: placed at once from the project, no download, onto the SFX tracks there are.
  const again = calls.length;
  const direct = await core.run(h, "sfx.addMany", { sounds: [{ id: "sfx-1", title: "Whoosh", time: 6 }] });
  expect(direct.results.at(-1)).not.toHaveProperty("job");
  expect(calls.length).toBe(again);
  expect(sfx().map((t) => t.clips.map((c) => ticksToSeconds(c.start)))).toEqual([[2, 6], [2.3]]);
  await core.close(h);
}, 60_000);
