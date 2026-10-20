import { useEffect, useRef, useState, type ReactNode } from "react";
import { syncNativeView } from "../native-view";
import { RoundedMask } from "./rounded-mask";
import { Button } from "./buttons";

/**
 * A panel reporting something done in the background (an export, a snapshot, an import), in `Toasts`. Once `done`, it goes after 5 s unless the pointer is on it; `onDismiss` adds a close button.
 */
export function Toast({ title, hint, done, onDismiss, children }: { title: ReactNode; hint?: string; done: boolean; onDismiss?: () => void; children?: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  // Masked out of the native canvas under it.
  useEffect(() => {
    syncNativeView();
    return syncNativeView;
  }, []);
  // Callers pass a new onDismiss each render; keyed on it, every redraw would restart the 5 s.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const dismissable = !!onDismiss;
  useEffect(() => {
    if (!done || hovered || !dismissable) return;
    const t = setTimeout(() => dismiss.current?.(), 5000);
    return () => clearTimeout(t);
  }, [done, hovered, dismissable]);
  return (
    <div
      className="relative w-80 rounded-xl border border-divider bg-panel p-3 text-body shadow-2xl"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      data-toast
    >
      <RoundedMask radius={14} />
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

/** The window's bottom-right corner, where toasts stack. */
export function Toasts({ children }: { children: ReactNode }) {
  return <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2">{children}</div>;
}
