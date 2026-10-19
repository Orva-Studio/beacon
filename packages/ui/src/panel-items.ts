import type { PanelItem } from "./drop";
import type { Init } from "./rpc";
import { replica } from "./store";
import { isPanelEffect } from "@beacon/model";

/** A panel item with its tooltip, its tile's picture (`art/<art>.webp`) and what favourites call it (`LocalCore.favorites`). */
export type Item = PanelItem & { title: string; art?: string; favorite: string };

/** The features' items of one panel (`annotation:` or `audio:`), its tile's picture named after what follows. */
function featureItems(init: Init | undefined, panel: "annotation" | "audio"): Item[] {
  return (init?.panelItems ?? [])
    .filter((it) => it.id.startsWith(`${panel}:`))
    .map((it) => ({
      label: it.label,
      title: it.title,
      art: it.id.slice(panel.length + 1),
      favorite: it.id,
      command: it.command,
      args: it.args,
      traits: it.traits ?? [],
      ...(it.seconds ? { media: { seconds: it.seconds } } : {}),
    }));
}

/** The Annotations panel: presets of `edit.addAnnotation`, so agents add the same ones. */
export const annotations = (init: Init | undefined) => featureItems(init, "annotation");

export const audioEffects = (init: Init | undefined) => featureItems(init, "audio");

/** The Visual Effects panel: every effect but the cursor's own (those are on the Cursor tab). */
export const visualEffects = (init: Init | undefined): Item[] =>
  (init?.effects ?? [])
    .filter((e) => isPanelEffect(e.traits))
    .map((e) => ({ label: e.title, title: e.description, art: e.id, favorite: `effect:${e.id}`, command: "edit.addEffect", args: { type: e.id }, traits: e.traits }));

/** Every item of the Annotations, Visual Effects and Audio Effects panels, with its panel's name. */
export const allItems = (init: Init | undefined): (Item & { group: string })[] => [
  ...annotations(init).map((it) => ({ ...it, group: "Annotation" })),
  ...visualEffects(init).map((it) => ({ ...it, group: "Visual Effect" })),
  ...audioEffects(init).map((it) => ({ ...it, group: "Audio Effect" })),
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
