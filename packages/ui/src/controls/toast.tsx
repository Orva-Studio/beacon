import { useEffect, useState, type ReactNode } from "react";
import { MASK, syncNativeView } from "../native-view";
import { Button } from "./buttons";

/**
 * A panel in the window's bottom-right corner reporting something done in the background (an export, a
 * snapshot). Once `done`, it goes after 5 s unless the pointer is on it; `onDismiss` adds a close button.
 */
export function Toast({ title, hint, done, onDismiss, children }: { title: ReactNode; hint?: string; done: boolean; onDismiss?: () => void; children?: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  // Masked out of the native canvas under it.
  useEffect(() => {
    syncNativeView();
    return syncNativeView;
  }, []);
  useEffect(() => {
    if (!done || hovered || !onDismiss) return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [done, hovered, onDismiss]);
  return (
    <div
      className={`${MASK} fixed right-4 bottom-4 z-40 w-80 rounded-xl border border-divider bg-panel p-3 text-body shadow-2xl`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      data-toast
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 truncate text-text-strong" title={hint}>
          {title}
        </span>
        {onDismiss && (
          <Button look="quiet" title="Dismiss" onClick={onDismiss}>
            ×
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}
