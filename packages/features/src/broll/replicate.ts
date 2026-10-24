import { jobSignal } from "@beacon/media";
import type { VideoModel } from "./models";

/** Replicate's API; a test points it at a stand-in. */
const api = () => process.env.BEACON_REPLICATE_URL ?? "https://api.replicate.com/v1";
const POLL_MS = () => Number(process.env.BEACON_REPLICATE_POLL_MS ?? 3000);
/** Generations take a minute or several; past this one is given up (and cancelled on Replicate, so it stops charging). */
const GIVE_UP_MS = 20 * 60_000;

/** `cancellable`: false lets a request the job no longer wants finish anyway (a prediction's creation, to cancel it by its id). */
async function call<T>(token: string, url: string, init: RequestInit = {}, cancellable = true): Promise<T> {
  const job = cancellable ? jobSignal() : undefined;
  let r: Response;
  try {
    r = await fetch(url.startsWith("http") ? url : `${api()}${url}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(job ? [job] : [])]),
    });
  } catch (e) {
    job?.throwIfAborted();
    if ((e as Error).name === "TimeoutError") throw new Error(`Replicate didn't answer within a minute (${init.method === "POST" ? "starting it" : "asking how it is going"}): try again`);
    throw new Error(`couldn't reach Replicate: ${(e as Error).message}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("Replicate refused the API token: check it in Settings › AI");
  if (r.status === 402) throw new Error("Replicate says the account needs credit or billing set up (replicate.com/account/billing)");
  if (!r.ok) {
    const body = await r.text();
    const detail = (() => {
      try {
        return (JSON.parse(body) as { detail?: string }).detail;
      } catch {
        return body.slice(0, 300);
      }
    })();
    throw new Error(`Replicate: ${r.status}${detail ? ` ${detail}` : ""}`);
  }
  return (await r.json()) as T;
}

type Property = { enum?: unknown[]; minimum?: number; maximum?: number; allOf?: { $ref?: string }[]; $ref?: string; type?: string };

/** What the model's live schema takes, over the table's. */
export interface Limits {
  /** Empty: it picks its own shape ("adaptive" alone), so none is sent. */
  aspects: string[];
  durations: number[];
  /** Its duration is a string ("5", FLUX 3's), not a number. */
  durationText: boolean;
  /** The resolutions it lists, if it lists them. */
  resolutions?: string[];
  fields: Set<string>;
}

/**
 * The shapes, lengths and resolutions the model's live schema allows, over the table's: Cog writes an enum as a
 * `$ref` to a schema of its own, a number range as minimum/maximum. Fields the schema doesn't have aren't sent.
 */
export async function limits(token: string, m: VideoModel): Promise<Limits> {
  const info = await call<{ latest_version?: { openapi_schema?: { components?: { schemas?: Record<string, { properties?: Record<string, Property>; enum?: unknown[] }> } } } }>(token, `/models/${m.slug}`);
  const schemas = info.latest_version?.openapi_schema?.components?.schemas ?? {};
  const props = schemas.Input?.properties;
  if (!props) return { aspects: m.aspects, durations: m.durations, durationText: false, fields: new Set(["prompt", "aspect_ratio", "duration", "generate_audio", ...Object.values(m.resolutions).flatMap((r) => Object.keys(r!))]) };
  const enumOf = (p?: Property) => {
    const ref = p?.$ref ?? p?.allOf?.[0]?.$ref;
    return p?.enum ?? (ref ? schemas[ref.split("/").pop()!]?.enum : undefined);
  };
  const shapes = enumOf(props.aspect_ratio) as string[] | undefined;
  const d = props.duration;
  const lengths = enumOf(d);
  const listed = lengths?.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const durations = listed?.length ? [...listed].sort((a, b) => a - b) : d?.minimum !== undefined && d.maximum !== undefined ? m.durations.filter((x) => x >= d.minimum! && x <= d.maximum!) : m.durations;
  const resolutions = (enumOf(props.resolution) as string[] | undefined)?.filter((r) => typeof r === "string");
  return {
    // Listed without a single ratio ("adaptive", "auto"): the model picks.
    aspects: shapes ? shapes.filter((a) => /^\d+:\d+$/.test(a)) : m.aspects,
    durations: durations.length ? durations : m.durations,
    durationText: d?.type === "string" || typeof lengths?.[0] === "string",
    ...(resolutions?.length ? { resolutions } : {}),
    fields: new Set(Object.keys(props)),
  };
}

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

/** Where a generation is: sent and waiting its turn, being made, or downloading. */
export type MakeStage = "queued" | "making" | "downloading";

/** Checks of how it is going that fail in a row (Replicate slow or unreachable) before the generation is given up. */
const MISSES = 5;

/**
 * Runs the model with `input` and downloads what it makes to `out`; `stage` is told where it is at each check. Cancelled
 * on Replicate if the job is. A check that fails is tried again: one slow answer mustn't lose footage being paid for.
 */
export async function generate(token: string, m: VideoModel, input: Record<string, unknown>, out: string, stage: (s: MakeStage) => void): Promise<void> {
  // Replicate may start it before it answers: the answer is waited for even when the job is cancelled meanwhile, so it can be cancelled there too.
  let p = await call<Prediction>(token, `/models/${m.slug}/predictions`, { method: "POST", body: JSON.stringify({ input }) }, false);
  const started = Date.now();
  try {
    jobSignal()?.throwIfAborted();
    let misses = 0;
    while (p.status === "starting" || p.status === "processing") {
      stage(p.status === "starting" ? "queued" : "making");
      if (Date.now() - started > GIVE_UP_MS) throw new Error(`${m.title} took over ${GIVE_UP_MS / 60_000} minutes`);
      await Bun.sleep(POLL_MS());
      jobSignal()?.throwIfAborted();
      try {
        p = await call<Prediction>(token, p.urls?.get ?? `/predictions/${p.id}`);
        misses = 0;
      } catch (e) {
        jobSignal()?.throwIfAborted();
        if (++misses >= MISSES) throw e;
      }
    }
  } catch (e) {
    // Not awaited past the job's end: a cancel that fails leaves Replicate to finish it, charged as it would be.
    await fetch(p.urls?.cancel ?? `${api()}/predictions/${p.id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    throw e;
  }
  if (p.status !== "succeeded") throw new Error(`${m.title} ${p.status === "canceled" ? "was cancelled on Replicate" : `couldn't make it: ${p.error ?? "no reason given"}`}`);
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  if (!url) throw new Error(`${m.title} made no file`);
  stage("downloading");
  const job = jobSignal();
  try {
    // Its file links (replicate.delivery) need no token, and shouldn't be sent one: they aren't Replicate's API.
    const got = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(job ? [job] : [])]) });
    if (!got.ok) throw new Error(`the footage couldn't be downloaded (${got.status})`);
    await Bun.write(out, got);
  } catch (e) {
    job?.throwIfAborted();
    if ((e as Error).name === "TimeoutError") throw new Error("the footage took over 5 minutes to download: Make Again, or check your connection");
    throw e;
  }
}
