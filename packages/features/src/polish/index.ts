import { z } from "zod";
import { defineFeature } from "@beacon/model";

const TYPE = "polish";
/** tuneup's de-esser intensity. */
const SIBILANCE = 0.2;
/** The rate the chain runs at, so its delay is known exactly. */
const RATE = 48000;

/**
 * Polish, as the user's tuneup finishes a voice after Auphonic: clicks and mouth noise taken out, clipped peaks
 * rebuilt and harsh "s" sounds softened (ffmpeg's adeclick, adeclip and deesser). Only Clean with Auphonic adds it
 * now (the user, 2026-11-05: its own tile and command went).
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
});
