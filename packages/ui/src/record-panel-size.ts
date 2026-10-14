import type { PanelState } from "./rpc";

/** The recording panel's height in points for its sources (RecordPanel's layout). */
export function panelHeight(state: Pick<PanelState, "microphone" | "systemAudio">) {
  const [top, side, gap] = [6, 10, 8];
  const grip = 4 + gap;
  return top + grip + 30 + (+state.microphone + +state.systemAudio) * (gap + 24) + side;
}
