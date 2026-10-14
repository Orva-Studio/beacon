import { createRoot, type Root } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import { recordPreviewEvent } from "./record";
import { RecordPanel } from "./record-panel";
import type { PanelRPC, PanelState } from "./rpc";

const rpc = Electroview.defineRPC<PanelRPC>({
  handlers: {
    requests: {},
    messages: {
      recordPreview: (e) => recordPreviewEvent(e),
      recordStarted: ({ started }) => state && render({ ...state, started }),
    },
  },
});
const view = new Electrobun.Electroview({ rpc });

let root: Root | undefined;
let state: PanelState | null = null;
const render = (s: PanelState) => {
  state = s;
  root ??= createRoot(document.getElementById("root")!);
  root.render(<RecordPanel state={s} onStop={() => view.rpc!.send.stopRecording({})} pull={(after) => view.rpc!.request.recordFrames({ after })} />);
};
const init = await view.rpc!.request.panelInit({});
if (init) render(init);
