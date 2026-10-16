type Reply = { ok: boolean; error?: string };

/**
 * A drag's commands share a coalesce key: while one is on its way, only the newest waiting is sent after it, so a
 * command slower than the pointer (a style on every caption) can't build a queue the drag trails behind.
 */
export function latestPerKey(report: (reply: Promise<Reply>) => Promise<unknown>) {
  const inFlight = new Map<string, { next?: () => Promise<Reply> }>();
  const send = (key: string, run: () => Promise<Reply>): void => {
    const slot = inFlight.get(key);
    if (slot) return void (slot.next = run);
    const entry: { next?: () => Promise<Reply> } = {};
    inFlight.set(key, entry);
    void report(run()).finally(() => {
      inFlight.delete(key);
      if (entry.next) send(key, entry.next);
    });
  };
  return send;
}
