import type { AppRPC } from "./rpc";

export type WindowError = AppRPC["bun"]["messages"]["windowError"];

/** Errors nothing in the page caught, to the main process: it redacts them and sends an error report if they're on. */
export function forwardErrors(send: (e: WindowError) => void, crashTest = false) {
  const forward = (mechanism: WindowError["mechanism"], reason: unknown) => {
    const e = reason instanceof Error ? reason : undefined;
    send({ mechanism, type: e?.name ?? "Error", message: e ? e.message : String(reason), ...(e?.stack ? { stack: e.stack } : {}) });
  };
  window.addEventListener("error", (ev) => forward("onerror", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => forward("onunhandledrejection", ev.reason));
  if (crashTest)
    setTimeout(() => {
      throw new Error("Beacon crash test (window)");
    }, 4000);
}
