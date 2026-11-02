import { jobSignal, saveBody, until, watchdog } from "@beacon/media";

/** Epidemic Sound's MCP server (Streamable HTTP, JSON-RPC); a test points it at a stand-in. */
const url = () => process.env.BEACON_EPIDEMIC_URL ?? "https://www.epidemicsound.com/a/mcp-service/mcp";
const TIMEOUT_MS = () => Number(process.env.BEACON_EPIDEMIC_TIMEOUT_MS ?? 30_000);

export const KEY = "epidemic-sound-api-key";

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Milliseconds. */
  ms: number;
  bpm?: number;
  /** A low-quality MP3 to listen to before choosing; free to play. */
  preview: string;
  cover?: string;
  moods: string[];
  genres: string[];
  /** It has singing: `download`'s `vocals: false` takes its instruments alone. */
  vocals: boolean;
}

export interface Effect {
  id: string;
  title: string;
  ms: number;
  preview: string;
}

/** A page of results, `next` for the one after. */
export interface Page<T> {
  items: T[];
  total?: number;
  next?: string;
}

/** One MCP session per key, opened on first use and opened again when the server forgets it. */
const sessions = new Map<string, Promise<string>>();
let ids = 0;

async function post(key: string, body: object, session?: string): Promise<Response> {
  const job = jobSignal();
  const dog = watchdog(TIMEOUT_MS());
  const signal = AbortSignal.any([dog.signal, ...(job ? [job] : [])]);
  try {
    const r = await until(
      fetch(url(), {
        method: "POST",
        keepalive: false,
        signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
        body: JSON.stringify(body),
      }),
      signal,
    );
    if (r.status === 401 || r.status === 403) throw new Error("Epidemic Sound refused the key: check it in Settings › AI (a key from your Epidemic Sound account's API keys page, under a year old)");
    // Read under the same watch: its answer arrives as server-sent events.
    const text = await until(r.text(), signal);
    return new Response(text, { status: r.status, headers: r.headers });
  } catch (e) {
    job?.throwIfAborted();
    if ((e as Error).name === "TimeoutError") throw new Error(`Epidemic Sound didn't answer within ${Math.round(TIMEOUT_MS() / 1000)} s: try again`);
    throw e;
  } finally {
    dog.stop();
  }
}

/** The JSON-RPC message in an answer, whether sent as JSON or as server-sent events. */
function message(text: string): { result?: any; error?: { message?: string } } {
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(events.length ? events.at(-1)! : text);
}

function open(key: string): Promise<string> {
  let s = sessions.get(key);
  if (!s) {
    s = (async () => {
      const r = await post(key, { jsonrpc: "2.0", id: ++ids, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Beacon", version: "1" } } });
      if (!r.ok) throw new Error(`Epidemic Sound: couldn't connect (${r.status})`);
      const id = r.headers.get("mcp-session-id") ?? "";
      await post(key, { jsonrpc: "2.0", method: "notifications/initialized" }, id);
      return id;
    })();
    sessions.set(key, s);
    s.catch(() => sessions.delete(key));
  }
  return s;
}

/** A GraphQL error Epidemic gives as RETRY_LATER: how long it asks to wait. */
const retryAfter = (errors: any[]) => errors.find((e) => e?.extensions?.code === "RETRY_LATER")?.extensions?.retryAfterSeconds as number | undefined;

/** Calls one of the server's tools; its answer is GraphQL's `data`. */
export async function call<T>(key: string, tool: string, args: object): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const session = await open(key);
    const r = await post(key, { jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { name: tool, arguments: args } }, session);
    // A session the server no longer knows (it restarted, or it timed out): a new one, once.
    if ((r.status === 404 || r.status === 400) && attempt === 1) {
      sessions.delete(key);
      continue;
    }
    if (!r.ok) throw new Error(`Epidemic Sound: ${tool} failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
    const m = message(await r.text());
    if (m.error) throw new Error(`Epidemic Sound: ${m.error.message ?? `${tool} failed`}`);
    const text = (m.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    let body: { data?: T; errors?: any[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Epidemic Sound: ${text.slice(0, 300) || `${tool} gave no answer`}`);
    }
    if (body.errors?.length) {
      const wait = retryAfter(body.errors);
      if (wait !== undefined && attempt < 4) {
        await Bun.sleep(Math.min(wait, 10) * 1000);
        continue;
      }
      const why = body.errors.map((e) => e?.message).filter(Boolean).join("; ");
      if (/subscription|not allowed|forbidden|permission/i.test(why)) throw new Error(`Epidemic Sound: ${why} (downloading needs a paid Epidemic Sound subscription)`);
      throw new Error(`Epidemic Sound: ${why || `${tool} failed`}`);
    }
    if (m.result?.isError) throw new Error(`Epidemic Sound: ${text.slice(0, 300)}`);
    return body.data as T;
  }
}

const tagsOf = (tags: { displayName?: string; dimension?: { name?: string } }[] | undefined, dimension: string) => (tags ?? []).filter((t) => t.dimension?.name === dimension).map((t) => t.displayName ?? "");

export interface MusicSearch {
  term?: string;
  moods?: string[];
  genres?: string[];
  /** Seconds, at least and at most. */
  length?: { min?: number; max?: number };
  bpm?: { min?: number; max?: number };
  first?: number;
  after?: string;
}

