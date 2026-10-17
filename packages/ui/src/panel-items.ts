import { effectName } from "./effect-names";
import type { PanelItem } from "./drop";
import type { Init } from "./rpc";
import { replica } from "./store";
import { isPanelEffect } from "@beacon/model";

/** A panel item with its tooltip, its tile's picture (`art/<art>.webp`) and what favourites call it (`LocalCore.favorites`). */
export type Item = PanelItem & { title: string; art?: string; favorite: string };

/** The Annotations panel: presets of `edit.addAnnotation`, so agents add the same ones. */
export const ANNOTATIONS: Item[] = (
  [
    ["Text", "text", "White text with a drop shadow"],
    ["Rectangle", "rectangle", "A black rounded rectangle"],
    ["Spotlight", "spotlight", "Darken everything outside the box"],
    ["Blur", "blur", "Blur what is inside the box"],
    ["Pixelate", "pixelate", "Pixelate what is inside the box"],
  ] as const
).map(([label, preset, title]) => ({ label, title, art: preset, favorite: `annotation:${preset}`, command: "edit.addAnnotation", args: { preset }, traits: [], media: { seconds: 5 } }));

export const AUDIO_EFFECTS: Item[] = [
  { label: "Fade In", title: "Fade the audio in from silence over its first second", art: "fade-in", favorite: "audio:fade-in", command: "edit.fade", args: { kind: "in" }, traits: ["audio"] },
  { label: "Fade Out", title: "Fade the audio out to silence over its last second", art: "fade-out", favorite: "audio:fade-out", command: "edit.fade", args: { kind: "out" }, traits: ["audio"] },
];

/** The Visual Effects panel: every effect but the cursor's own (those are on the Cursor tab). */
export const visualEffects = (init: Init | undefined): Item[] =>
  (init?.effects ?? [])
    .filter((e) => isPanelEffect(e.traits))
    .map((e) => ({ label: effectName(e.id), title: e.description, art: e.id, favorite: `effect:${e.id}`, command: "edit.addEffect", args: { type: e.id }, traits: e.traits }));

/** Every item of the Annotations, Visual Effects and Audio Effects panels, with its panel's name. */
export const allItems = (init: Init | undefined): (Item & { group: string })[] => [
  ...ANNOTATIONS.map((it) => ({ ...it, group: "Annotation" })),
  ...visualEffects(init).map((it) => ({ ...it, group: "Visual Effect" })),
  ...AUDIO_EFFECTS.map((it) => ({ ...it, group: "Audio Effect" })),
];

/** The items that are favourites, in the favourites' order. */
export function inFavoriteOrder<T extends { favorite: string }>(items: T[], favorites: string[]): T[] {
  const byId = new Map(items.map((it) => [it.favorite, it]));
  return favorites.flatMap((f) => byId.get(f) ?? []);
}

interface AiHost {
  run(command: string, args?: unknown): void;
}

/** The AI panel's tools: each reviews on the timeline (opening its review in the properties panel), then applies. */
export const AI_TOOLS: { id: string; label: string; title: string; art: string; start: (host: AiHost) => void }[] = [
  { id: "silences", label: "Remove Silences", title: "Shorten the pauses in speech, from its transcript (made on this Mac)", art: "remove-silences", start: (host) => review(host, "silences.review") },
  { id: "fillers", label: "Remove Filler Words", title: 'Cut "um", "uh" and the like where the transcript has them', art: "remove-fillers", start: (host) => review(host, "fillers.review") },
  {
    id: "captions",
    label: "Captions",
    title: "Captions from the transcript, a few words at a time, the spoken word highlighted: burned into the export, with an .srt beside it",
    art: "captions",
    start: () => replica.pendCaptions(true),
  },
];

function review(host: AiHost, command: string) {
  host.run(command, {});
  host.run("panel.show", { properties: true });
}
