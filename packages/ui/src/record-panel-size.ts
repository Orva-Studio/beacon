import type { PanelState } from "./rpc";

/** The recording panel's height in points for its sources (RecordPanel's layout). */
export function panelHeight(state: Pick<PanelState, "microphone" | "systemAudio">) {
  const [border, top, side, gap] = [1, 6, 10, 8];
  const grip = 4 + gap;
  const chips = gap + 20;
  return border + top + grip + 32 + chips + (+state.microphone + +state.systemAudio) * (gap + 24) + side + border;
}
