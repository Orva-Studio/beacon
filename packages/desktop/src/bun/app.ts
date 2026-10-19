import type { LocalCore } from "@beacon/core";
import type { ProjectBridge, Send } from "@beacon/ui";

export type Rect = { x: number; y: number; width: number; height: number };

/** The project the window shows. */
export interface Current {
  path: string;
  /** The native view core draws the canvas in (`core.view`); `rect`, its place in the window, in points. */
  view?: { id: number; scale: number; rect: Rect };
  /** Its events told to the window. */
  bridge: ProjectBridge;
  /** Already released by core (renamed): switching away must not close it again. */
  closed?: boolean;
}

/** What the main process's parts share: core, the window's messages, the status line and the open project. */
export interface App {
  core: LocalCore;
  message: Send;
  status(text: string): void;
  current(): Current | undefined;
}

/** An error as the status line shows it. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
