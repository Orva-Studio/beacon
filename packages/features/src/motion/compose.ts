import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { jobSignal, runTool, tool } from "@beacon/media";
import { PLAN_MODEL, PLAN_PRICE } from "../broll/plan";
import { KIND_GUIDE, KINDS, PieceSchema, tidy, type Piece } from "./blocks";
import { examples, INDEX, named, type CatalogItem } from "./catalog";
import { CRAFT } from "./craft";
import { CONTRACT, css, fill, template, wantsAlpha } from "./html";
import type { Look } from "./looks";
import { TOOLS, WEB_GUIDE, Web } from "./web";

const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";
/** Claude's best model for design and code (2026-10-26), at the same medium effort as OpenAI's. */
export const CLAUDE_MODEL = "claude-opus-5-5";
/** Its price in dollars a million tokens (claude.com, 2026-10-26): input, written to the cache, read from it, output (thinking included). */
const CLAUDE_PRICE = { input: 4, cacheWrite: 5, cached: 0.2, output: 20 };
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

/** Dollars spent on OpenAI or Claude for one job, added to by each call it makes. */
export interface Meter {
  cost: number;
}

/** One question to the model that writes motion graphics, answered as JSON to `schema`; the user's turn is text and any images. */
export type Ask = <T>(name: string, schema: object, system: string, text: string, images?: string[], effort?: "low" | "medium", web?: Web) => Promise<T>;

/** An image file's media type and its bytes in base64. */
function imageData(path: string) {
  const ext = extname(path).slice(1).toLowerCase();
  return { mime: ext === "jpg" ? "image/jpeg" : `image/${ext}`, data: readFileSync(path).toString("base64") };
}

/** OpenAI's Responses API, answering JSON to `schema`; with `web`, it may call its tools first, round by round. */
async function openai<T>(apiKey: string, name: string, schema: object, system: string, text: string, images: string[], effort: string, meter?: Meter, web?: Web): Promise<T> {
  const user = images.length
    ? [{ type: "input_text", text }, ...images.map((p) => ({ type: "input_image", image_url: `data:${imageData(p).mime};base64,${imageData(p).data}`, detail: "high" }))]
    : text;
  const input: object[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  for (let round = 0; ; round++) {
    const res = await fetch(`${api()}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PLAN_MODEL,
        reasoning: { effort },
        input,
        text: { format: { type: "json_schema", name, strict: true, schema } },
        ...(web ? { tools: TOOLS.map((t) => ({ type: "function", ...t, strict: true })), tool_choice: web.more(round) ? "auto" : "none" } : {}),
      }),
      ...(jobSignal() ? { signal: jobSignal()! } : {}),
    });
    if (res.status === 401) throw new Error("OpenAI refused the API key: check it in Settings › AI");
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`OpenAI couldn't write the motion graphic (${res.status}${body ? `: ${body}` : ""})`);
    }
    const reply = (await res.json()) as {
      output?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    };
    const u = reply.usage;
    if (u && meter) {
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      meter.cost += (((u.input_tokens ?? 0) - cached) * PLAN_PRICE.input + cached * PLAN_PRICE.cached + (u.output_tokens ?? 0) * PLAN_PRICE.output) / 1e6;
    }
    const calls = (reply.output ?? []).filter((o) => o.type === "function_call");
    if (web && calls.length) {
      input.push(...(reply.output ?? []));
      for (const c of calls) input.push({ type: "function_call_output", call_id: c.call_id, output: await web.run(c.name ?? "", parseArgs(c.arguments)) });
      continue;
    }
    const answer = reply.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : [])).find((c) => c.type === "output_text")?.text;
    try {
      return JSON.parse(answer ?? "") as T;
    } catch {
      throw new Error("OpenAI's answer wasn't JSON");
    }
  }
}

