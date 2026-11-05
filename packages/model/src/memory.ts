import { z } from "zod";

const FormatSchema = z.enum(["short", "long"]);

/** One habit in the user's words, a line of `memory.md`: read by agents before they edit. */
export interface Sentence {
  /** From its text and format: the same line keeps it across reads. */
  id: string;
  text: string;
  /** Only for Shorts (9:16) or long videos; unset: both. */
  format?: Format;
}

/** A sentence an agent proposed, waiting in Settings › Memory for the user to accept or dismiss. */
export const ProposalSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  format: FormatSchema.optional(),
  /** Unix milliseconds. */
  at: z.number(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** `memory.json` in the config folder; the sentences are in `memory.md` beside it, for the user to edit anywhere. */
export const MemoryFileSchema = z.object({
  /** Off: reviews open with Beacon's defaults and no decision is recorded. */
  learning: z.boolean().default(true),
  /** Never read as memory until accepted. */
  proposals: z.array(ProposalSchema).default([]),
  /** Before `memory.md`: moved there on the next change. */
  sentences: z.array(z.object({ text: z.string().min(1), format: FormatSchema.optional() })).optional(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

type Format = z.infer<typeof FormatSchema>;
const SECTIONS: [Format | undefined, string][] = [
  [undefined, "Every video"],
  ["short", "Shorts"],
  ["long", "Long videos"],
];

/**
 * `memory.md`'s sentences: every line that isn't a heading or a comment is one (a list marker taken off), for the kind
 * of video its heading names ("Shorts", "Long videos"; any other heading: every video), so a hand edit loses nothing.
 */
export function readMemoryMarkdown(md: string): Omit<Sentence, "id">[] {
  const out: Omit<Sentence, "id">[] = [];
  let format: Format | undefined;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const h = heading[1]!.toLowerCase();
      format = h.includes("short") ? "short" : h.includes("long") ? "long" : undefined;
      continue;
    }
    if (line.startsWith("<!--")) continue;
    const text = line.replace(/^([-*+]|\d+[.)])\s+/, "").trim();
    if (text && !out.some((s) => s.text === text && s.format === format)) out.push({ text, ...(format ? { format } : {}) });
  }
  return out;
}

/** `memory.md` as Beacon writes it: a section for each kind of video, empty ones kept to write under. */
export function memoryMarkdown(sentences: Omit<Sentence, "id">[]): string {
  const sections = SECTIONS.map(([format, title]) => {
    const lines = sentences.filter((s) => s.format === format).map((s) => `- ${s.text.replace(/\s*\n\s*/g, " ")}`);
    return `## ${title}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
  });
  return `# Memory\n<!-- How I like my videos edited, one habit a line, under the kind of video it is for. Beacon and agents read it; edit it here or in Beacon's Settings › Memory. -->\n\n${sections.join("\n")}`;
}

/** A habit a feature learned from the user's decisions (`Feature.habits`), as Settings › Memory lists it. */
export interface HabitInfo {
  /** Stable across lists: "silence", "filler:um". */
  id: string;
  /** In plain words: "Cuts pauses longer than 1.2 s, keeps shorter ones". */
  text: string;
  /** Decisions agreeing, of all of them. */
  agree: number;
  of: number;
  /** Learned from that format's decisions alone; unset: from every format's (too few of its own yet). */
  format?: "short" | "long";
  /** The decisions' rules it comes from, forgotten when it is reset. */
  rules: string[];
}

/** Everything Settings › Memory shows. */
export interface MemoryState {
  learning: boolean;
  sentences: Sentence[];
  proposals: Proposal[];
  /** `memory.md`'s path, to open in any editor. */
  file: string;
  /** By the format a project is (a Short, a long video). */
  habits: { short: HabitInfo[]; long: HabitInfo[] };
  /** Decisions kept, all formats. */
  decisions: number;
  /** Leader shortcuts learned from the panel items used most: those added, those offered, those gone for going unused. */
  shortcuts: { learned: LearnedShortcut[]; offers: LearnedShortcut[]; removed: LearnedShortcut[] };
}

/** A learned shortcut, or one offered: the panel item it runs, its name and keys (with the leader as it is now). */
export interface LearnedShortcut {
  item: string;
  name: string;
  keys: import("./shortcuts").Keys;
  /** Uses: of the item (an offer), or of the shortcut since it was added. */
  uses: number;
  /** When it was added, or removed. */
  at?: number;
}

const Text = z.string().trim().min(1).max(500);

/** A change to the memory, by the user (Settings) or an agent (who may only propose). */
export const MemoryChangeSchema = z.union([
  z.strictObject({ add: z.strictObject({ text: Text, format: FormatSchema.optional() }) }),
  z.strictObject({ edit: z.strictObject({ id: z.string(), text: Text, format: FormatSchema.nullable().optional() }) }),
  z.strictObject({ remove: z.string() }),
  z.strictObject({ propose: z.strictObject({ text: Text, format: FormatSchema.optional() }) }),
  z.strictObject({ accept: z.string() }),
  z.strictObject({ dismiss: z.string() }),
  z.strictObject({ learning: z.boolean() }),
  /** Forgets the decisions behind a habit (its rules, in its format when learned from that alone), or every one. */
  z.strictObject({ forget: z.union([z.literal("all"), z.strictObject({ rules: z.array(z.string()).min(1), format: FormatSchema.optional() })]) }),
  /**
   * A learned shortcut: an offer added or turned down, one removed by the user (never offered again), or one gone for
   * going unused put back (the toast's Undo). By the panel item it runs.
   */
  z.strictObject({ shortcut: z.union([z.strictObject({ add: z.string() }), z.strictObject({ decline: z.string() }), z.strictObject({ remove: z.string() }), z.strictObject({ restore: z.string() })]) }),
]);
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;
