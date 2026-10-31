import { z } from "zod";

const FormatSchema = z.enum(["short", "long"]);

/** One habit in the user's words, in Settings › Memory: read by agents before they edit. */
export const SentenceSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  /** Only for Shorts (9:16) or long videos; unset: both. */
  format: FormatSchema.optional(),
  /** Written by the user, or proposed by an agent and accepted by them. */
  by: z.enum(["you", "agent"]),
  /** Unix milliseconds. */
  at: z.number(),
});
export type Sentence = z.infer<typeof SentenceSchema>;

/** `memory.json` in the config folder. */
export const MemoryFileSchema = z.strictObject({
  /** Off: reviews open with Beacon's defaults and no decision is recorded. */
  learning: z.boolean().default(true),
  sentences: z.array(SentenceSchema).default([]),
  /** Proposed by agents, waiting for the user to accept or dismiss: never read as memory until accepted. */
  proposals: z.array(SentenceSchema).default([]),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

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
export interface MemoryState extends MemoryFile {
  /** By the format a project is (a Short, a long video). */
  habits: { short: HabitInfo[]; long: HabitInfo[] };
  /** Decisions kept, all formats. */
  decisions: number;
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
]);
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;
