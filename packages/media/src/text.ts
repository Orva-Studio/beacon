import type { TextSpec } from "@beacon/model";
import { loadEngine, takeString } from "./engine";

/** One line of text as the renderer lays it out, in box units, y down from the box's top. */
export interface TextLine {
  /** UTF-16 offsets (as JavaScript counts), `end` exclusive. */
  start: number;
  end: number;
  top: number;
  bottom: number;
  /** The caret's x before each offset from `start` to `end`. */
  carets: number[];
}

const cstr = (s: string) => Buffer.from(`${s}\0`);

/** Lays out a callout's text with Core Text, exactly as the renderer draws it. */
export function textLayout(spec: TextSpec): TextLine[] {
  const e = loadEngine();
  return JSON.parse(takeString(e, e.beacon_text_layout(cstr(JSON.stringify(spec))))) as TextLine[];
}

let families: string[] | undefined;
/** Every installed font family, sorted. */
export function fontFamilies(): string[] {
  const e = loadEngine();
  return (families ??= JSON.parse(takeString(e, e.beacon_font_families())) as string[]);
}
