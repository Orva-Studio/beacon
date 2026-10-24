import { jobSignal } from "@beacon/media";

/** The user's pick (2026-10-23), at medium effort as every OpenAI model Beacon calls. */
export const PLAN_MODEL = "gpt-6.1-sol";
const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";
/** How long the planner may send nothing before it is given up; a test shortens it. */
const IDLE_MS = () => Number(process.env.BEACON_OPENAI_IDLE_MS ?? 120_000);

export interface PlannedShot {
  start: number;
  end: number;
  prompt: string;
  why: string;
}

export interface PlanRequest {
  /** The range's words with their timeline times, and a little before and after it. */
  words: { text: string; start: number; end: number }[];
  before: string;
  after: string;
  from: number;
  to: number;
  guide: string;
  research: boolean;
  /** The footage's shape ("16:9") and the lengths a shot may run, in seconds. */
  aspect: string;
  shortest: number;
  longest: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["research", "shots"],
  properties: {
    research: { type: "string", description: "What the research found that the prompts use, in a few lines; empty without research" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "prompt", "why"],
        properties: { start: { type: "number" }, end: { type: "number" }, prompt: { type: "string" }, why: { type: "string" } },
      },
    },
  },
};

const SYSTEM = (r: PlanRequest) =>
  [
    "You plan B-roll for a talking-head or screen-recording video: generated footage shown over a stretch of the talk while the speaker's voice goes on.",
    `Cover ${r.from.toFixed(2)}-${r.to.toFixed(2)} s with shots back to back, no gaps: the first starts at ${r.from.toFixed(2)}, the last ends at ${r.to.toFixed(2)}, each from ${r.shortest} to ${r.longest} s, cut where a sentence or phrase ends (the word times say where).`,
    "Each shot's prompt is for a text-to-video model: one continuous shot (subject, action, setting, camera, light, style), concrete and visual, showing what is being said at that moment.",
    `The footage is ${r.aspect}, silent. Never ask for readable text, captions, logos, user interfaces or real people's faces: these models get them wrong.`,
    r.research
      ? "Search the web first for the names, products, places and terms said, so the prompts show the right thing (what it looks like, where it is); say what you found in `research`."
      : "Leave `research` empty.",
    "`why`: under 12 words, what in the talk the shot illustrates.",
  ].join("\n");

const USER = (r: PlanRequest) =>
  [
    r.guide ? `The editor's guide: ${r.guide}` : "",
    r.before ? `Said just before (context only): ${r.before}` : "",
    "Said over the range, each word with its start time:",
    r.words.map((w) => `${w.start.toFixed(2)} ${w.text}`).join("\n"),
    r.after ? `Said just after (context only): ${r.after}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

/** What the planner is doing, as its streamed events say: thinking, searching the web, then writing the shots. */
export type PlanStage = "thinking" | "searching" | "writing";

/** The stage an event of the Responses API's stream starts, if it starts one. */
const stageOf = (type: string): PlanStage | undefined =>
  type.startsWith("response.web_search_call") ? "searching" : type.startsWith("response.output_text") ? "writing" : type.startsWith("response.reasoning") || type === "response.created" ? "thinking" : undefined;

type Reply = { output?: { type: string; content?: { type: string; text?: string }[] }[] };

/**
 * The finished response from a streamed reply (server-sent events), telling `stage` as the stream moves on; a plain
 * JSON reply (a stand-in's) is taken as it is.
 */
async function streamed(res: Response, stage: (s: PlanStage) => void, alive: () => void): Promise<Reply> {
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return (await res.json()) as Reply;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let last: PlanStage | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("OpenAI's answer stopped before it was finished");
    alive();
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type: string; response?: Reply & { error?: { message?: string } } };
      if (event.type === "response.completed") return event.response!;
      if (event.type === "response.failed" || event.type === "error") throw new Error(`OpenAI couldn't plan the shots: ${event.response?.error?.message ?? "no reason given"}`);
      const next = stageOf(event.type);
      if (next && next !== last) stage((last = next));
    }
  }
}

