import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { jobSignal, runTool, tool } from "@beacon/media";
import { clipEnd, defineAction, defineFeature, defineQuery, selectedClips, ticksToSeconds, type ActionContext, type ActionStep, type Clip, type Session, type SessionCommandDef } from "@beacon/model";

const KEY = "auphonic-api-key";
/** Auphonic's API; a test points it at a stand-in. */
const api = () => process.env.BEACON_AUPHONIC_URL ?? "https://auphonic.com/api";
/** How often a production's status is asked for, as tuneup does. */
const POLL_MS = () => Number(process.env.BEACON_AUPHONIC_POLL_MS ?? 15_000);
/** How long a request may go unanswered; an upload or download five times that. */
const TIMEOUT_MS = () => Number(process.env.BEACON_AUPHONIC_TIMEOUT_MS ?? 60_000);
/** Auphonic's production states: done, and failed. */
const DONE = 3;
const FAILED = 2;
/** What the cleaned audio may differ from what was sent, in length and in time, before it is refused. */
/** A length further off than this means the preset cut something out. */
const CUT = 0.5;

/** Clean with Auphonic's panel is open: it cleans the audio selected, whatever that is now. */
export interface AuphonicReview {
  open: true;
}

export const auphonicReview = (s: Session) => s.features.auphonic as AuphonicReview | undefined;

const sessionCommands: SessionCommandDef[] = [
  {
    id: "auphonic.review",
    description:
      "Open Clean with Auphonic's settings in the properties panel (Audio Effects' Auphonic tile does): it cleans the selected audio, following the selection (`clips`, or a `clip` not selected, are selected first; with none it asks for some). The user picks a preset and starts it, which spends their Auphonic minutes. audio.clean starts it directly",
    args: z.strictObject({ clips: z.array(z.string().min(1)).min(1).optional(), clip: z.string().min(1).optional() }),
    apply: (s, { clips, clip }: { clips?: string[]; clip?: string }) => {
      if (clips) s.selection = clips;
      else if (clip && !s.selection.includes(clip)) s.selection = [clip];
      s.features.auphonic = { open: true } satisfies AuphonicReview;
    },
  },
  {
    id: "auphonic.selectAudio",
    description: "Select the audio the export plays (its panel's Select All Audio): every audio clip not muted, on a track neither muted nor disabled",
    args: z.strictObject({}),
    apply: (s, _, { project, registry }) => {
      const heard = project.tracks.filter((t) => !t.muted && !t.hidden).flatMap((t) => t.clips.filter((c) => registry.hasTrait(c.type, "audio") && !(c.props.audio as { muted?: boolean } | undefined)?.muted));
      if (!heard.length) throw new Error("no audio is heard on the timeline");
      s.selection = heard.map((c) => c.id);
    },
  },
  {
    id: "auphonic.close",
    description: "Close Clean with Auphonic's settings without starting it",
    args: z.strictObject({}),
    apply: (s) => void delete s.features.auphonic,
  },
];

export interface AuphonicPreset {
  uuid: string;
  name: string;
}

/**
 * A request to Auphonic on a connection of its own, given up after `ms`, a read tried once more. Bun kept a polling
 * connection for reuse and, once Auphonic's server had dropped it, waited on it for good (a download "took" 12 min).
 */
async function request(url: string, init: RequestInit, ms: number, what: string): Promise<Response> {
  const read = !init.method || init.method === "GET";
  for (let attempt = 1; ; attempt++) {
    const job = jobSignal();
    try {
      return await fetch(url, { ...init, keepalive: false, signal: AbortSignal.any([AbortSignal.timeout(ms), ...(job ? [job] : [])]) });
    } catch (e) {
      job?.throwIfAborted();
      if ((e as Error).name !== "TimeoutError") throw e;
      if (!read || attempt === 2) throw new Error(`Auphonic didn't answer within ${Math.round(ms / 1000)} s (${what}): try again`);
    }
  }
}

