import { useEffect, type RefObject } from "react";
import type { TimelineContext } from "./context";

const GHOSTS = ["press", "move", "trim", "space", "track", "section", "sectionNew"];

// Escape drops a drag that has only drawn a ghost so far: nothing is sent.
export function useTimelineKeys(dragState: TimelineContext["dragState"], snapLine: TimelineContext["snapLine"], drawRef: RefObject<() => void>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dragState.current;
      if (e.key !== "Escape" || !d || !GHOSTS.includes(d.kind)) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = null;
      snapLine.current = undefined;
      drawRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
