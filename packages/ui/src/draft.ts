import { useEffect, useRef, useState } from "react";

/**
 * Text typed into a box that saves itself: once it has stayed `ms` without changing, on `flush` (the box left), and
 * when `id` (the clip) changes, to the clip it was typed for. The saved text changing elsewhere (undo, an agent) is
 * shown, but not the echo of a save, so letters typed since are kept.
 */
export function useDraft(id: string, saved: string, save: (text: string) => void, ms = 1000) {
  const [draft, setDraft] = useState(saved);
  const sent = useRef(saved);
  const pending = useRef<{ text: string; save: (text: string) => void } | null>(null);
  const flush = () => {
    const p = pending.current;
    pending.current = null;
    if (p && p.text !== sent.current) {
      sent.current = p.text;
      p.save(p.text);
    }
  };
  useEffect(() => () => flush(), [id]);
  useEffect(() => {
    if (saved === sent.current) return;
    sent.current = saved;
    pending.current = null;
    setDraft(saved);
  }, [saved]);
  useEffect(() => {
    if (!pending.current) return;
    const t = setTimeout(flush, ms);
    return () => clearTimeout(t);
  }, [draft]);
  const change = (text: string) => {
    pending.current = { text, save };
    setDraft(text);
  };
  return [draft, change, flush] as const;
}
