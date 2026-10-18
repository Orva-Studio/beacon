import { createRoot } from "react-dom/client";
import Electrobun, { Electroview } from "electrobun/view";
import { App } from "./app";
import { createHost } from "./host";
import type { AppRPC } from "./rpc";
import { replica } from "./store";
import { messageHandlers } from "./messages";

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {},
    messages: {
      ...messageHandlers,
      patches: ({ patches, rev }) => {
        if (!replica.patches(patches, rev)) void resync();
      },
      key: ({ code, meta, shift = false, alt = false, ctrl = false }) => {
        const el = document.activeElement;
        const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        // The menu took these from a text field (Select All, Undo, Redo): a replayed key can't edit, so do it here.
        if (field && meta && !alt && !ctrl && (code === "KeyA" || code === "KeyZ")) {
          if (code === "KeyA") el.select();
          else document.execCommand(shift ? "redo" : "undo");
          return;
        }
        // In a text field ⌘⌫ keeps its meaning: delete back to the start of the line.
        if (code === "Backspace" && meta && field) {
          const end = el.selectionEnd ?? 0;
          const start = el.selectionStart === end ? 0 : (el.selectionStart ?? 0);
          el.setRangeText("", start, end, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        (el ?? window).dispatchEvent(new KeyboardEvent("keydown", { code, key: code, metaKey: meta, shiftKey: shift, altKey: alt, ctrlKey: ctrl, bubbles: true, cancelable: true }));
      },
    },
  },
});
const view = new Electrobun.Electroview({ rpc });
const request = view.rpc!.request;

/** The window's document missed or couldn't apply a change: take the main process's copy. */
let resyncing = false;
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const o = await request.resync({});
    if (o) replica.resynced(o);
  } finally {
    resyncing = false;
  }
}

const host = createHost((name, params) => (request[name] as (p: typeof params) => Promise<never>)(params), {
  canvasMarks: (marks) => view.rpc!.send.canvasMarks({ marks }),
});

// After React has drawn a change, tell the main process what is on screen.
let timer: ReturnType<typeof setTimeout> | undefined;
replica.subscribe(() => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const { project, session, opened } = replica.get();
    if (!project || !session) return;
    view.rpc!.send.shown({
      project: opened?.name,
      tracks: project.tracks.length,
      clips: project.tracks.reduce((n, t) => n + t.clips.length, 0),
      markers: project.markers.length,
      playhead: session.playhead,
      selection: session.selection,
      timeline: session.timeline,
      tool: session.panels.tool,
      properties: session.panels.properties ? session.inspector : null,
    });
  }, 30);
});

const init = await request.init({});
if (init.keyLog) {
  const describe = (t: EventTarget | null) => (t instanceof Element ? `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ""}${t.getAttribute("class") ? `.${t.getAttribute("class")!.split(" ")[0]}` : ""}` : String(t));
  const log = (stage: string, e: KeyboardEvent) =>
    view.rpc!.send.keyLog({
      line: `${stage} ${e.type} code=${e.code} key=${JSON.stringify(e.key)} mods=${[e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"].filter(Boolean).join("+")} target=${describe(e.target)} active=${describe(document.activeElement)} prevented=${e.defaultPrevented} trusted=${e.isTrusted}`,
    });
  for (const type of ["keydown", "keyup"] as const) {
    window.addEventListener(type, (e) => log("capture", e), true);
    // Next task: the page's handlers have run, so `prevented` says whether one took it.
    window.addEventListener(type, (e) => setTimeout(() => log("after", e)), false);
  }
}
replica.init(init);
createRoot(document.getElementById("root")!).render(<App host={host} />);