async function call<T>(key: string, path: string, init: RequestInit = {}, ms = TIMEOUT_MS()): Promise<T> {
  const r = await request(`${api()}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } }, ms, path.replace(/\?.*/, ""));
  if (r.status === 401 || r.status === 403) throw new Error("Auphonic refused the API key: check it in Settings › Audio");
  if (!r.ok) throw new Error(`Auphonic: ${path} failed (${r.status}) ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

/** The audio files a preset can make, in the order taken: M4A, then MP3 (the user's, 2026-10-22), then the rest. */
const AUDIO_OUTPUTS = ["m4a", "aac", "mp3", "wav", "flac", "opus", "ogg"];

/** 0:07, 1:42. */
const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const keyOf = async (secret: ((id: string) => Promise<string | undefined>) | undefined) => {
  const key = await secret?.(KEY);
  if (!key) throw new Error("no Auphonic API key: add one in Settings › Audio");
  return key;
};

/** The clips Clean with Auphonic sends: those given, else the selected ones with audio, muted ones left out. */
function audioClips(ctx: ActionContext, ids?: string[]): Clip[] {
  const pool = ids ? ctx.scope.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id)) : selectedClips(ctx);
  if (ids && pool.length !== ids.length) throw new Error(`no clip ${ids.filter((id) => !pool.some((c) => c.id === id)).join(", ")} on the timeline`);
  return pool.filter((c) => ctx.registry.hasTrait(c.type, "audio") && !(c.props.audio as { muted?: boolean } | undefined)?.muted);
}

