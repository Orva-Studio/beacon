import { z } from "zod";
import { clipEnd, clipSpeed, defineAction, defineFeature, dropTargets, mediaTimeAt, secondsToTicks, selectDropped, selectedClips, ticksToSeconds, type ActionContext, type Clip } from "@beacon/model";
import { clipStream, type WaveformData } from "../media";

const TYPE = "noise-removal";
/** dB taken off the learned noise, as Audacity's Noise Reduction defaults to. */
const STRENGTH = 12;
/** Seconds of noise it learns from when it picks the stretch itself. */
const SAMPLE = 0.5;
/** The rate afftdn runs at, so its delay is known exactly. */
const RATE = 48000;
/** The waveform's peaks are 10 ms apart. */
const PEAK = 0.01;

/** The clip's quietest stretch of `SAMPLE` seconds (media seconds), from its waveform; undefined until there is one. */
function quietest(c: Clip, ctx: ActionContext): [number, number] | undefined {
  const peaks = c.assetId ? ctx.data<WaveformData>(c.assetId, "waveform")?.streams[clipStream(c)] : undefined;
  if (!peaks?.length) return undefined;
  const from = Math.max(0, Math.floor(ticksToSeconds(c.mediaStart ?? 0) / PEAK));
  const to = Math.min(peaks.length, Math.floor((ticksToSeconds(c.mediaStart ?? 0) + ticksToSeconds(c.duration) * clipSpeed(c)) / PEAK));
  const n = Math.round(SAMPLE / PEAK);
  if (to - from < n) return undefined;
  let sum = 0;
  for (let i = from; i < from + n; i++) sum += peaks[i]!;
  let best = [sum, from] as [number, number];
  for (let i = from + n; i < to; i++) {
    sum += peaks[i]! - peaks[i - n]!;
    if (sum < best[0]) best = [sum, i - n + 1];
  }
  return [best[1] * PEAK, (best[1] + n) * PEAK];
}

/** Selected clips with audio, else those under the playhead on unlocked tracks. */
function audioClips(ctx: ActionContext): Clip[] {
  const has = (c: Clip) => ctx.registry.hasTrait(c.type, "audio");
  const picked = selectedClips(ctx).filter(has);
  if (picked.length) return picked;
  const t = ctx.session.playhead;
  return ctx.scope.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => has(c) && ticksToSeconds(c.start) <= t && ticksToSeconds(clipEnd(c)) >= t));
}

/**
 * Noise Removal, as Audacity's: learns the noise from a stretch of the clip with nothing but room noise (the in/out
 * range when it is applied, else the clip's quietest half second) and takes it out of the whole clip (ffmpeg's
 * afftdn, which hears that stretch first). Without a stretch learned, it follows the noise as it goes.
 */
export const noise = defineFeature({
  id: "noise",
  version: 1,
  effects: [
    {
      id: TYPE,
      title: "Noise Removal",
      description: "Takes steady background noise (hum, hiss, a fan) out of the clip's audio, learned from a stretch with only that noise",
      traits: ["audio"],
      params: z.strictObject({
        strength: z.number().min(1).max(40).meta({ slider: { min: 1, max: 40 } }).describe("dB taken off the noise"),
        learnFrom: z.number().nonnegative().describe("Start of the stretch it learned the noise from, in seconds of the clip's media"),
        learnTo: z.number().nonnegative().describe("Its end; equal to learnFrom when nothing was learned"),
      }),
      defaults: () => ({ strength: STRENGTH, learnFrom: 0, learnTo: 0 }),
      audio(p) {
        // afftdn hands each block back two blocks (a rate / 80 each) later; at 48 kHz that is exactly 25 ms.
        const delay = (2 * (RATE / 80)) / RATE;
        const filter = `aresample=${RATE},afftdn=nr=${p.strength}:nf=-50`;
        if (!(p.learnTo > p.learnFrom)) return { filter: `${filter}:tn=1`, delay };
        const length = (p.learnTo - p.learnFrom).toFixed(6);
        return { filter: `asendcmd=0 afftdn sn start,asendcmd=${length} afftdn sn stop,${filter}`, lead: { start: p.learnFrom, end: p.learnTo }, delay };
      },
    },
  ],
  panelItems: [
    {
      id: "audio:noise-removal",
      label: "Noise Removal",
      title: "Take background noise out of the clip, learned from its quietest moment (or the in/out range, set over a stretch with only room noise)",
      command: "edit.removeNoise",
      args: {},
      traits: ["audio"],
    },
  ],
  actions: [
    defineAction({
      id: "edit.removeNoise",
      description:
        "Noise Removal on the selected clips' audio (or those under the playhead): learns the noise from the in/out range when there is one (a stretch with only room noise), else from each clip's quietest half second, and takes it out of the whole clip. Applied again, it learns again. With `clip`, as dropping it on that clip",
      args: z.strictObject({ strength: z.number().min(1).max(40).optional(), clip: z.string().min(1).optional() }),
      resolve: ({ strength, clip }, ctx) => {
        const clips = clip ? dropTargets(ctx, clip).filter((c) => ctx.registry.hasTrait(c.type, "audio")) : audioClips(ctx);
        if (!clips.length) throw new Error(clip ? "Noise Removal applies to media with audio" : "select audio first");
        const range = ctx.session.range;
        const steps = clips.map((c) => {
          let learn = quietest(c, ctx) ?? [0, 0];
          if (range) {
            const a = Math.max(range.in, ticksToSeconds(c.start));
            const b = Math.min(range.out, ticksToSeconds(clipEnd(c)));
            if (b - a < 0.1) throw new Error("the in/out range must cover at least a tenth of a second of each clip, where there is only room noise");
            learn = [a, b].map((t) => ticksToSeconds(mediaTimeAt(c, secondsToTicks(t)))).sort((x, y) => x - y) as [number, number];
          }
          const params = { learnFrom: learn[0], learnTo: learn[1], ...(strength === undefined ? {} : { strength }) };
          const had = c.effects.find((e) => e.type === TYPE);
          return had ? { command: "effect.set", args: { clip: c.id, effect: had.id, params, enabled: true } } : { command: "effect.add", args: { clip: c.id, type: TYPE, params } };
        });
        return { label: "Noise Removal", steps, after: () => selectDropped(ctx, clip) };
      },
    }),
  ],
});
