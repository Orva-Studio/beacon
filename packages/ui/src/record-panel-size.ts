import type { RecorderLive } from "@beacon/media";
import type { PanelState } from "./rpc";
import { clock } from "./time";

/** The recording panel's height in points for its sources (RecordPanel's layout). */
export function panelHeight(state: Pick<PanelState, "microphone" | "systemAudio">) {
  const [border, top, side, gap] = [1, 6, 10, 8];
  const grip = 4 + gap;
  const chips = gap + 20;
  return border + top + grip + 32 + chips + (+state.microphone + +state.systemAudio) * (gap + 24) + side + border;
}

const NAMES: Record<string, string> = { screen: "Screen", camera: "Camera", microphone: "Mic", systemAudio: "System" };

/** The menu-bar item while a take records: its time, and any source that stopped saving (the panel may be hidden). */
export function recordingTitle(seconds: number, live: RecorderLive = {}) {
  const stopped = Object.entries(live).filter(([, on]) => on === false).map(([k]) => NAMES[k] ?? k);
  return `● ${clock(seconds, { floor: true })}${stopped.length ? ` · ${stopped.join(", ")} not saving` : ""}`;
}