export async function searchMusic(key: string, s: MusicSearch): Promise<Page<Track>> {
  const ms = (v?: number) => (v === undefined ? null : Math.round(v * 1000));
  const filter = {
    ...(s.length ? { duration: { min: ms(s.length.min), max: ms(s.length.max) } } : {}),
    ...(s.bpm ? { bpm: { min: s.bpm.min ?? null, max: s.bpm.max ?? null } } : {}),
    ...(s.moods?.length ? { moodSlugs: { matchType: "ANY", values: s.moods } } : {}),
    ...(s.genres?.length ? { taxonomySlugs: { matchType: "ANY", values: s.genres } } : {}),
  };
  const data = await call<{ recordings: { nodes: { recording: any }[]; meta?: { total?: number }; pageInfo?: { hasNextPage: boolean; endCursor?: string } } }>(key, "SearchRecordings", {
    ...(s.term ? { query: { term: s.term } } : {}),
    ...(Object.keys(filter).length ? { filter } : {}),
    first: s.first ?? 20,
    ...(s.after ? { after: s.after } : {}),
  });
  const page = data.recordings;
  return {
    items: page.nodes.map(({ recording: r }) => ({
      id: r.id,
      title: r.title,
      artist: (r.credits ?? []).find((c: any) => c.role === "MAIN_ARTIST")?.artist?.name ?? "",
      ms: r.audioFile?.durationInMilliseconds ?? 0,
      ...(r.bpm ? { bpm: r.bpm } : {}),
      preview: r.audioFile?.lqmp3Url ?? "",
      ...(r.coverArtUrl ? { cover: r.coverArtUrl.replace(/3000x3000/, "300x300") } : {}),
      moods: tagsOf(r.tags, "mood"),
      genres: tagsOf(r.tags, "genre"),
      vocals: (r.stems ?? []).some((x: { type?: string }) => x.type === "VOCALS"),
    })),
    ...(page.meta?.total !== undefined ? { total: page.meta.total } : {}),
    ...(page.pageInfo?.hasNextPage && page.pageInfo.endCursor ? { next: page.pageInfo.endCursor } : {}),
  };
}

export async function searchEffects(key: string, s: { term?: string; first?: number; after?: string }): Promise<Page<Effect>> {
  const data = await call<Record<string, { nodes: { soundEffect: any }[]; meta?: { total?: number }; pageInfo?: { hasNextPage: boolean; endCursor?: string } }>>(key, "SearchSoundEffects", {
    ...(s.term ? { query: { term: s.term } } : {}),
    first: s.first ?? 20,
    ...(s.after ? { after: s.after } : {}),
  });
  const page = Object.values(data)[0]!;
  return {
    items: page.nodes.map(({ soundEffect: e }) => ({ id: e.id, title: e.title, ms: e.audioFile?.durationInMilliseconds ?? 0, preview: e.audioFile?.lqmp3Url ?? "" })),
    ...(page.meta?.total !== undefined ? { total: page.meta.total } : {}),
    ...(page.pageInfo?.hasNextPage && page.pageInfo.endCursor ? { next: page.pageInfo.endCursor } : {}),
  };
}

const assetUrl = (data: Record<string, { assetUrl?: string } | undefined>) => {
  const u = Object.values(data)[0]?.assetUrl;
  if (!u) throw new Error("Epidemic Sound gave no file to download");
  return u;
};

/** A track (MP3: its full mix, or with `vocals: false` its instruments alone) or a sound effect (WAV), downloaded to `path`. */
export async function download(key: string, kind: "music" | "sfx", id: string, path: string, vocals = true): Promise<void> {
  const data = kind === "music" ? await call<Record<string, { assetUrl: string }>>(key, "DownloadRecording", { id, options: { fileType: "MP3", stemType: vocals ? "FULL" : "INSTRUMENTS" } }) : await call<Record<string, { assetUrl: string }>>(key, "DownloadSoundEffect", { id, options: { fileType: "WAV" } });
  await fetchTo(assetUrl(data), path);
}

/** A version of a track `seconds` long (Epidemic's track adaptation: it re-cuts the music, up to 5 min), downloaded to `path`. */
export async function downloadEdit(key: string, id: string, seconds: number, path: string, progress: (f: number) => void): Promise<void> {
  const job = await call<Record<string, { id: string; status: string }>>(key, "EditRecording", {
    id,
    input: { targetDurationMs: Math.round(seconds * 1000), downloadAudioFormat: "MP3", forceDuration: true, skipStems: true, maxResults: 1 },
  });
  const jobId = Object.values(job)[0]!.id;
  const poll = Number(process.env.BEACON_EPIDEMIC_POLL_MS ?? 2000);
  for (let n = 1; ; n++) {
    await Bun.sleep(poll);
    jobSignal()?.throwIfAborted();
    const s = Object.values(await call<Record<string, { status: string; edits?: { id: string }[]; edit?: { id: string } }>>(key, "PollEditRecordingJob", { id: jobId }))[0]!;
    if (s.status === "FAILED") throw new Error("Epidemic Sound couldn't fit the track to that length: try Cut to fit");
    if (s.status === "COMPLETED") {
      const editId = s.edits?.[0]?.id ?? s.edit?.id;
      if (!editId) throw new Error("Epidemic Sound made no edit of the track");
      await fetchTo(assetUrl(await call(key, "DownloadRecordingEdit", { input: { jobId, editId } })), path);
      return;
    }
    // No percentage is given: creeps on.
    progress(1 - 1 / (1 + n / 6));
  }
}

async function fetchTo(link: string, path: string) {
  const job = jobSignal();
  const dog = watchdog(TIMEOUT_MS());
  const signal = AbortSignal.any([dog.signal, ...(job ? [job] : [])]);
  try {
    const r = await until(fetch(link, { keepalive: false, signal }), signal);
    if (!r.ok) throw new Error(`Epidemic Sound's file couldn't be downloaded (${r.status})`);
    dog.alive();
    await saveBody(r, path, signal, dog);
  } catch (e) {
    job?.throwIfAborted();
    if ((e as Error).name === "TimeoutError") throw new Error("Epidemic Sound's download stalled: try again");
    throw e;
  } finally {
    dog.stop();
  }
}
