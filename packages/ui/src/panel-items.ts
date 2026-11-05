import type { PanelItem } from "./drop";
import type { Init } from "./rpc";
import { replica } from "./store";
import { isPanelEffect } from "@beacon/model";

/** A panel item with its tooltip, its tile's picture (`art/<art>.webp`) and what its uses are counted as (`LocalCore.recentItems`). */
export type Item = PanelItem & { title: string; art?: string; item: string };

/** The features' items of one panel (`annotation:`, `visual:` or `audio:`), its tile's picture named after what follows. */
function featureItems(init: Init | undefined, panel: "annotation" | "visual" | "audio"): Item[] {
  return (init?.panelItems ?? [])
    .filter((it) => it.id.startsWith(`${panel}:`))
    .map((it) => ({
      label: it.label,
      title: it.title,
      art: it.id.slice(panel.length + 1),
      item: it.id,
      command: it.command,
      args: it.args,
      traits: it.traits ?? [],
      ...(it.seconds ? { media: { seconds: it.seconds } } : {}),
    }));
}

/** The Annotations panel: presets of `edit.addAnnotation`, so agents add the same ones. */
export const annotations = (init: Init | undefined) => featureItems(init, "annotation");

export const audioEffects = (init: Init | undefined) => featureItems(init, "audio");

/** The Visual Effects panel: the effects for what is seen (the cursor's are on the Cursor tab, the audio's in Audio Effects), and Clip Speed. */
export const visualEffects = (init: Init | undefined): Item[] => [
  ...(init?.effects ?? [])
    .filter((e) => isPanelEffect(e.traits))
    .map((e) => ({ label: e.title, title: e.description, art: e.id, item: `effect:${e.id}`, command: "edit.addEffect", args: { type: e.id }, traits: e.traits })),
  ...featureItems(init, "visual"),
];

/** Every item of the Annotations, Visual Effects and Audio Effects panels, with its panel's name. */
export const allItems = (init: Init | undefined): (Item & { group: string })[] => [
  ...annotations(init).map((it) => ({ ...it, group: "Annotation" })),
  ...visualEffects(init).map((it) => ({ ...it, group: "Visual Effect" })),
  ...audioEffects(init).map((it) => ({ ...it, group: "Audio Effect" })),
];

/** The items by use (`recent`, most first), then the rest as they were. */
export function inUseOrder<T extends { item: string }>(items: T[], recent: string[]): T[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.item) ?? recent.length) - (rank.get(b.item) ?? recent.length));
}

interface AiHost {
  run(command: string, args?: unknown): void;
}

/** The AI panel's tools: each reviews on the timeline (opening its review in the properties panel), then applies. */
/**
 * `online`: it always needs the internet (it calls a cloud service), whichever transcriber is chosen. `transcript:
 * false`: it works without one (a prompt can be typed), so a transcriber that can't run offline doesn't stop it.
 */
export const AI_TOOLS: { id: string; label: string; title: string; art: string; online?: boolean; transcript?: false; start: (host: AiHost) => void }[] = [
  { id: "silences", label: "Remove Silences", title: "Shorten the pauses in speech, from its transcript (made on this Mac)", art: "remove-silences", start: (host) => review(host, "silences.review") },
  { id: "retakes", label: "Remove Retakes", title: "Find lines said more than once (a restart, a sentence said again) and keep the best take", art: "remove-retakes", start: (host) => review(host, "retakes.review") },
  {
    id: "broll",
    label: "B-roll",
    title: "Add a B-roll clip at the playhead (or over the range), its prompt written from the words said there: drag and trim it, size it on the canvas, pick a style, and make its footage with AI (on your Replicate account)",
    art: "b-roll",
    transcript: false,
    // Prompt from Auto: its prompt written as soon as it is added (a clip added where nothing is said says so).
    start: (host) => {
      review(host, "broll.add");
      host.run("broll.plan", {});
    },
  },
  {
    id: "angles",
    label: "Camera Angle",
    title: "A 3 s cutaway of you from another angle (side profile, wide, close-up, detail) at the playhead or over the range, made with AI from your camera and your own sound (on your Replicate account), or a free close-up crop when your camera has the pixels",
    art: "remove-background",
    online: true,
    transcript: false,
    start: (host) => review(host, "angles.add"),
  },
  {
    id: "motion",
    label: "Motion Graphics",
    title: "Add a motion graphics clip at the playhead (or over the range), its prompt written from the words said there: drag and trim it, size its box on the canvas, then Make it into a title, name, number or list",
    art: "text",
    transcript: false,
    // Prompt from Auto: written as soon as it is added (a clip added where nothing is said says so).
    start: (host) => {
      review(host, "motion.add");
      host.run("motion.write", {});
    },
  },
  {
    id: "music",
    label: "Music",
    title: "Music and sound effects from Epidemic Sound (on your own subscription): search and listen, then add a track fitted to the range and ducked under speech, or a sound effect at the playhead",
    art: "music",
    online: true,
    transcript: false,
    start: (host) => review(host, "music.review"),
  },
  {
    id: "captions",
    label: "Captions",
    title: "Captions from the transcript, a few words at a time, the spoken word highlighted: burned into the export (an .srt beside it is a tick box in Export)",
    art: "captions",
    start: () => replica.pendCaptions(true),
  },
];

function review(host: AiHost, command: string) {
  host.run(command, {});
  host.run("panel.show", { properties: true });
}