/** Mono samples at 8 kHz, enough to line two takes of the same audio up. */
const RATE = 8000;
async function samples(path: string, raw: string): Promise<Float32Array> {
  await runTool([tool("ffmpeg"), "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
  return new Float32Array(await Bun.file(raw).arrayBuffer());
}

/** A file's sample rate and channels. */
async function format(path: string): Promise<{ rate: number; channels: number }> {
  const out = String(await runTool([tool("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", path])).trim();
  const [rate, channels] = out.split(",").map(Number) as [number, number];
  return { rate, channels };
}

/**
 * Auphonic's file lined up with what was sent, as `out` (AAC): its encoder's padding (and its own rate and channels)
 * taken off by the samples, so container timestamps can't move it. Refused when its start and end sit differently
 * (the preset cut something), Auphonic's file then kept as `kept`.
 */
async function lineUp(sent: string, back: string, seconds: number, tmp: string, out: string, kept: () => Promise<string>): Promise<void> {
  const refuse = async (why: string) => {
    throw new Error(`${why}: turn off cutting (silences, fillers, coughs) in the preset; Auphonic's file is kept as ${basename(await kept())} in the project's media folder`);
  };
  const length = await duration(back);
  if (Math.abs(length - seconds) > CUT) await refuse(`Auphonic's audio is ${length.toFixed(2)} s long, the sent audio ${seconds.toFixed(2)} s`);
  const [a, b] = [await samples(sent, join(tmp, "sent.raw")), await samples(back, join(tmp, "back.raw"))];
  // Measured at about 11 places across it, those with enough to go on: something cut moves the places after it.
  const total = a.length / RATE;
  const span = Math.min(5, total / 3);
  const found: { shift: number; alike: number }[] = [];
  for (let at = 0; at + span <= total + 1e-9; at += Math.max(span, (total - span) / 10)) found.push(match(a, b, at, span));
  const sure = found.filter((m) => m.alike > 0.6);
  if (!sure.length) await refuse("Auphonic's audio doesn't sound like what was sent");
  const shifts = sure.map((m) => m.shift);
  const start = shifts[0]!;
  const spread = Math.max(...shifts) - Math.min(...shifts);
  if (spread > 0.02) await refuse(`Auphonic's audio drifts ${Math.round(spread * 1000)} ms from start to end`);
  const { rate, channels } = await format(sent);
  const raw = join(tmp, "back.pcm");
  await runTool([tool("ffmpeg"), "-v", "error", "-y", "-i", back, "-ac", String(channels), "-ar", String(rate), "-f", "s16le", raw]);
  const pcm = new Int16Array(await Bun.file(raw).arrayBuffer());
  const frames = Math.round(seconds * rate);
  const skip = Math.round(start * rate);
  const lined = new Int16Array(frames * channels);
  // Late by `start`: its first samples dropped; early: silence before it.
  for (let f = 0; f < frames; f++) {
    const g = f + skip;
    if (g < 0 || g * channels >= pcm.length) continue;
    for (let c = 0; c < channels; c++) lined[f * channels + c] = pcm[g * channels + c]!;
  }
  await Bun.write(raw, lined);
  await runTool([tool("ffmpeg"), "-v", "error", "-y", "-f", "s16le", "-ar", String(rate), "-ac", String(channels), "-i", raw, "-c:a", "aac", "-b:a", "256k", out]);
}

/**
 * How late `b` is against `a` over `seconds` from `at`, in seconds, looked for within ±`reach` s (coarse, then fine),
 * and how alike they are there (0–1): a stretch with little to go on (near silence, a hum) lines up anywhere.
 */
function match(a: Float32Array, b: Float32Array, at = 0, seconds = 5, reach = 1): { shift: number; alike: number } {
  const [from, to] = [Math.round(at * RATE), Math.min(a.length, Math.round((at + seconds) * RATE))];
  const score = (d: number, stride: number) => {
    let sum = 0;
    for (let i = from; i < to; i += stride) sum += a[i]! * (b[i + d] ?? 0);
    return sum;
  };
  const search = (lo: number, hi: number, step: number, stride: number) => {
    let [best, top] = [lo, -Infinity];
    for (let d = lo; d <= hi; d += step) {
      const v = score(d, stride);
      if (v > top) [top, best] = [v, d];
    }
    return best;
  };
  const coarse = search(-Math.round(reach * RATE), Math.round(reach * RATE), 16, 8);
  const best = search(coarse - 16, coarse + 16, 1, 2);
  let [ea, eb] = [0, 0];
  for (let i = from; i < to; i += 2) [ea, eb] = [ea + a[i]! ** 2, eb + (b[i + best] ?? 0) ** 2];
  return { shift: best / RATE, alike: score(best, 2) / Math.sqrt(ea * eb || 1) };
}


async function duration(path: string): Promise<number> {
  const out = await runTool([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(String(out).trim());
}

/**
 * Auphonic's cleaning, as the user's tuneup does it, built in: the selected clips' audio, as heard, sent to Auphonic
 * with one of the user's presets, and what comes back put on a new track right above them, the originals muted.
 */
export const auphonic = defineFeature({
  id: "auphonic",
  version: 1,
  dismissable: [{ open: (s) => !!auphonicReview(s), close: "auphonic.close" }],
  secrets: [{ id: KEY, title: "Auphonic API key" }],
  sessionCommands,
  panelItems: [
    {
      id: "audio:auphonic",
      label: "Auphonic",
      title: "Clean the clip's audio with Auphonic, with one of your presets (on your Auphonic account)",
      command: "auphonic.review",
      args: {},
      traits: ["audio"],
    },
  ],
  queries: [
    defineQuery({
      id: "auphonic.presets",
      description: "The user's Auphonic presets, by name (needs their Auphonic API key, set in Settings › Audio)",
      args: z.strictObject({}),
      run: async (_, ctx) => {
        const key = await keyOf(ctx.secret);
        const r = await call<{ data?: { uuid: string; preset_name: string }[] }>(key, "/presets.json?minimal_data=1");
        return (r.data ?? []).map((p) => ({ uuid: p.uuid, name: p.preset_name })) satisfies AuphonicPreset[];
      },
    }),
  ],
  actions: [
    defineAction({
      id: "audio.clean",
      description:
        "Clean the selected clips' audio (or `clips`) with Auphonic, using one of the user's presets (`auphonic.presets`): their audio as heard over their span is uploaded to Auphonic, on the user's account, which charges by length; what comes back (saved in the project's media folder) goes on a new track right above the highest one cleaned, the originals muted, in one undo step, with Polish on it unless `polish` is false. Runs as a job (job_status). Only when the user asks: it spends their Auphonic minutes",
      args: z.strictObject({
        preset: z.string().min(1).describe("The preset's uuid or name"),
        clips: z.array(z.string().min(1)).min(1).optional(),
        polish: z.boolean().default(true).describe("Put Polish (de-click, de-clip, de-ess) on the cleaned audio"),
        sibilance: z.number().min(0).max(1).optional().describe("Polish's de-esser, 0-1"),
      }),
      resolve: ({ preset, clips: ids, polish, sibilance }, ctx) => {
        const clips = audioClips(ctx, ids);
        if (!clips.length) throw new Error("select audio first");
        const from = ticksToSeconds(Math.min(...clips.map((c) => c.start)));
        const to = ticksToSeconds(Math.max(...clips.map(clipEnd)));
        const asset = clips[0]!.assetId ? ctx.project.assets[clips[0]!.assetId] : undefined;
        const name = asset?.name ?? (asset ? basename(asset.path, extname(asset.path)) : "audio");
        const ids2 = clips.map((c) => c.id);
        return {
          label: "Clean with Auphonic",
          task: {
            label: `Clean ${name} with Auphonic`,
            run: async (env) => {
              const key = await keyOf(env.secret);
              const presets = (await call<{ data?: { uuid: string; preset_name: string }[] }>(key, "/presets.json?minimal_data=1")).data ?? [];
              const chosen = presets.find((p) => p.uuid === preset || p.preset_name === preset);
              if (!chosen) throw new Error(`no Auphonic preset "${preset}"; there are: ${presets.map((p) => p.preset_name).join(", ")}`);
              const tmp = mkdtempSync(join(tmpdir(), "beacon-auphonic-"));
              // Each stage numbered, with its seconds ticking: an upload and Auphonic's wait report no progress of their own.
              let stage = { n: 1, text: "", value: 0, since: Date.now() };
              const tell = () => env.progress(stage.value, `${stage.n} of 5 · ${stage.text} · ${minutes((Date.now() - stage.since) / 1000)}`);
              const say = (n: number, value: number, text: string) => {
                stage = { n, text, value, since: n === stage.n ? stage.since : Date.now() };
                tell();
              };
              const ticking = setInterval(tell, 1000);
              try {
                say(1, 0, "Preparing the audio");
                // AAC, a tenth of a WAV: a WAV's upload took minutes on an ordinary connection.
                const input = join(tmp, `${name}.m4a`);
                await env.bounceAudio(ids2, { from, to }, input);
                say(2, 0.1, "Uploading to Auphonic");
                const form = new FormData();
                form.append("input_file", Bun.file(input));
                form.append("title", `Beacon: ${name}`);
                form.append("preset", chosen.uuid);
                const made = await call<{ data?: { uuid?: string } }>(key, "/simple/productions.json", { method: "POST", body: form }, TIMEOUT_MS() * 5);
                const uuid = made.data?.uuid;
                if (!uuid) throw new Error("Auphonic didn't start a production");
                say(3, 0.2, "Auphonic: starting");
                await call(key, `/production/${uuid}/start.json`, { method: "POST" });
                for (let wait = 1; ; wait++) {
                  await Bun.sleep(POLL_MS());
                  jobSignal()?.throwIfAborted();
                  const s = await call<{ data?: { status?: number; status_string?: string } }>(key, `/production/${uuid}/status.json`);
                  if (s.data?.status === DONE) break;
                  if (s.data?.status === FAILED) {
                    const d = await call<{ data?: { error_message?: string; error_summary?: string } }>(key, `/production/${uuid}.json`);
                    throw new Error(`Auphonic couldn't clean it: ${d.data?.error_message || d.data?.error_summary || "no reason given"}`);
                  }
                  // Auphonic gives no percentage: the wait creeps on towards the download.
                  say(3, 0.2 + 0.6 * (1 - 1 / (1 + wait / 8)), `Auphonic: ${s.data?.status_string ?? "working"}`);
                }
                const d = await call<{ data?: { output_files?: { download_url?: string; filename?: string; format?: string }[] } }>(key, `/production/${uuid}.json`);
                // Whatever audio the preset makes, in AUDIO_OUTPUTS' order: the line-up check below still refuses one out of step.
                const files = (d.data?.output_files ?? []).filter((f) => f.download_url && f.filename);
                const file = AUDIO_OUTPUTS.map((ext) => files.find((f) => f.filename!.toLowerCase().endsWith(`.${ext}`))).find(Boolean);
                if (!file) throw new Error(`the preset "${chosen.preset_name}" makes no audio file (WAV, FLAC, M4A or MP3): add one as an output format in Auphonic`);
                say(4, 0.85, "Downloading");
                // Its link redirects to Auphonic's storage, which Bun asks without the key.
                const got = await request(file.download_url!, { headers: { Authorization: `Bearer ${key}` }, redirect: "follow" }, TIMEOUT_MS() * 5, "the download");
                if (!got.ok) throw new Error(`Auphonic's file couldn't be downloaded (${got.status})`);
                const back = join(tmp, `back${extname(file.filename!).toLowerCase()}`);
                await Bun.write(back, got);
                say(5, 0.95, "Lining it up");
                const free = async (suffix: string, ext: string) => {
                  let path = join(env.mediaDir, `${name}.${suffix}${ext}`);
                  for (let n = 2; await Bun.file(path).exists(); n++) path = join(env.mediaDir, `${name}.${suffix} ${n}${ext}`);
                  return path;
                };
                const out = await free("cleaned", ".m4a");
                // A preset that cut silences or changed speed would no longer line up with the picture: refused.
                await lineUp(input, back, to - from, tmp, out, async () => {
                  const kept = await free("auphonic", extname(back));
                  await Bun.write(kept, Bun.file(back));
                  return kept;
                });
                const { shift: check } = match(await samples(input, join(tmp, "sent.raw")), await samples(out, join(tmp, "out.raw")), 0, Math.min(30, to - from));
                if (Math.abs(check) > 0.002) throw new Error(`the cleaned audio is ${Math.round(check * 1000)} ms out of step after lining it up`);
                const added = await env.asset(out, "audio");
                clearInterval(ticking);
                env.progress(1, `On a new track right above the originals, which are muted; the file is ${basename(out)} in the project's media folder`);
                return (ctx) => {
                  // On a track of its own right above the highest one it cleaned, as the document is now.
                  const above = Math.max(-1, ...ctx.project.tracks.flatMap((t, i) => (t.clips.some((c) => ids2.includes(c.id)) ? [i] : []))) + 1;
                  const steps: ActionStep[] = [
                    { command: "asset.add", args: { ...added, name: `${name} (Auphonic)` } },
                    { command: "track.add", args: { name: "Auphonic", ...(above > 0 ? { index: above } : {}) } },
                    { command: "asset.place", args: (r: unknown[]) => ({ asset: r[0], time: from, track: r[1] }) },
                    ...ids2.map((id) => ({ command: "clip.set", args: { clip: id, props: { audio: { muted: true } } } })),
                    ...(polish ? [{ command: "effect.add", args: (r: unknown[]) => ({ clip: (r[2] as string[])[0], type: "polish", ...(sibilance === undefined ? {} : { params: { sibilance } }) }) }] : []),
                  ];
                  return { label: "Clean with Auphonic", steps, after: (r) => [{ command: "selection.set", args: { clips: r[2] as string[], linked: false } }] };
                };
              } finally {
                clearInterval(ticking);
                rmSync(tmp, { recursive: true, force: true });
              }
            },
          },
        };
      },
    }),
  ],
});
