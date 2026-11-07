// Error reports to Better Stack (in Sentry's envelope format, which it takes), Beacon's own small sender rather than an SDK: what leaves the Mac is only what is
// built here, every string through the diagnostics redactor, with no hostname, user, breadcrumbs or IP inference.
// Release builds only (`available`), unless turned off in Settings › General or on the first-run notice.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DSN = "https://YyLqHJLBqEL5LRYHHkU4f484@s2826331.us-west-2a.betterstackdata.com/2826331";
/** Reports sent in one run at most: a loop of errors mustn't become a flood. */
const MAX_PER_RUN = 20;
const MAX_TEXT = 2000;

export type Origin = "main" | "window" | "native";

export interface ErrorInput {
  origin: Origin;
  /** onerror, onunhandledrejection or crash: how it was caught. */
  mechanism: "onerror" | "onunhandledrejection" | "crash";
  type: string;
  message: string;
  stack?: string;
}

export interface ReportContext {
  version: string;
  channel: string;
  macos: string;
  arch: string;
  redact(text: string): string;
}

type Frame = { function?: string; filename?: string; lineno?: number; colno?: number; in_app: boolean };

/**
 * Frames from a JavaScriptCore stack, oldest first as Sentry wants them: Bun's (`at fn (file:1:2)`) and WebKit's
 * (`fn@file:1:2`). A file is named from inside the app (`Resources/app/…`, `views://…`), never where it is installed.
 */
