import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { MASK, syncNativeView } from "../native-view";
import { Icon } from "./icons";

/**
 * The dimmed backdrop of every dialog; the dialog sits in its middle (`SHEET`'s m-auto) and the backdrop
 * scrolls if it is taller than the window. The native canvas draws over the page, so only the panel is
 * masked out of it: masking the whole backdrop hid the canvas (it stays lit, not dimmed).
 */
const BACKDROP = "fixed inset-0 z-50 flex overflow-y-auto bg-backdrop p-6";
/** A dialog's panel, cut out of the native canvas. */
const SHEET = `${MASK} m-auto max-w-full rounded-xl border border-divider bg-panel p-6 pt-4 text-body text-text shadow-2xl outline-none`;

let dialogs = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/**
 * Marks a dialog open while the calling component is mounted (the native canvas then dims itself), and
 * keeps its panel cut out of the native canvas as it resizes (a Settings tab) or its backdrop scrolls.
 */
function useDialogOpen(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    dialogs++;
    changed();
    const el = panel.current;
    const ro = el ? new ResizeObserver(syncNativeView) : undefined;
    if (el) ro!.observe(el);
    el?.parentElement?.addEventListener("scroll", syncNativeView);
    return () => {
      dialogs--;
      changed();
      ro?.disconnect();
      el?.parentElement?.removeEventListener("scroll", syncNativeView);
    };
  }, [panel]);
}

/** Whether any dialog is open: the backdrop can't dim the native canvas, which draws over the page, so it draws its own dimming. */
export const useDialogsOpen = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => dialogs > 0);

/** A dialog's title, anything beside it (tabs), and its close button. */
export function ModalHeader({ title, onClose, children }: { title: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <div className="flex-1 truncate text-title font-semibold text-text-strong">{title}</div>
      {children}
      <button title="Close (Esc)" aria-label="Close" className="-my-1.5 -mr-1.5 flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-control hover:text-text-strong" onClick={onClose}>
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

/**
 * A dialog over the window: a dimmed backdrop (masked out of the native canvas, which would draw over it),
 * closed by Escape or a click outside; Enter runs `onEnter`. Keys inside don't reach the editor's shortcuts.
 */
export function Modal({
  title,
  header,
  width = 420,
  onClose,
  onEnter,
  onKey,
  children,
}: {
  title?: ReactNode;
  /** Beside the title (Settings' tabs). */
  header?: ReactNode;
  width?: number;
  onClose: () => void;
  onEnter?: () => void;
  /** Other keys pressed in the dialog (not in a field). */
  onKey?: (e: React.KeyboardEvent) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogOpen(panel);
  useEffect(() => {
    syncNativeView();
    // Keys go to the dialog (Escape, Space…), unless a field in it took focus.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    return syncNativeView;
  }, []);
  return (
    <div className={BACKDROP} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={SHEET}
        style={{ width }}
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && onEnter && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLTextAreaElement)) onEnter();
          else if (onKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) onKey(e);
        }}
      >
        {title && (
          <ModalHeader title={title} onClose={onClose}>
            {header}
          </ModalHeader>
        )}
        {children}
      </div>
    </div>
  );
}
