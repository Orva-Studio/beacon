import { jobSignal } from "@beacon/media";

/** The user's pick (2026-10-23), at medium effort as every OpenAI model Beacon calls. */
export const PLAN_MODEL = "gpt-6.1-sol";
const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";

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

/** A shot list from OpenAI's Responses API (its web search when asked), as JSON to the schema. */
export async function planShots(r: PlanRequest, apiKey: string): Promise<{ research: string; shots: PlannedShot[] }> {
  const job = jobSignal();
  const res = await fetch(`${api()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PLAN_MODEL,
      reasoning: { effort: "medium" },
      ...(r.research ? { tools: [{ type: "web_search" }] } : {}),
      input: [
        { role: "system", content: SYSTEM(r) },
        { role: "user", content: USER(r) },
      ],
      text: { format: { type: "json_schema", name: "broll_plan", strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(job ? [job] : [])]),
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
  const reply = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
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
