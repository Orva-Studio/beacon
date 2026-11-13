import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten-core";

/**
 * An agent's script, run in QuickJS (its own JavaScript engine, in WebAssembly): nothing of Beacon's process is
 * reachable from it, no files, network, `process` or `Bun`; only `beacon.run`, `beacon.query` and `beacon.log`, whose
 * arguments and results cross as JSON. Out of time or memory, it is stopped.
 */

let loading: Promise<QuickJSWASMModule> | undefined;
let engine: QuickJSWASMModule | undefined;

/** Loads the engine (once); `runScript` needs it loaded. */
export async function loadScriptEngine(): Promise<void> {
  engine ??= await (loading ??= newQuickJSWASMModuleFromVariant(variant));
}

export interface ScriptHost {
  run(command: string, args: unknown): unknown;
  query(name: string, args: unknown): unknown;
}

export interface ScriptOutcome {
  value: unknown;
  logs: string[];
}

export const SCRIPT_SECONDS = 10;
const MEMORY = 64 * 1024 * 1024;
const MAX_LOGS = 50;

// The host functions are captured in a closure and deleted from the global: the script sees only the wrappers,
// made inside QuickJS, and an error thrown across is rebuilt there from its message.
const PRELUDE = `
const beacon = (() => {
  const call = globalThis.__call, log = globalThis.__log;
  delete globalThis.__call; delete globalThis.__log;
  const go = (kind, name, args) => {
    if (typeof name !== "string") throw new TypeError(kind + " takes a command or query name first");
    const r = JSON.parse(call(JSON.stringify([kind, name, args === undefined ? {} : args])));
    if (r.error !== undefined) throw new Error(r.error);
    return r.value;
  };
  return Object.freeze({
    run: (command, args) => go("run", command, args),
    query: (name, args) => go("query", name, args),
    log: (...parts) => void log(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")),
  });
})();
`;

/** Runs to the end before it returns: nothing else happens in Beacon meanwhile. */
export function runScript(code: string, host: ScriptHost, seconds = SCRIPT_SECONDS): ScriptOutcome {
  if (!engine) throw new Error("the script engine isn't loaded (loadScriptEngine)");
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(MEMORY);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + seconds * 1000));
  const vm = runtime.newContext();
  const logs: string[] = [];
  try {
    const call = vm.newFunction("__call", (json) => {
      let reply: { value?: unknown; error?: string };
      try {
        const [kind, name, args] = JSON.parse(vm.getString(json)) as ["run" | "query", string, unknown];
        const value = kind === "run" ? host.run(name, args) : host.query(name, args);
        reply = { value: value === undefined ? null : value };
      } catch (e) {
        reply = { error: e instanceof Error ? e.message : String(e) };
      }
      return vm.newString(JSON.stringify(reply));
    });
    const log = vm.newFunction("__log", (line) => {
      if (logs.length < MAX_LOGS) logs.push(vm.getString(line).slice(0, 500));
      else if (logs.length === MAX_LOGS) logs.push(`... more lines left out`);
    });
    vm.setProp(vm.global, "__call", call);
    vm.setProp(vm.global, "__log", log);
    call.dispose();
    log.dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE, "prelude.js")).dispose();
    // A function body, so `return` gives the result; strict, so a typo'd name throws instead of making a global.
    const result = vm.evalCode(`"use strict";\n(() => {\n${code}\n})()`, "script.js");
    if (result.error) {
      const e = vm.dump(result.error) as { message?: string; stack?: string } | string;
      result.error.dispose();
      const message = typeof e === "string" ? e : (e?.message ?? JSON.stringify(e));
      throw new Error(/interrupted/i.test(message) ? `the script ran past ${seconds} s and was stopped` : `script: ${message}${typeof e === "object" && e?.stack ? `\n${e.stack.split("\n").filter((l) => l.includes("script.js")).slice(0, 3).join("\n")}` : ""}`);
    }
    const dumped = vm.dump(result.value);
    result.value.dispose();
    // Checked here, inside the batch: a reply that can't be sent must not leave its edits kept.
    let value: unknown;
    try {
      value = dumped === undefined ? null : JSON.parse(JSON.stringify(dumped));
    } catch (e) {
      throw new Error(`the script's return value can't be sent as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { value, logs };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
