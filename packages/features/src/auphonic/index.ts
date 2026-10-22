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
/** Auphonic's production states: done, and failed. */
const DONE = 3;
const FAILED = 2;
/** What the cleaned audio may differ from what was sent, in length and in time, before it is refused. */
const SLACK = 0.05;

/** Clean with Auphonic's settings, open in the properties panel (`session.features.auphonic`) until started or closed. */
export interface AuphonicReview {
  clips: string[];
}

export const auphonicReview = (s: Session) => s.features.auphonic as AuphonicReview | undefined;

const sessionCommands: SessionCommandDef[] = [
  {
    id: "auphonic.review",
    description:
      "Open Clean with Auphonic's settings for the selected audio (or `clips`) in the properties panel (Audio Effects' Auphonic tile does): the user picks a preset and starts it, which spends their Auphonic minutes. audio.clean starts it directly",
    args: z.strictObject({ clips: z.array(z.string().min(1)).min(1).optional(), clip: z.string().min(1).optional() }),
    apply: (s, { clips, clip }: { clips?: string[]; clip?: string }, { project, registry }) => {
      const ids = clips ?? (clip && !s.selection.includes(clip) ? [clip] : s.selection);
      const all = project.tracks.flatMap((t) => t.clips);
      const audio = ids.filter((id) => ((c) => c && registry.hasTrait(c.type, "audio"))(all.find((c) => c.id === id)));
      if (!audio.length) throw new Error("select audio first");
      s.features.auphonic = { clips: audio } satisfies AuphonicReview;
      if (clip && !s.selection.includes(clip)) s.selection = [clip];
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

async function call<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${api()}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers }, signal: jobSignal() });
  if (r.status === 401 || r.status === 403) throw new Error("Auphonic refused the API key: check it in Settings › Audio");
  if (!r.ok) throw new Error(`Auphonic: ${path} failed (${r.status}) ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

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
async function samples(path: string, seconds: number, raw: string): Promise<Float32Array> {
  await runTool([tool("ffmpeg"), "-v", "error", "-y", "-i", path, "-t", String(seconds), "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
  return new Float32Array(await Bun.file(raw).arrayBuffer());
}

/** Where `b` best lines up with `a`, in seconds, within ±`SLACK` * 4. */
function offset(a: Float32Array, b: Float32Array): number {
  const reach = Math.round(SLACK * 4 * RATE);
  let best = 0;
  let score = -Infinity;
  for (let d = -reach; d <= reach; d += 2) {
    let sum = 0;
    for (let i = reach; i < a.length - reach; i += 4) sum += a[i]! * (b[i + d] ?? 0);
    if (sum > score) [score, best] = [sum, d];
  }
  return best / RATE;
}

async function duration(path: string): Promise<number> {
  const out = await runTool([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(String(out).trim());
}

/**
 * Auphonic's cleaning, as the user's tuneup does it, built in: the selected clips' audio, as heard, sent to Auphonic
 * with one of the user's presets, and what comes back put on a track of its own over them, the originals muted.
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
        "Clean the selected clips' audio (or `clips`) with Auphonic, using one of the user's presets (`auphonic.presets`): their audio as heard over their span is uploaded to Auphonic, on the user's account, which charges by length; what comes back goes on a track of its own over them, the originals muted, in one undo step, with Polish on it unless `polish` is false. Runs as a job (job_status). Only when the user asks: it spends their Auphonic minutes",
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
              try {
                env.progress(0, "Preparing the audio");
                const input = join(tmp, `${name}.wav`);
                await env.bounceAudio(ids2, { from, to }, input);
                env.progress(0.1, "Uploading to Auphonic");
                const form = new FormData();
                form.append("input_file", Bun.file(input));
                form.append("title", `Beacon: ${name}`);
                form.append("preset", chosen.uuid);
                const made = await call<{ data?: { uuid?: string } }>(key, "/simple/productions.json", { method: "POST", body: form });
                const uuid = made.data?.uuid;
                if (!uuid) throw new Error("Auphonic didn't start a production");
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
                  env.progress(0.2 + 0.6 * (1 - 1 / (1 + wait / 8)), `Auphonic: ${s.data?.status_string ?? "working"}`);
                }
                const d = await call<{ data?: { output_files?: { download_url?: string; filename?: string; format?: string }[] } }>(key, `/production/${uuid}.json`);
                const file = (d.data?.output_files ?? []).find((f) => f.download_url && /\.(wav|flac)$/i.test(f.filename ?? ""));
                if (!file) throw new Error(`the preset "${chosen.preset_name}" makes no WAV or FLAC: add one of those as an output format in Auphonic (other formats don't line up to the sample)`);
                env.progress(0.85, "Downloading");
                const got = await fetch(file.download_url!, { headers: { Authorization: `Bearer ${key}` }, redirect: "follow", signal: jobSignal() });
                if (!got.ok) throw new Error(`Auphonic's file couldn't be downloaded (${got.status})`);
                let out = join(env.mediaDir, `${name}.cleaned${extname(file.filename!).toLowerCase()}`);
                for (let n = 2; await Bun.file(out).exists(); n++) out = join(env.mediaDir, `${name}.cleaned ${n}${extname(file.filename!).toLowerCase()}`);
                await Bun.write(out, got);
                env.progress(0.95, "Checking it lines up");
                // A preset that cuts silences or changes speed would no longer line up with the picture: refused, the file kept.
                const [sent, back] = [await duration(input), await duration(out)];
                if (Math.abs(sent - back) > SLACK) throw new Error(`Auphonic's audio is ${back.toFixed(2)} s long, the sent audio ${sent.toFixed(2)} s: turn off cutting (silences, fillers, coughs) in the preset; the file is kept in the project's media folder`);
                const shift = offset(await samples(input, 30, join(tmp, "sent.raw")), await samples(out, 30, join(tmp, "back.raw")));
                if (Math.abs(shift) > 0.01) throw new Error(`Auphonic's audio is ${Math.round(shift * 1000)} ms out of step with the original; the file is kept in the project's media folder`);
                const added = await env.asset(out, "audio");
                return () => {
                  const steps: ActionStep[] = [
                    { command: "asset.add", args: { ...added, name: `${name} (Auphonic)` } },
                    { command: "asset.place", args: (r: unknown[]) => ({ asset: r[0], time: from }) },
                    ...ids2.map((id) => ({ command: "clip.set", args: { clip: id, props: { audio: { muted: true } } } })),
                    ...(polish ? [{ command: "effect.add", args: (r: unknown[]) => ({ clip: (r[1] as string[])[0], type: "polish", ...(sibilance === undefined ? {} : { params: { sibilance } }) }) }] : []),
                  ];
                  return { label: "Clean with Auphonic", steps, after: (r) => [{ command: "selection.set", args: { clips: r[1] as string[], linked: false } }] };
                };
              } finally {
                rmSync(tmp, { recursive: true, force: true });
              }
            },
          },
        };
      },
    }),
  ],
});