/** A shot list from OpenAI's Responses API (its web search when asked), as JSON to the schema, its stages told as it goes. */
export async function planShots(r: PlanRequest, apiKey: string, stage: (s: PlanStage) => void = () => {}): Promise<{ research: string; shots: PlannedShot[] }> {
  const job = jobSignal();
  // Given up only after IDLE_MS with nothing from OpenAI: research can take minutes, each event says it is still going.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_MS());
  };
  alive();
  try {
    return await ask(r, apiKey, stage, alive, AbortSignal.any([idle.signal, ...(job ? [job] : [])]));
  } catch (e) {
    job?.throwIfAborted();
    if (idle.signal.aborted) throw new Error(`OpenAI sent nothing for ${Math.round(IDLE_MS() / 60_000)} minutes while planning: try again`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ask(r: PlanRequest, apiKey: string, stage: (s: PlanStage) => void, alive: () => void, signal: AbortSignal): Promise<{ research: string; shots: PlannedShot[] }> {
  const res = await fetch(`${api()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PLAN_MODEL,
      reasoning: { effort: "medium" },
      stream: true,
      ...(r.research ? { tools: [{ type: "web_search" }] } : {}),
      input: [
        { role: "system", content: SYSTEM(r) },
        { role: "user", content: USER(r) },
      ],
      text: { format: { type: "json_schema", name: "broll_plan", strict: true, schema: SCHEMA } },
    }),
    signal,
  });
  if (res.status === 401) throw new Error("OpenAI refused the API key: check it in Settings › AI");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = (() => {
      try {
        return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
      } catch {
        return undefined;
      }
    })();
    throw new Error(`OpenAI couldn't plan the shots (${res.status}${message ? `: ${message}` : ""})`);
  }
  const reply = await streamed(res, stage, alive);
  const text = reply.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : [])).find((c) => c.type === "output_text")?.text;
  try {
    const out = JSON.parse(text ?? "") as { research?: string; shots?: PlannedShot[] };
    return { research: String(out.research ?? ""), shots: (out.shots ?? []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.prompt === "string") };
  } catch {
    throw new Error("OpenAI's shot list wasn't JSON");
  }
}

/**
 * The planned shots made to tile [from, to] exactly: sorted, each starting where the one before ends, none
 * longer than `longest` (split evenly) or shorter than `shortest` (merged into the one before, or after for the first).
 */
export function tile(shots: PlannedShot[], from: number, to: number, shortest: number, longest: number): PlannedShot[] {
  const sorted = shots.filter((s) => s.end > from && s.start < to && s.prompt.trim()).sort((a, b) => a.start - b.start);
  // Each starts where the last one kept ends: a shot inside the one before ([0, 8] then [2, 4]) is dropped, not overlapped.
  let out: PlannedShot[] = [];
  let at = from;
  for (const s of sorted) {
    const end = Math.min(to, s.end);
    if (end - at <= 1e-3) continue;
    out.push({ ...s, start: at, end });
    at = end;
  }
  if (!out.length) return [];
  out[out.length - 1] = { ...out.at(-1)!, end: to };
  // Short ones join a neighbour; a range shorter than `shortest` stays one shot.
  for (let i = 0; i < out.length && out.length > 1; ) {
    if (out[i]!.end - out[i]!.start >= shortest - 1e-3) i++;
    else if (i > 0) out = [...out.slice(0, i - 1), { ...out[i - 1]!, end: out[i]!.end }, ...out.slice(i + 1)];
    else out = [{ ...out[1]!, start: out[0]!.start }, ...out.slice(2)];
  }
  return out.flatMap((s) => {
    const n = Math.ceil((s.end - s.start) / longest - 1e-6);
    const each = (s.end - s.start) / n;
    return Array.from({ length: n }, (_, k) => ({ ...s, start: s.start + k * each, end: k === n - 1 ? s.end : s.start + (k + 1) * each }));
  });
}
