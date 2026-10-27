import data from "./catalog.json";

/** A block or component from HyperFrames' registry (see scripts/vendor-motion-catalog.ts): an example to adapt. */
export interface CatalogItem {
  name: string;
  kind: "block" | "component";
  title: string;
  description: string;
  tags: string[];
  /** The license its registry entry declares beside HyperFrames' Apache 2.0 (an SPDX expression), and whose it is. */
  license?: string;
  author?: string;
  authorUrl?: string;
  duration?: number;
  size?: [number, number];
  /** Images, sounds and fonts it uses that aren't in the catalog. */
  missing: string[];
  html: string;
}

export const CATALOG = data.items as CatalogItem[];

/** The catalog's items a brief names (`apple-money-count`, "the x-post block"), in the order it names them. */
export function named(brief: string): CatalogItem[] {
  const text = brief.toLowerCase();
  return CATALOG.filter((i) => new RegExp(`(^|[^a-z0-9-])${i.name}($|[^a-z0-9-])`).test(text)).sort((a, b) => text.indexOf(a.name) - text.indexOf(b.name));
}

/** One line an item, for picking from. */
export const INDEX = CATALOG.map((i) => `${i.name} (${i.kind}): ${i.title}. ${i.description}${i.tags.length ? ` [${i.tags.join(", ")}]` : ""}`).join("\n");

/** Items as the author is shown them: what each is, what it lacks here, and its source. */
export function examples(items: CatalogItem[]): string {
  return items
    .map(
      (i) =>
        `### ${i.name}: ${i.title}\n${i.description}${i.size ? ` (${i.size[0]}×${i.size[1]}${i.duration ? `, ${i.duration} s` : ""})` : ""}${i.missing.length ? `\nIts files ${i.missing.join(", ")} aren't available: draw or leave out what they show.` : ""}\n${i.html}`,
    )
    .join("\n\n");
}