export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const v8 = /^at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(line);
    const jsc = v8 ? undefined : /^(.*?)@(.*?):(\d+):(\d+)$/.exec(line);
    // WebKit's top-level code: a file and no function.
    const bare = v8 || jsc ? undefined : /^()((?:[a-z]+:\/\/|\/).*?):(\d+):(\d+)$/.exec(line);
    const m = v8 ?? jsc ?? bare;
    if (!m) continue;
    const file = m[2]!.replace(/^.*?\.app\/Contents\//, "").replace(/^.*?\/packages\//, "packages/");
    frames.push({ ...(m[1] ? { function: m[1] } : {}), filename: file, lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes("node_modules") });
  }
  return frames.reverse();
}

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The event (Sentry's format) for an error: redacted, with nothing about the user or this Mac but its macOS version and chip. */
export function errorEvent(input: ErrorInput, ctx: ReportContext): Record<string, unknown> {
  const clean = (s: string) => ctx.redact(s).slice(0, MAX_TEXT);
  const frames = input.stack ? parseStack(input.stack).map((f) => ({ ...f, ...(f.function ? { function: clean(f.function) } : {}), ...(f.filename ? { filename: clean(f.filename) } : {}) })) : [];
  return {
    event_id: hex(16),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: input.mechanism === "crash" ? "fatal" : "error",
    release: `beacon@${ctx.version}`,
    environment: ctx.channel,
    tags: { origin: input.origin },
    contexts: { os: { name: "macOS", version: ctx.macos }, device: { arch: ctx.arch }, app: { app_version: ctx.version } },
    sdk: { name: "beacon.reports", version: "1", settings: { infer_ip: "never" } },
    exception: {
      values: [
        {
          type: clean(input.type) || "Error",
          value: clean(input.message),
          mechanism: { type: input.mechanism, handled: false },
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  };
}

/** The envelope the ingest takes (Sentry's format), and where it goes. */
export function envelope(event: Record<string, unknown>, dsn = DSN): { url: string; headers: Record<string, string>; body: string } {
  const u = new URL(dsn);
  const project = u.pathname.replace(/^\//, "");
  const body = [JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn }), JSON.stringify({ type: "event", content_type: "application/json" }), JSON.stringify(event)].join("\n");
  return {
    url: `${u.protocol}//${u.host}/api/${project}/envelope/`,
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=beacon.reports/1` },
    body,
  };
}

export interface Reporter {
  /**
   * Reports an error, unless reports are off, it was reported already this run, or the run's share is used: written
   * to `pending` at once (the process may be about to die), then sent. Resolves to the event id once sent.
   */
  report(input: ErrorInput, onWritten?: () => void): Promise<string | undefined>;
  /** Sends what an earlier run wrote and couldn't send (it died first, or was offline). */
  sendPending(): Promise<number>;
  /** Deletes what is written and not sent: reports were turned off. */
  dropPending(): void;
  /** Whether reports are on now. */
  enabled(): boolean;
}

/** Pending reports kept at most: older ones are dropped. */
const MAX_PENDING = 20;

/**
 * `enabled` is asked at each report, and synchronously, so Settings' switch takes effect at once and nothing waits
 * before the report is on disk. `send` is fetch, or a test's. A report that can't be sent stays pending for the next
 * run; it is never reported as an error itself, which could loop.
 */
export function createReporter(opts: {
  enabled(): boolean;
  context(): ReportContext;
  /** A folder for reports not sent yet. */
  pending: string;
  send?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  log?: (text: string) => void;
}): Reporter {
  const sent = new Set<string>();
  /** Reports sent or being sent this run, new and pending alike: at most MAX_PER_RUN. */
  let used = 0;
  const send = opts.send ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
  /** Sends one written report; removes it once the ingest has it, or when it refuses it (a 4xx other than 408 and 429: sending again won't help). */
  const deliver = async (file: string): Promise<boolean> => {
    try {
      const { url, headers, body } = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof envelope>;
      const r = await send(url, { method: "POST", headers, body });
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) rmSync(file, { force: true });
      if (!r.ok) opts.log?.(`error report not sent: HTTP ${r.status}`);
      return r.ok;
    } catch (e) {
      opts.log?.(`error report not sent: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };
  const dropPending = () => rmSync(opts.pending, { recursive: true, force: true });
  /** The pending reports newest first, `keep` among them, past MAX_PENDING deleted (one being sent too: the oldest go). */
  const trim = (keep?: string): string[] => {
    const files = readdirSync(opts.pending)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(opts.pending, f))
      .sort((a, b) => Number(b === keep) - Number(a === keep) || statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const old of files.slice(MAX_PENDING)) rmSync(old, { force: true });
    return files.slice(0, MAX_PENDING);
  };
  return {
    async report(input, onWritten) {
      if (!opts.enabled()) return;
      const key = `${input.origin}|${input.type}|${input.message}|${input.stack?.split("\n").slice(0, 3).join("|") ?? ""}`;
      if (sent.has(key) || used >= MAX_PER_RUN) return;
      sent.add(key);
      used++;
      const event = errorEvent(input, opts.context());
      const file = join(opts.pending, `${event.event_id as string}.json`);
      try {
        mkdirSync(opts.pending, { recursive: true });
        writeFileSync(file, JSON.stringify(envelope(event)));
        trim(file);
      } catch (e) {
        opts.log?.(`error report not written: ${e instanceof Error ? e.message : e}`);
        return;
      }
      onWritten?.();
      return (await deliver(file)) ? (event.event_id as string) : undefined;
    },
    async sendPending() {
      if (!existsSync(opts.pending)) return 0;
      // Turned off: what was written while on isn't sent later either.
      if (!opts.enabled()) return (dropPending(), 0);
      let n = 0;
      for (const f of trim()) {
        if (!opts.enabled() || used >= MAX_PER_RUN) break;
        if (!existsSync(f)) continue;
        used++;
        if (await deliver(f)) n++;
      }
      return n;
    },
    dropPending,
    enabled: opts.enabled,
  };
}

/**
 * A crash report of macOS's (`.ips`): which of Beacon's processes crashed, and how. Only one whose executable is inside
 * `bundle` (this Beacon.app): another app's bun, ffmpeg or launcher crashes under the same names. Nothing else is read.
 */
export function crashSummary(file: string, bundle: string): { process: string; exception: string } | undefined {
  if (!existsSync(file)) return;
  try {
    const [head, ...rest] = readFileSync(file, "utf8").split("\n");
    const header = JSON.parse(head!) as { app_name?: string; name?: string };
    const body = JSON.parse(rest.join("\n")) as { procName?: string; procPath?: string; exception?: { type?: string; signal?: string; subtype?: string } };
    if (!body.procPath?.startsWith(`${bundle}/`)) return;
    const ex = body.exception;
    return { process: body.procName ?? header.app_name ?? header.name ?? "unknown", exception: [ex?.type, ex?.signal && `(${ex.signal})`].filter(Boolean).join(" ") || "unknown" };
  } catch {
    return;
  }
}

/**
 * Crash reports new since the last run, each sent once. The first run only notes those already there: they predate
 * the notice. `seen` lives in Beacon's config folder.
 */
export async function reportNewCrashes(reporter: Reporter, names: string[], seenFile: string, dir: string, bundle: string, write: (file: string, text: string) => void): Promise<number> {
  const first = !existsSync(seenFile);
  const seen = new Set<string>(first ? [] : (() => { try { return JSON.parse(readFileSync(seenFile, "utf8")) as string[]; } catch { return []; } })());
  // Off: those there now are seen, never sent once reports are on again.
  const fresh = first || !reporter.enabled() ? [] : names.filter((n) => !seen.has(n));
  // Seen once on disk as a report to send (or not Beacon's), never before: one not written (the run's 20 used) is
  // tried again next launch. Each is written before any is sent, so quitting mid-send loses none.
  const sends: Promise<string | undefined>[] = [];
  const unseen = new Set<string>();
  for (const name of fresh) {
    const s = crashSummary(join(dir, name), bundle);
    if (!s) continue;
    let written = false;
    sends.push(reporter.report({ origin: "native", mechanism: "crash", type: `${s.process} crashed`, message: s.exception }, () => (written = true)));
    if (!written) unseen.add(name);
  }
  write(seenFile, JSON.stringify(names.filter((n) => !unseen.has(n))));
  await Promise.all(sends);
  return sends.length - unseen.size;
}
