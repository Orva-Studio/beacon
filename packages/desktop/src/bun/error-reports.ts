// Error reports to Sentry (EU), Beacon's own small sender rather than an SDK: what leaves the Mac is only what is
// built here, every string through the diagnostics redactor, with no hostname, user, breadcrumbs or IP inference.
// Release builds only (`available`), unless turned off in Settings › General or on the first-run notice.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DSN = "https://71947e55705fc3485558c8c6d7f208f1@o4511071286198272.ingest.de.sentry.io/4512385569849424";
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

/** The Sentry event for an error: redacted, with nothing about the user or this Mac but its macOS version and chip. */
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

/** The envelope Sentry's ingest takes, and where it goes. */
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
  /** Sends a report, unless reports are off, this one was sent already this run, or the run's share is used. */
  report(input: ErrorInput): Promise<string | undefined>;
}

/**
 * `enabled` is asked at each report, so Settings' switch takes effect at once. `send` is fetch, or a test's. A
 * report that can't be sent is dropped and only logged: never reported again, which could loop.
 */
export function createReporter(opts: {
  enabled(): boolean | Promise<boolean>;
  context(): ReportContext;
  send?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  log?: (text: string) => void;
}): Reporter {
  const sent = new Set<string>();
  const send = opts.send ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
  return {
    async report(input) {
      if (!(await opts.enabled())) return;
      const key = `${input.origin}|${input.type}|${input.message}|${input.stack?.split("\n").slice(0, 3).join("|") ?? ""}`;
      if (sent.has(key) || sent.size >= MAX_PER_RUN) return;
      sent.add(key);
      const event = errorEvent(input, opts.context());
      const { url, headers, body } = envelope(event);
      try {
        const r = await send(url, { method: "POST", headers, body });
        if (!r.ok) opts.log?.(`error report not sent: HTTP ${r.status}`);
        return r.ok ? (event.event_id as string) : undefined;
      } catch (e) {
        opts.log?.(`error report not sent: ${e instanceof Error ? e.message : e}`);
      }
    },
  };
}

/** A crash report of macOS's (`.ips`): which of Beacon's processes crashed, and how. Nothing else of it is read. */
export function crashSummary(file: string): { process: string; exception: string } | undefined {
  if (!existsSync(file)) return;
  try {
    const [head, ...rest] = readFileSync(file, "utf8").split("\n");
    const header = JSON.parse(head!) as { app_name?: string; name?: string };
    const body = JSON.parse(rest.join("\n")) as { procName?: string; exception?: { type?: string; signal?: string; subtype?: string } };
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
export async function reportNewCrashes(reporter: Reporter, names: string[], seenFile: string, dir: string, write: (file: string, text: string) => void): Promise<number> {
  const first = !existsSync(seenFile);
  const seen = new Set<string>(first ? [] : (() => { try { return JSON.parse(readFileSync(seenFile, "utf8")) as string[]; } catch { return []; } })());
  const fresh = first ? [] : names.filter((n) => !seen.has(n));
  write(seenFile, JSON.stringify(names));
  let n = 0;
  for (const name of fresh) {
    const s = crashSummary(join(dir, name));
    if (!s) continue;
    await reporter.report({ origin: "native", mechanism: "crash", type: `${s.process} crashed`, message: s.exception });
    n++;
  }
  return n;
}
