import { useEffect, useState } from "react";
import type { RecordFrames, RecordPreview } from "./rpc";

/** The recorder's preview, shared by the Record dialog, the sync check and the recording panel. */
export const previewListeners = new Set<(e: RecordPreview) => void>();

/** A frame or the audio levels, for the open Record dialog or the recording panel. */
export function recordPreviewEvent(e: RecordPreview) {
  for (const l of previewListeners) l(e);
}

/**
 * The newest camera and screen frames while `on`, pulled one request at a time: each waits for the next frame,
 * so a busy page skips frames rather than falling behind.
 */
export function useRecordFrames(pull: (after: number) => Promise<RecordFrames>, on: boolean) {
  const [frames, setFrames] = useState<{ camera?: string; screen?: string }>({});
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void (async () => {
      let after = 0;
      while (alive) {
        try {
          const f = await pull(after);
          if (!alive) break;
          after = f.seq;
          if (f.camera || f.screen) setFrames((p) => ({ ...p, ...(f.camera ? { camera: f.camera } : {}), ...(f.screen ? { screen: f.screen } : {}) }));
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => {
      alive = false;
      setFrames({});
    };
  }, [on]);
  return frames;
}
