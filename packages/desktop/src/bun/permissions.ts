import type { LocalCore } from "@beacon/core";
import type { RecordSources } from "@beacon/ui";

/**
 * macOS asked for the camera and microphone the sources want and it hasn't been asked about yet, as the Record
 * dialog and narration show them ticked (asked at Record, the prompt came over the countdown); whether it was asked.
 */
export async function askFor(core: Pick<LocalCore, "recorderDevices" | "recorderAccess">, sources: RecordSources): Promise<boolean> {
  const { permissions } = await core.recorderDevices();
  const ask = (["camera", "microphone"] as const).filter((kind) => sources[kind] && permissions[kind] === "not asked");
  for (const kind of ask) await core.recorderAccess(kind);
  return ask.length > 0;
}
