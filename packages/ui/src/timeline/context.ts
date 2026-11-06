import type { RefObject } from "react";
import type { Track } from "@beacon/model";
import type { TimelineDrawing } from "../timeline-draw";

export type Run = (command: string, args?: unknown, label?: string, coalesce?: string) => void;

/** The refs the timeline's handlers share with its drawing and effects, and this render's layout. */
export interface TimelineContext {
  canvas: TimelineDrawing["canvas"];
  latest: TimelineDrawing["latest"];
  size: TimelineDrawing["size"];
  dragState: TimelineDrawing["dragState"];
  settling: TimelineDrawing["settling"];
  snapLine: TimelineDrawing["snapLine"];
  pickedDiamond: TimelineDrawing["pickedDiamond"];
  anchor: RefObject<string | null>;
  pending: RefObject<number>;
  edge: RefObject<{ x: number; raf: number }>;
  drawRef: RefObject<() => void>;
  HEADER: number;
  TRACK: number;
  TOP: number;
  /** In display order: top first. */
  tracks: Track[];
  clipTypes: Record<string, string[]>;
  run: Run;
}

/** A context with this render's draw, for handlers that draw what they change. */
export interface DrawingContext extends TimelineContext {
  draw: () => void;
}
