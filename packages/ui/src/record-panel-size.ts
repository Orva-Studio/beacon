import type { PanelState } from "./rpc";

/** The recording panel's height in points for its sources, at its width (RecordPanel's layout). */
export function panelHeight(state: Pick<PanelState, "camera" | "microphone" | "systemAudio">, width: number) {
  const [top, side, gap] = [6, 10, 8];
  const grip = 4 + gap;
  return top + grip + 30 + (state.camera ? gap + ((width - side * 2) * 9) / 16 : 0) + (+state.microphone + +state.systemAudio) * (gap + 24) + side;
}
