type Reply = { ok: boolean; error?: string };

/**
 * A drag's commands share a coalesce key: while one is on its way, only the newest waiting is sent after it, so a
 * command slower than the pointer (a style on every caption) can't build a queue the drag trails behind. Anything
 * else (a command, Undo, opening a project) first sends the newest value each drag is holding back: the main
 * process applies them in the order they arrive, so a drag's last value can't land after an Undo and reapply what
 * was undone.
 */
export function commandQueue(report: (reply: Promise<Reply>) => Promise<unknown>) {
  const inFlight = new Map<string, { next?: () => Promise<Reply> }>();
  const start = (key: string, run: () => Promise<Reply>) => {
    const entry: { next?: () => Promise<Reply> } = {};
    inFlight.set(key, entry);
    void report(run()).finally(() => {
      // Sent early by `flush`, the next one has taken this key over.
      if (inFlight.get(key) !== entry) return;
      inFlight.delete(key);
      if (entry.next) start(key, entry.next);
    });
  };
  const flush = () => {
    for (const [key, entry] of [...inFlight]) {
      if (!entry.next) continue;
      const next = entry.next;
      entry.next = undefined;
      start(key, next);
    }
  };
  return {
    /** A command whose reply is only reported; with `key`, a drag's update. */
    send(run: () => Promise<Reply>, key?: string): void {
      if (key === undefined) {
        flush();
        return void report(run());
      }
      const slot = inFlight.get(key);
      if (slot) slot.next = run;
      else start(key, run);
    },
    /** Anything else that must come after what was asked before it (opening a project); its answer comes back. */
    ordered<T>(run: () => Promise<T>): Promise<T> {
      flush();
      return run();
    },
  };
}