const parseArgs = (json: string | undefined): Record<string, unknown> => {
  try {
    const v = JSON.parse(json ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Claude through Anthropic's Messages API, streamed (a long answer), answering JSON to `schema`; with `web`, it may call its tools first. */
async function claude<T>(apiKey: string, schema: object, system: string, text: string, images: string[], effort: "low" | "medium", meter?: Meter, web?: Web): Promise<T> {
  const client = new Anthropic({ apiKey, ...(process.env.BEACON_ANTHROPIC_URL ? { baseURL: process.env.BEACON_ANTHROPIC_URL } : {}) });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((p): Anthropic.Beta.BetaContentBlockParam => ({ type: "image", source: { type: "base64", media_type: imageData(p).mime as "image/png", data: imageData(p).data } })),
    { type: "text", text },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
  for (let round = 0; ; round++) {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await client.beta.messages
        .stream(
          {
            model: CLAUDE_MODEL,
            max_tokens: 64000,
            // When a safety classifier declines, the request runs again on a model Anthropic picks for that.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive" },
            output_config: { effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
            system,
            messages,
            ...(web
              ? {
                  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true })),
                  tool_choice: web.more(round) ? { type: "auto" as const } : { type: "none" as const },
                }
              : {}),
          },
          jobSignal() ? { signal: jobSignal()! } : {},
        )
        .finalMessage();
    } catch (e) {
      jobSignal()?.throwIfAborted();
      if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic refused the API key: check it in Settings › AI");
      if (e instanceof Anthropic.APIError) throw new Error(`Claude couldn't write the motion graphic (${e.status ?? "no answer"}: ${e.message.slice(0, 300)})`);
      throw e;
    }
    const u = msg.usage;
    if (meter) meter.cost += (u.input_tokens * CLAUDE_PRICE.input + (u.cache_creation_input_tokens ?? 0) * CLAUDE_PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * CLAUDE_PRICE.cached + u.output_tokens * CLAUDE_PRICE.output) / 1e6;
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to write this motion graphic: reword the prompt, or make it with OpenAI");
    if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer ran too long: try again, or ask for a simpler graphic");
    if (web && msg.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const b of msg.content) {
        if (b.type !== "tool_use") continue;
        // Streamed tool input can come back cut short: anything that isn't an object is answered as an error.
        const ok = b.input && typeof b.input === "object" && !Array.isArray(b.input);
        results.push({ type: "tool_result", tool_use_id: b.id, ...(ok ? { content: await web.run(b.name, b.input as Record<string, unknown>) } : { content: "error: the tool's input wasn't valid JSON: call it again", is_error: true }) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const answer = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      return JSON.parse(answer) as T;
    } catch {
      throw new Error("Claude's answer wasn't JSON");
    }
  }
}

/** Who writes motion graphics, by the user's choice: OpenAI or Claude, with the user's key. */
export function author(planner: string, apiKey: string, meter?: Meter): Ask {
  return (name, schema, system, text, images = [], effort = "medium", web) =>
    planner === "claude" ? claude(apiKey, schema, system, text, images, effort, meter, web) : openai(apiKey, name, schema, system, text, images, effort, meter, web);
}

const IDEA_SCHEMA = { type: "object", additionalProperties: false, required: ["prompt", "why"], properties: { prompt: { type: "string" }, why: { type: "string" } } };

/** Auto's prompt: one sentence saying what graphic shows what is said under the clip, with its exact words. */
export async function writeIdea(said: Said, planner: string, key: () => Promise<string>, meter?: Meter): Promise<{ prompt: string; why: string }> {
  const system = [
    "You suggest one on-screen motion graphic for a talking-head or screen-recording video, shown over the talk while the speaker says it.",
    `It is made from these, alone or together:\n${VOCABULARY}`,
    "Write one sentence, under 30 words, saying what it shows and its exact words or figures (short: a title is 2 to 6 words). `why`: under 12 words, what in the talk it shows.",
  ].join("\n");
  const user = [said.before ? `Said just before (context only): ${said.before}` : "", `Said under the clip: ${saidText(said)}`, said.after ? `Said just after (context only): ${said.after}` : ""].filter(Boolean).join("\n\n");
  const out = planner === "apple" ? await onDevice<{ prompt: string; why: string }>("idea", system, user) : await author(planner, await key(), meter)<{ prompt: string; why: string }>("motion_idea", IDEA_SCHEMA, system, user);
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
  /** An image whose design the graphic recreates (OpenAI or Claude). */
  reference?: string;
  /** The user's skill whose look and rules it follows. */
  skill?: { name: string; text: string };
}

const PICK_SCHEMA = { type: "object", additionalProperties: false, required: ["names"], properties: { names: { type: "array", items: { type: "string" } } } };

/** Catalog items to adapt for a brief: those it names, else up to three the author picks from the catalog's index as fitting it. */
async function references(brief: string, ask: Ask): Promise<CatalogItem[]> {
  const asked = named(brief);
  if (asked.length) return asked.slice(0, 3);
  const system = [
    "You pick examples for a motion designer from a catalog of HyperFrames blocks (whole compositions) and components (effects and pieces). Pick up to three whose code would help most to make the graphic briefed: the same kind of graphic, or an effect it needs. None when nothing fits.",
    `The catalog, one a line:\n${INDEX}`,
    "Answer `names`: the picked items' names, exactly as listed.",
  ].join("\n\n");
  try {
    const { names } = await ask<{ names: string[] }>("motion_examples", PICK_SCHEMA, system, `The graphic: ${brief}`, [], "low");
    return names.flatMap((n) => named(n)).slice(0, 3);
  } catch (e) {
    jobSignal()?.throwIfAborted();
    // Examples only help: the graphic is still written without them.
    return [];
  }
}

const HTML_SCHEMA = { type: "object", additionalProperties: false, required: ["html"], properties: { html: { type: "string" } } };

/** The author's standing instructions, the same whoever writes it: the box, the contract, the craft and its tools. */
function standing(r: ComposeRequest, reference: boolean): string {
  return [
    `You design one on-screen motion graphic for a talking-head or screen-recording video: an HTML composition drawn over the video in a box ${Math.round(r.width)}×${Math.round(r.height)} px, for ${r.length.toFixed(2)} s. Its default design is the "${r.look.name}" Look (${r.look.description}); the brief overrides it.`,
    CONTRACT,
    CRAFT,
    `Kinds that often fit graphics over a talk: ${KINDS.map((k) => `${k} (${KIND_GUIDE[k]})`).join("; ")}; follow the brief when it asks for something else.`,
    ...(reference
      ? [
          "A reference image is attached: recreate its design as closely as you can in HTML, CSS and SVG (its layout, type, colours, shapes, textures and the feel of its imagery), fitted to this box, then bring it to life: build it up piece by piece and keep it moving, following the craft above. The brief says what it shows and what to change; where the brief and the image differ, the brief wins. Draw everything yourself: the image itself isn't in the page.",
        ]
      : []),
    ...(r.skill
      ? [
          `Follow the user's own skill, "${r.skill.name}", below: its design (palette, materials, type, layout, motion) and its rules win over the Look and the craft above, but not over the contract. It was written for another tool: ignore what it says about files, folders, transcribing, audio, rendering, linting or commands; you write only this page.\n\n<skill>\n${r.skill.text}\n</skill>`,
        ]
      : []),
    WEB_GUIDE,
    "Time it to the speech: words come in as they are said (data-t from the word times), so the text follows the voice; whatever holds them comes in with them.",
    "Answer with `html`: the inside of <body> only.",
  ].join("\n\n");
}

const saidLines = (said: Said) => (said.words.length ? `Said under the clip, each word with its time in seconds from the clip's start:\n${timed(said)}` : "Nothing is said under the clip: time it evenly.");

/** What the author is asked, the same whoever writes it: the contract, the craft and the brief with its examples. */
export async function authorBrief(r: ComposeRequest, ask: Ask): Promise<{ system: string; user: string }> {
  const system = standing(r, !!r.reference);
  const refs = await references(r.prompt, ask);
  const user = [
    `The graphic: ${r.prompt}`,
    saidLines(r.said),
    refs.length
      ? `Examples to adapt (a named one is the base to build on; the others show techniques). They were written for HyperFrames: its data-start, data-duration and data-composition-id attributes mean nothing here, but gsap, THREE and window.__timelines work as they do there. Rewrite them to this page's contract, at this box's size and length; never copy their <html>, <head> or external scripts.\n\n${examples(refs)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

/**
 * A made graphic changed as `note` asks, the rest kept: OpenAI or Claude is given its composition (images it holds
 * swapped for asset ids, so they aren't sent) with the same standing instructions, and answers the whole of it again.
 */
export async function revise(r: ComposeRequest, html: string, note: string, planner: string, key: () => Promise<string>, meter?: Meter, web?: { key?: string; progress?: (stage: string) => void }): Promise<string> {
  if (planner === "apple") throw new Error("Revise needs OpenAI or Claude: choose one in Settings › AI (Apple's model only fills templates)");
  const ask = author(planner, await key(), meter);
  const tools = new Web(web?.key, web?.progress);
  const system = [
    standing(r, false),
    "You are revising a graphic already made: make the change asked, and keep everything else exactly as it is (its design, layout, timing, colours and code) unless the change needs it to move. Answer the whole revised composition.",
  ].join("\n\n");
  const user = [`The graphic was briefed as: ${r.prompt}`, `It is now:\n\n${tools.keep(html)}`, `The change: ${note}`, saidLines(r.said)].join("\n\n");
  const out = await ask<{ html: string }>("motion_graphic", HTML_SCHEMA, system, user, [], "medium", tools);
  const revised = tools.resolve(String(out.html ?? "").trim());
  if (!revised) throw new Error(`${planner === "claude" ? "Claude" : "OpenAI"} wrote no motion graphic: try again, or reword the change`);
  return revised.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
}

/**
 * The graphic's composition (the inside of its page's <body>) from its prompt: OpenAI or Claude writes it, the Look its default
 * design and the prompt overriding it, timed to the words; Apple's smaller model picks the one kind it is and its words, which a template lays out
 * over the whole clip and box.
 */
export async function compose(r: ComposeRequest, planner: string, key: () => Promise<string>, meter?: Meter, web?: { key?: string; progress?: (stage: string) => void }): Promise<string> {
  if (planner === "apple") {
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
  const ask = author(planner, await key(), meter);
  const { system, user } = await authorBrief(r, ask);
  const tools = new Web(web?.key, web?.progress);
  const out = await ask<{ html: string }>("motion_graphic", HTML_SCHEMA, system, user, r.reference ? [r.reference] : [], "medium", tools);
  const html = tools.resolve(String(out.html ?? "").trim());
  if (!html) throw new Error(`${planner === "claude" ? "Claude" : "OpenAI"} wrote no motion graphic: try again, or reword the prompt`);
  // Its own document wrapper, if it wrote one anyway: only the inside of <body> is kept.
  return html.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
}
