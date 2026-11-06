import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { redactor } from "@beacon/core";
import { createReporter, envelope, errorEvent, parseStack, reportNewCrashes, type ErrorInput } from "../src/bun/error-reports";

const ctx = { version: "0.17.3", channel: "stable", macos: "26.1", arch: "arm64", redact: redactor(new Map([["Acme Launch Video", "<project 1>"]])) };
const home = homedir();

test("an error report holds what went wrong and where in Beacon's code, redacted as diagnostics are: no home folder, project or file names, user or hostname", () => {
  const input: ErrorInput = {
    origin: "main",
    mechanism: "onerror",
    type: "TypeError",
    message: `could not read ${home}/Movies/Beacon/Acme Launch Video.beproj/media/acme-secret.mov: no such file`,
    stack: `TypeError: boom\n    at openProject (${home}/beacon/packages/core/src/local.ts:120:7)\n    at <anonymous> (/Applications/Beacon.app/Contents/Resources/app/bun/index.js:88:3)`,
  };
  const event = errorEvent(input, ctx);
  const text = JSON.stringify(envelope(event).body);
  for (const secret of [home, userInfo().username, hostname(), "Acme", "acme-secret"]) expect(text).not.toContain(secret);
  const ex = (event.exception as { values: { type: string; value: string; stacktrace: { frames: { function?: string; filename: string; lineno: number }[] } }[] }).values[0]!;
  expect(ex.type).toBe("TypeError");
  expect(ex.value).toBe("could not read <path>.mov: no such file");
  // Oldest first; files named from inside the app or the repo.
  expect(ex.stacktrace.frames.map((f) => [f.function, f.filename, f.lineno])).toEqual([
    ["<anonymous>", "Resources/app/bun/index.js", 88],
    ["openProject", "packages/core/src/local.ts", 120],
  ]);
  expect(event).toMatchObject({ level: "error", release: "beacon@0.17.3", environment: "stable", platform: "node", tags: { origin: "main" }, sdk: { settings: { infer_ip: "never" } } });
  expect(event).not.toHaveProperty("user");
  expect(event).not.toHaveProperty("server_name");
});

test("a window's stack (WebKit's fn@file:line:col) is read too", () => {
  expect(parseStack("render@views://mainview/index.js:10:4\nviews://mainview/index.js:2:1")).toEqual([
    { filename: "views://mainview/index.js", lineno: 2, colno: 1, in_app: true },
    { function: "render", filename: "views://mainview/index.js", lineno: 10, colno: 4, in_app: true },
  ]);
});

test("the envelope goes to the EU project's ingest with the DSN's key", () => {
  const { url, headers, body } = envelope(errorEvent({ origin: "window", mechanism: "onunhandledrejection", type: "Error", message: "x" }, ctx));
  expect(url).toBe("https://o4511071286198272.ingest.de.sentry.io/api/4512385569849424/envelope/");
  expect(headers["X-Sentry-Auth"]).toContain("sentry_key=71947e55705fc3485558c8c6d7f208f1");
  const [head, item, event] = body.split("\n").map((l) => JSON.parse(l));
  expect(item).toEqual({ type: "event", content_type: "application/json" });
  expect(head.event_id).toBe(event.event_id);
  expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
});

test("reports: none while off (asked at each one), the same error once a run, at most 20 a run, and one that can't be sent is dropped", async () => {
  let on = false;
  const posts: string[] = [];
  let fail = false;
  const reporter = createReporter({
    enabled: () => on,
    context: () => ctx,
    send: async (_url, init) => {
      if (fail) throw new Error("offline");
      posts.push(String(init.body));
      return { ok: true, status: 200 };
    },
  });
  const err = (n: number): ErrorInput => ({ origin: "main", mechanism: "onerror", type: "Error", message: `boom ${n}` });
  expect(await reporter.report(err(0))).toBeUndefined();
  expect(posts).toHaveLength(0);
  on = true;
  expect(await reporter.report(err(0))).toMatch(/^[0-9a-f]{32}$/);
  await reporter.report(err(0));
  expect(posts).toHaveLength(1);
  fail = true;
  expect(await reporter.report(err(1))).toBeUndefined();
  fail = false;
  for (let n = 2; n < 40; n++) await reporter.report(err(n));
  expect(posts).toHaveLength(19);
});

test("crash reports: the first run only notes those there; later, each new one is sent once with only the process and how it crashed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-crashes-"));
  const seen = join(dir, "seen.json");
  const ips = (name: string, proc: string) =>
    writeFileSync(join(dir, name), `${JSON.stringify({ app_name: proc })}\n${JSON.stringify({ procName: proc, exception: { type: "EXC_CRASH", signal: "SIGABRT" }, threads: [{ frames: [{ symbol: `${home}/secret` }] }] })}`);
  ips("bun-2026-11-06-1.ips", "bun");
  const sent: ErrorInput[] = [];
  const reporter = { report: async (e: ErrorInput) => (sent.push(e), "id") };
  const write = (f: string, t: string) => writeFileSync(f, t);
  expect(await reportNewCrashes(reporter, ["bun-2026-11-06-1.ips"], seen, dir, write)).toBe(0);
  ips("beacon-worker-2026-11-06-2.ips", "beacon-worker");
  expect(await reportNewCrashes(reporter, ["beacon-worker-2026-11-06-2.ips", "bun-2026-11-06-1.ips"], seen, dir, write)).toBe(1);
  expect(sent).toEqual([{ origin: "native", mechanism: "crash", type: "beacon-worker crashed", message: "EXC_CRASH (SIGABRT)" }]);
  expect(await reportNewCrashes(reporter, ["beacon-worker-2026-11-06-2.ips", "bun-2026-11-06-1.ips"], seen, dir, write)).toBe(0);
});
