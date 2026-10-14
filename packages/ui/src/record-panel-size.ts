import type { PanelState } from "./rpc";

/** The recording panel's height in points for its sources, at its width (RecordPanel's layout). */
export function panelHeight(state: Pick<PanelState, "camera" | "microphone" | "systemAudio">, width: number) {
  const pad = 10;
  return pad * 2 + 30 + (state.camera ? 8 + ((width - pad * 2) * 9) / 16 : 0) + (+state.microphone + +state.systemAudio) * (8 + 24);
}
