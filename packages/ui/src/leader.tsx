import { useEffect } from "react";
import { chordId, keySteps, keysLabel, type Keys } from "@beacon/model";
import { syncNativeView } from "./native-view";
import { useView } from "./store";

/**
 * The keys that can follow those pressed of a sequence (the leader key, :), each with what it does, or the group of
 * further keys it opens (Color Label…), until one is pressed; Esc or a click drops it.
 */
export function LeaderKeys() {
  const pending = useView((v) => v.leader);
  const shortcuts = useView((v) => v.shortcuts);
  // Masked out of the native canvas under it.
  useEffect(() => {
    syncNativeView();
    return syncNativeView;
  }, [pending]);
  if (pending === undefined) return null;
  const depth = pending.split(" ").length;
  const next = new Map<string, { keys: Keys; names: string[]; more: boolean }>();
  for (const s of shortcuts) {
    for (const k of s.keys) {
      const id = chordId(k);
      if (!id?.startsWith(`${pending} `)) continue;
      const step = keySteps(k)[depth]!;
      const key = chordId(step)!;
      const entry = next.get(key) ?? { keys: step, names: [], more: false };
      entry.names.push(s.name);
      entry.more ||= keySteps(k).length > depth + 1;
      next.set(key, entry);
    }
  }
  const pressed = keySteps(shortcuts.flatMap((s) => s.keys).find((k) => chordId(k)?.startsWith(`${pending} `))!).slice(0, depth);
  return (
    <div className="fixed bottom-6 left-1/2 z-50 w-80 -translate-x-1/2 rounded-xl border border-divider bg-panel p-3 text-body shadow-2xl" data-leader={pending}>
      <div className="mb-2 flex items-center justify-between text-label text-text-muted">
        <span className="font-mono text-text-strong">{pressed.map(keysLabel).join(" ")} …</span>
        <span>Esc to cancel</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
        {[...next.values()].map((n) => (
          <div key={chordId(n.keys)} className="contents" data-leader-next={keysLabel(n.keys)}>
            <kbd className="min-w-6 rounded-sm bg-chip px-1.5 text-center font-sans text-label text-text-strong">{keysLabel(n.keys)}</kbd>
            {/* In a group the header names it: "Red", not "Color Label: Red". */}
            <span className="truncate text-text">{n.more ? `${n.names[0]!.split(":")[0]}…` : n.names.map((x) => (depth > 1 ? x.replace(/^[^:]*: /, "") : x)).join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
