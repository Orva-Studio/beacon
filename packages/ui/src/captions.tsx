import { useEffect, useState } from "react";
import type { Host } from "./app";
import { Button, Progress } from "./controls";
import { useQuery } from "./query";
import { replica, useView } from "./store";

/** The mean progress of the transcripts being made, 0-1. */
export function useTranscribing(): number | undefined {
  const values = useView((v) => Object.values(v.transcribing).join());
  return values ? values.split(",").reduce((n, v) => n + Number(v), 0) / values.split(",").length : undefined;
}

/**
 * Captions asked for before every audio heard on the timeline has a transcript: the missing ones are started,
 * and the captions are made once they are there.
 */
export function useCaptionsPending(host: Host) {
  const pending = useView((v) => !!v.captionsPending);
  const [tick, setTick] = useState(0);
  const found = useQuery<{ waiting: string[] }>(host, pending ? "transcript.silences" : "", {}, tick);
  const waiting = found?.waiting.join() ?? "";
  useEffect(() => {
    for (const asset of waiting ? waiting.split(",") : []) host.analyze("transcript", asset);
  }, [waiting]);
  useEffect(() => {
    if (!pending || !found) return;
    if (found.waiting.length) {
      const t = setTimeout(() => setTick((n) => n + 1), 1000);
      return () => clearTimeout(t);
    }
    replica.pendCaptions(false);
    host.run("captions.add", {});
    host.run("panel.show", { properties: true });
  }, [pending, found]);
}

/** Under the AI panel's tiles while captions wait for the transcript. */
export function CaptionsWaiting() {
  const pending = useView((v) => !!v.captionsPending);
  const progress = useTranscribing();
  if (!pending) return null;
  return (
    <div className="mt-3 rounded-md bg-groove px-3 py-2 text-label text-text" data-captions-waiting>
      <div className="mb-2">
        Transcribing the speech on this Mac{progress === undefined ? "" : ` (${Math.round(progress * 100)}%)`}: the captions are made from it when it's done.
      </div>
      <Progress value={progress ?? 0} />
      <div className="mt-2 flex justify-end">
        <Button look="quiet" onClick={() => replica.pendCaptions(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
