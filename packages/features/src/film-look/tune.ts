import { readFileSync } from "node:fs";
import { jobSignal } from "@beacon/media";

/** The user's pick (2026-10-27): cheaper than Sol, at medium effort as every OpenAI model Beacon calls. */
export const TUNE_MODEL = "gpt-6.1-terra";
/** Its price in dollars a million tokens (developers.openai.com, 2026-10-27): input, cached input, output (reasoning included). */
export const TUNE_PRICE = { input: 1, cached: 0.05, output: 5 };
const api = () => process.env.BEACON_OPENAI_URL ?? "https://api.openai.com/v1";

/** A slider Auto Tune may set: its range and what it does. */
export interface TuneSlider {
  key: string;
  min: number;
  max: number;
  description?: string;
}

/**
 * Film Look's values for a clip, from frames of it as it looks now (OpenAI's vision model on the user's key): the
 * current values, each slider's range and the user's note go with them. Answers values within the ranges, why, and
 * the dollars the call cost.
 */
export async function tuneLook(apiKey: string, frames: string[], current: Record<string, number>, sliders: TuneSlider[], note: string): Promise<{ params: Record<string, number>; why: string; cost: number }> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [...sliders.map((s) => s.key), "why"],
    properties: { ...Object.fromEntries(sliders.map((s) => [s.key, { type: "number", description: `${s.min} to ${s.max}${s.description ? `: ${s.description}` : ""}` }])), why: { type: "string" } },
  };
  const system = [
    "You grade video with a film-look effect: you set its sliders so the footage looks like a good film stock suited to it.",
    "The frames show the clip as it looks now, with the current values applied. Keep within each slider's range. Change only what improves the look; for a screen recording or a talking head keep skin and text natural.",
    note ? "The user says what they want: follow it, starting from the current values." : "No note: pick a tasteful look for this footage, starting from the current values.",
    "In `why`, say in one short sentence what you changed.",
  ].join("\n");
  const text = [`Current values: ${JSON.stringify(current)}`, note ? `The user's note: ${note}` : ""].filter(Boolean).join("\n");
  const res = await fetch(`${api()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TUNE_MODEL,
      reasoning: { effort: "medium" },
      input: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "input_text", text }, ...frames.map((p) => ({ type: "input_image", image_url: `data:image/png;base64,${readFileSync(p).toString("base64")}`, detail: "low" }))] },
      ],
      text: { format: { type: "json_schema", name: "film_look", strict: true, schema } },
    }),
    ...(jobSignal() ? { signal: jobSignal()! } : {}),
  });
  if (res.status === 401) throw new Error("OpenAI refused the API key: check it in Settings › AI");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`OpenAI couldn't tune the look (${res.status}${body ? `: ${body}` : ""})`);
  }
  const reply = (await res.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  const u = reply.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const cost = (((u?.input_tokens ?? 0) - cached) * TUNE_PRICE.input + cached * TUNE_PRICE.cached + (u?.output_tokens ?? 0) * TUNE_PRICE.output) / 1e6;
  const answer = reply.output?.flatMap((o) => (o.type === "message" ? (o.content ?? []) : [])).find((c) => c.type === "output_text")?.text;
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(answer ?? "") as Record<string, unknown>;
  } catch {
    throw new Error("OpenAI's answer wasn't the look asked for: try again");
  }
  // The model's numbers kept within each slider's range.
  const params = Object.fromEntries(sliders.flatMap((s) => (typeof got[s.key] === "number" ? [[s.key, Math.min(s.max, Math.max(s.min, got[s.key] as number))]] : [])));
  return { params, why: typeof got.why === "string" ? got.why : "", cost };
}
