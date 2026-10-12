import { useEffect, useRef, useState } from "react";
import { apply, type Affine, type Clip } from "@beacon/model";
import type { CanvasMark } from "./canvas";
import { rgba } from "./theme";

/** A line of a callout's text as the renderer lays it out (box units, y down): the `callout.textLayout` query. */
interface TextLine {
  start: number;
  end: number;
  top: number;
  bottom: number;
  carets: number[];
}

type Text = { text: string } & Record<string, unknown>;

export interface TextEditHost {
  run(command: string, args?: unknown, label?: string, coalesce?: string): void;
  query(name: string, args?: unknown): Promise<unknown>;
}

/** The offset nearest a point in box units. */
function offsetAt(lines: TextLine[], u: number, v: number): number {
  if (!lines.length) return 0;
  const line = lines.find((l) => v < l.bottom) ?? lines.at(-1)!;
  if (v < lines[0]!.top) return lines[0]!.start;
  let best = 0;
  line.carets.forEach((x, i) => Math.abs(x - u) < Math.abs(line.carets[best]! - u) && (best = i));
  return line.start + best;
}

function wordAt(text: string, i: number): [number, number] {
  let [a, b] = [i, i];
  while (a > 0 && /\w/.test(text[a - 1]!)) a--;
  while (b < text.length && /\w/.test(text[b]!)) b++;
  return [a, b];
}

/**
 * Typing a text callout in place on the canvas after a double-click: an unseen text field takes the
 * keys (so editing, arrows and the clipboard are the system's), clicks and drags in the box place the caret or
 * select, and the caret and selection are drawn as marks over the rendered text, laid out by the renderer itself.
 */
export function useTextEdit(host: TextEditHost, clip: Clip | undefined, toOverlay: Affine | undefined, onDone: () => void) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [lines, setLines] = useState<TextLine[]>([]);
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [blink, setBlink] = useState(true);
  const drag = useRef<number | null>(null);
  const c = clip?.props.callout as { text?: Text; width: number; height: number } | undefined;
  const text = c?.text?.text ?? "";
  const shape = c?.text && JSON.stringify({ ...c.text, width: c.width, height: c.height });

  useEffect(() => {
    if (!clip || !shape) return;
    let live = true;
    void host.query("callout.textLayout", { clip: clip.id }).then((l) => live && setLines(l as TextLine[]), () => live && setLines([]));
    return () => void (live = false);
  }, [clip?.id, shape, host]);

  useEffect(() => {
    if (!clip) return;
    const f = field.current;
    f?.focus({ preventScroll: true });
    f?.select();
    if (f) setSel([0, f.value.length]);
  }, [clip?.id]);

  useEffect(() => {
    setBlink(true);
    if (!clip || sel[0] !== sel[1]) return;
    const t = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(t);
  }, [clip?.id, sel[0], sel[1]]);

  const marks: CanvasMark[] = [];
  if (clip && toOverlay && lines.length) {
    const [a, b] = [Math.min(...sel), Math.max(...sel)];
    // Points per box unit along the text's vertical, for the band's width.
    const k = Math.hypot(toOverlay[2], toOverlay[3]);
    for (const l of lines) {
      const mid = (l.top + l.bottom) / 2;
      const x = (i: number) => l.carets[Math.min(Math.max(i, l.start), l.end) - l.start]!;
      if (a === b) {
        if (blink && a >= l.start && (a < l.end || a === l.end && (l === lines.at(-1) || text[a - 1] !== "\n"))) {
          marks.push({ kind: "line", from: apply(toOverlay, x(a), l.top), to: apply(toOverlay, x(a), l.bottom), width: 1.5, color: rgba("text-caret") });
        }
      } else if (a < l.end + (text[l.end - 1] === "\n" ? 0 : 1) && b > l.start) {
        marks.push({ kind: "line", from: apply(toOverlay, x(a), mid), to: apply(toOverlay, x(b), mid), width: (l.bottom - l.top) * k, color: rgba("text-selection"), butt: true });
      }
    }
  }

  const sync = () => {
    const f = field.current;
    if (f) setSel([f.selectionStart, f.selectionEnd]);
  };

  /** Pointer handling while editing: true when the event was the editor's. `u, v`: the point in box units, if inside the box. */
  const pointer = (type: "down" | "move" | "up", at: [number, number] | undefined, detail = 1, shift = false): boolean => {
    const f = field.current;
    if (!clip || !f) return false;
    if (type === "down") {
      if (!at) return (onDone(), false);
      const i = offsetAt(lines, ...at);
      if (detail === 2) {
        const [wa, wb] = wordAt(text, i);
        f.setSelectionRange(wa, wb);
      } else if (detail >= 3) f.setSelectionRange(0, text.length);
      else if (shift) f.setSelectionRange(Math.min(f.selectionStart, i), Math.max(f.selectionEnd, i));
      else f.setSelectionRange(i, i);
      drag.current = detail === 1 && !shift ? i : null;
      f.focus({ preventScroll: true });
      sync();
      return true;
    }
    if (drag.current === null) return type === "move" ? false : true;
    if (type === "move" && at) {
      const i = offsetAt(lines, ...at);
      const anchor = drag.current;
      f.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? "backward" : "forward");
      sync();
    }
    if (type === "up") drag.current = null;
    return true;
  };

  const element = clip ? (
    <textarea
      ref={field}
      aria-label="Text"
      // Unseen: the renderer draws the text; this only takes the keys.
      className="pointer-events-none absolute top-0 left-0 h-px w-px opacity-0"
      value={text}
      onChange={(e) => {
        host.run("clip.set", { clips: [clip.id], props: { callout: { text: { ...c!.text, text: e.target.value } } } }, "Edit Text", `text-${clip.id}`);
        sync();
      }}
      onSelect={sync}
      onKeyUp={sync}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
      onBlur={() => onDone()}
    />
  ) : null;

  return { marks, element, pointer };
}
