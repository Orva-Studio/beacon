import { useEffect } from "react";
import type { Host } from "./app";
import { Button, Progress } from "./controls";
import { useTranscribing, useTranscriptsReady } from "./review";
import { replica, useView } from "./store";

/**
 * Captions asked for before every audio heard on the timeline has a transcript: the missing ones are started,
 * and the captions are made once they are there.
 */
export function useCaptionsPending(host: Host) {
  const pending = useView((v) => !!v.captionsPending);
  const found = useTranscriptsReady<{ waiting: string[] }>(host, "transcript.silences", {}, pending);
  useEffect(() => {
    if (!pending || !found || found.waiting.length) return;
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
