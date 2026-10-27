/**
 * A signal that fires when `ms` pass without `alive()`, on the wall clock: the Mac's sleep counts (timers alone measure
 * time awake), so a connection the sleep left dead is given up soon after it wakes.
 */
export function watchdog(ms: number) {
  const c = new AbortController();
  let last = Date.now();
  const timer = setInterval(() => Date.now() - last > ms && c.abort(new DOMException("no answer", "TimeoutError")), 1000);
  return { signal: c.signal, alive: () => void (last = Date.now()), stop: () => clearInterval(timer) };
}

/** `p`, or `signal`'s reason as soon as it fires: a request can hang without heeding its signal (after a sleep, and not only then). */
export function until<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Writes a response's body to `path`, each chunk keeping `dog` alive, so a download that stops arriving is given up. */
export async function saveBody(got: Response, path: string, signal: AbortSignal, dog: { alive: () => void }) {
  if (!got.body) throw new Error("the download had no body");
  const reader = got.body.getReader();
  const sink = Bun.file(path).writer();
  try {
    for (;;) {
      const { done, value } = await until(reader.read(), signal);
      if (done) break;
      dog.alive();
      sink.write(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    await sink.end();
  }
}
