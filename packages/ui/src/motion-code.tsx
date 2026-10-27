import { useEffect, useRef, useState } from "react";
import { Button, CodeEditor, Modal, PlayBar } from "./controls";
import { useQuery } from "./query";
import type { Host } from "./app";

/** The preview is a sandboxed frame: script runs, but it can't reach Beacon (another origin), so the time is posted to it. */
const SEEKER = `<script>addEventListener("message", (e) => { if (typeof e.data?.t === "number" && window.__seek) window.__seek(e.data.t); }); parent.postMessage("beacon-page", "*");</script>`;
const PREVIEW_WIDTH = 560;
const FPS = 30;

/**
 * A motion graphic's code beside a live preview of it: the inside of its page's <body> edited by hand, the page
 * rebuilt as typing pauses and seeked with a play bar; Save draws it as a new take (motion.code).
 */
export function MotionCode({ host, clip, html, onClose }: { host: Host; clip: string; html: string; onClose: () => void }) {
  const [text, setText] = useState(html);
  const [shown, setShown] = useState(html);
  useEffect(() => {
    const t = setTimeout(() => setShown(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const built = useQuery<{ page: string; width: number; height: number; length: number }>(host, "motion.page", { clip, html: shown });
  const frame = useRef<HTMLIFrameElement>(null);
  // The page says when it's there; a load that doesn't is its script navigating away (the CSP can't forbid that), so it's taken down.
  const loads = useRef(0);
  const pages = useRef(0);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    loads.current = 0;
    pages.current = 0;
    setLeft(false);
  }, [built?.page]);
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data === "beacon-page") pages.current++;
    };
    addEventListener("message", heard);
    return () => removeEventListener("message", heard);
  }, []);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const seek = (t: number) => frame.current?.contentWindow?.postMessage({ t }, "*");
  useEffect(() => seek(time), [time]);
  useEffect(() => {
    if (!playing || !built) return;
    let from = performance.now() - time * 1000;
    let raf = 0;
    const step = (now: number) => {
      let t = (now - from) / 1000;
      if (t >= built.length) {
        from = now;
        t = 0;
      }
      setTime(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, built]);
  const scale = built ? Math.min(PREVIEW_WIDTH / built.width, 420 / built.height) : 1;
  const save = () => {
    host.run("motion.code", { clip, html: text });
    onClose();
  };
  return (
    <Modal title="Edit Code" width={1180} onClose={onClose} onKey={(e) => e.key === " " && (e.preventDefault(), setPlaying((p) => !p))}>
      <div className="flex gap-4" data-motion-code-dialog>
        <CodeEditor className="h-[480px] min-w-0 flex-1 overflow-hidden" value={text} onChange={setText} onSave={save} data-motion-code-text />
        <div className="flex shrink-0 flex-col gap-2" style={{ width: PREVIEW_WIDTH }}>
          <div className="flex h-[420px] items-center justify-center overflow-hidden rounded-lg bg-[repeating-conic-gradient(#3a3a3a_0_25%,#2e2e2e_0_50%)] bg-[length:16px_16px]">
            {left && (
              <div className="max-w-[420px] p-4 text-center text-label text-danger" data-motion-code-left>
                The code tried to open another page, so the preview stopped. Graphics stay offline: remove whatever sets location or opens a link.
              </div>
            )}
            {built && !left && (
              <div style={{ width: built.width * scale, height: built.height * scale }}>
                <iframe
                  ref={frame}
                  title="Preview"
                  sandbox="allow-scripts"
                  srcDoc={built.page.replace(/<\/body>/, `${SEEKER}</body>`)}
                  onLoad={() => {
                    const n = ++loads.current;
                    seek(time);
                    // Its message can arrive just after the load event.
                    setTimeout(() => n === loads.current && pages.current < n && setLeft(true), 500);
                  }}
                  style={{ width: built.width, height: built.height, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, background: "transparent" }}
                  data-motion-code-preview
                />
              </div>
            )}
          </div>
          {built && <PlayBar time={time} end={built.length} fps={FPS} playing={playing} onToggle={() => setPlaying((p) => !p)} onSeek={(t) => (setPlaying(false), setTime(t))} />}
          <span className="text-caption text-text-faint">The inside of the page's &lt;body&gt;: HTML, CSS and script, as the Make wrote it. Saved, it's drawn as a new take, no AI and free; the takes before it stay.</span>
          <div className="mt-auto flex justify-end gap-2">
            <Button look="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button look="primary" disabled={!text.trim() || text === html} onClick={save} data-motion-code-save>
              Save as New Take
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
