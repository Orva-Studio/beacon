import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobSignal, runTool, tool } from "@beacon/media";
import { PLAN_MODEL } from "../broll/plan";
import { KIND_GUIDE, KINDS, PieceSchema, tidy, type Piece } from "./blocks";
import { examples, INDEX, named, type CatalogItem } from "./catalog";
import { CRAFT } from "./craft";
import { CONTRACT, css, fill, template, wantsAlpha } from "./html";
import type { Look } from "./looks";

const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";
const writer = () => process.env.BEACON_WRITER ?? tool("beacon-writer");

export interface Said {
  /** Words said under the clip, their times in seconds from its start. */
  words: { text: string; start: number; end: number }[];
  /** A little said before and after, for context. */
  before: string;
  after: string;
}

const saidText = (s: Said) => s.words.map((w) => w.text).join(" ");
const timed = (s: Said) => s.words.map((w) => `${w.start.toFixed(2)} ${w.text}`).join("\n");

const VOCABULARY = KINDS.map((k) => `- ${k}: ${KIND_GUIDE[k]}`).join("\n");

/** Apple's on-device model through beacon-writer; says what to turn on (or pick instead) when it can't run. */
async function onDevice<T>(kind: string, instructions: string, prompt: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "beacon-motion-"));
  try {
    const request = join(dir, "request.json");
    writeFileSync(request, JSON.stringify({ kind, instructions, prompt }));
    try {
      return JSON.parse(await runTool([writer(), request])) as T;
    } catch (e) {
      jobSignal()?.throwIfAborted();
      throw new Error((e as Error).message.replace(/^.*? exited with \d+: /, "").replace("the B-roll planner", "the planner"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** OpenAI's Responses API, answering JSON to `schema`. */
async function openai<T>(apiKey: string, name: string, schema: object, system: string, user: string, effort = "medium"): Promise<T> {
  const res = await fetch(`${api()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PLAN_MODEL,
      reasoning: { effort },
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: { format: { type: "json_schema", name, strict: true, schema } },
    }),
    ...(jobSignal() ? { signal: jobSignal()! } : {}),
  });
  if (res.status === 401) throw new Error("OpenAI refused the API key: check it in Settings › AI");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`OpenAI couldn't write the motion graphic (${res.status}${body ? `: ${body}` : ""})`);
  }
  const reply = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text = reply.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : [])).find((c) => c.type === "output_text")?.text;
  try {
    return JSON.parse(text ?? "") as T;
  } catch {
    throw new Error("OpenAI's answer wasn't JSON");
  }
}

const IDEA_SCHEMA = { type: "object", additionalProperties: false, required: ["prompt", "why"], properties: { prompt: { type: "string" }, why: { type: "string" } } };

/** Auto's prompt: one sentence saying what graphic shows what is said under the clip, with its exact words. */
export async function writeIdea(said: Said, planner: string, key: () => Promise<string>): Promise<{ prompt: string; why: string }> {
  const system = [
    "You suggest one on-screen motion graphic for a talking-head or screen-recording video, shown over the talk while the speaker says it.",
    `It is made from these, alone or together:\n${VOCABULARY}`,
    "Write one sentence, under 30 words, saying what it shows and its exact words or figures (short: a title is 2 to 6 words). `why`: under 12 words, what in the talk it shows.",
  ].join("\n");
  const user = [said.before ? `Said just before (context only): ${said.before}` : "", `Said under the clip: ${saidText(said)}`, said.after ? `Said just after (context only): ${said.after}` : ""].filter(Boolean).join("\n\n");
  const out = planner === "openai" ? await openai<{ prompt: string; why: string }>(await key(), "motion_idea", IDEA_SCHEMA, system, user) : await onDevice<{ prompt: string; why: string }>("idea", system, user);
  if (!out.prompt?.trim()) throw new Error("no motion graphic was suggested: type one (Manual)");
  return { prompt: out.prompt.trim(), why: String(out.why ?? "") };
}

/** Only what a kind uses, the rest emptied: the on-device model fills fields it shouldn't. */
function forKind(p: Piece, prompt: string): Piece {
  const empty: Piece = { ...p, detail: "", value: 0, prefix: "", suffix: "", items: [] };
  switch (p.kind) {
    case "title":
    case "lowerThird":
      return { ...empty, detail: p.detail };
    case "number": {
      // A sign the prompt doesn't have was made up; the figure isn't repeated in its label.
      const keep = (s: string) => (s && prompt.includes(s.trim()) ? s.trim() : "");
      const label = p.text.replace(/^[^A-Za-z]*\d[\d.,]*\s*[%x×]?\s*/u, "").trim();
      return { ...empty, text: label, value: p.value, prefix: keep(p.prefix), suffix: keep(p.suffix) };
    }
    case "list":
      return { ...empty, text: "", items: p.items };
    case "text":
      return empty;
  }
}

export interface ComposeRequest {
  prompt: string;
  said: Said;
  length: number;
  width: number;
  height: number;
  look: Look;
}

const PICK_SCHEMA = { type: "object", additionalProperties: false, required: ["names"], properties: { names: { type: "array", items: { type: "string" } } } };

/** Catalog items to adapt for a brief: those it names, else up to three OpenAI picks from the catalog's index as fitting it. */
async function references(brief: string, apiKey: string): Promise<CatalogItem[]> {
  const asked = named(brief);
  if (asked.length) return asked.slice(0, 3);
  const system = [
    "You pick examples for a motion designer from a catalog of HyperFrames blocks (whole compositions) and components (effects and pieces). Pick up to three whose code would help most to make the graphic briefed: the same kind of graphic, or an effect it needs. None when nothing fits.",
    `The catalog, one a line:\n${INDEX}`,
    "Answer `names`: the picked items' names, exactly as listed.",
  ].join("\n\n");
  try {
    const { names } = await openai<{ names: string[] }>(apiKey, "motion_examples", PICK_SCHEMA, system, `The graphic: ${brief}`, "low");
    return names.flatMap((n) => named(n)).slice(0, 3);
  } catch (e) {
    jobSignal()?.throwIfAborted();
    // Examples only help: the graphic is still written without them.
    return [];
  }
}

const HTML_SCHEMA = { type: "object", additionalProperties: false, required: ["html"], properties: { html: { type: "string" } } };

/**
 * The graphic's composition (the inside of its page's <body>) from its prompt: OpenAI writes it, the Look its default
 * design and the prompt overriding it, timed to the words; Apple's smaller model picks the one kind it is and its words, which a template lays out
 * over the whole clip and box.
 */
export async function compose(r: ComposeRequest, planner: string, key: () => Promise<string>): Promise<string> {
  if (planner !== "openai") {
    const piece = await onDevice<Omit<Piece, "start" | "end" | "area">>(
      "piece",
      "You turn a description of an on-screen motion graphic into the one graphic it is, and its exact words. A figure (a number, a percentage, an amount) is a number; a person's name is a lowerThird; things listed are a list. Keep words short: a title is 2 to 6 words.",
      r.prompt,
    );
    const p = PieceSchema.safeParse({ ...piece, start: 0, end: r.length, area: "full" });
    const usable = p.success ? tidy(forKind(p.data, r.prompt), r.length) : undefined;
    if (!usable) throw new Error("Apple's on-device model wrote a graphic Beacon can't draw: try again, or reword the prompt");
    const background = wantsAlpha(r.prompt) ? "" : fill(css(r.look.card, 1));
    return background + template(usable, r.said.words, r);
  }
  const system = [
    `You design one on-screen motion graphic for a talking-head or screen-recording video: an HTML composition drawn over the video in a box ${Math.round(r.width)}×${Math.round(r.height)} px, for ${r.length.toFixed(2)} s. Its default design is the "${r.look.name}" Look (${r.look.description}); the brief overrides it.`,
    CONTRACT,
    CRAFT,
    `Kinds that often fit graphics over a talk: ${KINDS.map((k) => `${k} (${KIND_GUIDE[k]})`).join("; ")}; follow the brief when it asks for something else.`,
    "Time it to the speech: words come in as they are said (data-t from the word times), so the text follows the voice; whatever holds them comes in with them.",
    "Answer with `html`: the inside of <body> only.",
  ].join("\n\n");
  const apiKey = await key();
  const refs = await references(r.prompt, apiKey);
  const user = [
    `The graphic: ${r.prompt}`,
    r.said.words.length ? `Said under the clip, each word with its time in seconds from the clip's start:\n${timed(r.said)}` : "Nothing is said under the clip: time it evenly.",
    refs.length
      ? `Examples to adapt (a named one is the base to build on; the others show techniques). They were written for HyperFrames: its data-start, data-duration and data-composition-id attributes mean nothing here, but gsap, THREE and window.__timelines work as they do there. Rewrite them to this page's contract, at this box's size and length; never copy their <html>, <head> or external scripts.\n\n${examples(refs)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await openai<{ html: string }>(apiKey, "motion_graphic", HTML_SCHEMA, system, user);
  const html = String(out.html ?? "").trim();
  if (!html) throw new Error("OpenAI wrote no motion graphic: try again, or reword the prompt");
  // Its own document wrapper, if it wrote one anyway: only the inside of <body> is kept.
  return html.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
}
