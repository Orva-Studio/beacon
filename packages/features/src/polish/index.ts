import { z } from "zod";
import { defineAction, defineFeature, dropTargets, selectDropped, selectedClips } from "@beacon/model";

const TYPE = "polish";
/** tuneup's de-esser intensity. */
const SIBILANCE = 0.2;
/** The rate the chain runs at, so its delay is known exactly. */
const RATE = 48000;

/**
 * Polish, as the user's tuneup finishes a voice after Auphonic: clicks and mouth noise taken out, clipped peaks
 * rebuilt and harsh "s" sounds softened (ffmpeg's adeclick, adeclip and deesser), drawn live like Noise Removal.
 */
export const polish = defineFeature({
  id: "polish",
  version: 1,
  effects: [
    {
      id: TYPE,
      title: "Polish",
      description: "Finishes a voice: takes out clicks and mouth noise, repairs clipped peaks and softens harsh \"s\" sounds",
      traits: ["audio"],
      params: z.strictObject({
        removeClicks: z.boolean().describe("Clicks and mouth noise taken out (adeclick)"),
        repairClipping: z.boolean().describe("Peaks that clipped rebuilt (adeclip)"),
        sibilance: z.number().min(0).max(1).meta({ slider: { min: 0, max: 1 }, percent: true }).describe("How much harsh \"s\" sounds are softened; 0 leaves them (deesser)"),
      }),
      defaults: () => ({ removeClicks: true, repairClipping: true, sibilance: SIBILANCE }),
      audio(p) {
        const stages = [p.removeClicks && "adeclick", p.repairClipping && "adeclip", p.sibilance > 0 && `deesser=i=${p.sibilance}`].filter(Boolean);
        if (!stages.length) return { filter: "anull" };
        // These filters lose a seeked input's timestamps (a cut export then comes out a millisecond short): counted again from the first sample.
        return { filter: [`aresample=${RATE}`, ...stages, "asetpts=N/SR/TB"].join(",") };
      },
    },
  ],
  panelItems: [
    {
      id: "audio:polish",
      label: "Polish",
      title: "Finish a voice: clicks and mouth noise out, clipped peaks repaired, harsh \"s\" sounds softened",
      command: "edit.polish",
      args: {},
      traits: ["audio"],
    },
  ],
  actions: [
    defineAction({
      id: "edit.polish",
      description: "Polish the selected clips' audio (de-click, de-clip, de-ess); with `clip`, as dropping it on that clip. Already polished clips keep theirs",
      args: z.strictObject({ clip: z.string().min(1).optional() }),
      resolve: ({ clip }, ctx) => {
        const clips = (clip ? dropTargets(ctx, clip) : selectedClips(ctx)).filter((c) => ctx.registry.hasTrait(c.type, "audio"));
        if (!clips.length) throw new Error(clip ? "Polish applies to media with audio" : "select audio first");
        const steps = clips.filter((c) => !c.effects.some((e) => e.type === TYPE)).map((c) => ({ command: "effect.add", args: { clip: c.id, type: TYPE } }));
        if (!steps.length) throw new Error("the selected audio is already polished");
        return { label: "Polish", steps, after: () => selectDropped(ctx, clip) };
      },
    }),
  ],
});
