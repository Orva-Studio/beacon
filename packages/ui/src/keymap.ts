import { chordId, eventChordId, keysLabel, sameArgs, type ShortcutInfo } from "@beacon/model";
import type { Binding } from "./rpc";
import { useMemo } from "react";
import { replica, useView } from "./store";

/** Each action's keys as the window matches them. */
const bindingsOf = (shortcuts: ShortcutInfo[]): Binding[] =>
  shortcuts.flatMap((s) => s.keys.map((keys) => ({ keys, command: s.command, ...(s.args ? { args: s.args } : {}), action: s.id })));

/** " (⌘T)" for a button's tooltip: the first key of the action that runs `command` with `args`, as the user has them. */
export function useShortcutTip() {
  const shortcuts = useView((v) => v.shortcuts);
  return (command: string, args?: object) => {
    const keys = shortcuts.find((s) => s.command === command && sameArgs(s.args, args as Record<string, unknown> | undefined))?.keys[0];
    return keys ? ` (${keysLabel(keys)})` : "";
  };
}

/** The user's keys, compiled for `match`. */
export function useKeymap(): Map<string, Binding> {
  const shortcuts = useView((v) => v.shortcuts);
  return useMemo(() => compileKeymap(bindingsOf(shortcuts)), [shortcuts]);
}

/** Bindings that resolve to a command, by chord. */
function compileKeymap(bindings: Binding[]): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const b of bindings) {
    const id = b.command && chordId(b.keys);
    if (id) map.set(id, b);
  }
  return map;
}

export function match(map: Map<string, Binding>, e: KeyboardEvent): Binding | undefined {
  const c = eventChordId(e);
  // Forward delete does what delete does unless bound itself (⌘⌦ Ripple Deletes, as ⌘⌫), for keyboards and remaps that send it.
  return map.get(c) ?? (e.code === "Delete" ? map.get(c.replace(/\|Delete$/, "|Backspace")) : undefined);
}

export { menuKey } from "@beacon/model";

export interface ActionHost {
  run(command: string, args?: unknown): void;
  undo(): void;
  redo(): void;
  openDialog(): void;
  /** One of the app's own actions (`app.export`…), as its menu item runs it. */
  app(id: string): void;
}

/** Runs an action as its key or menu item would: the app's own through the main process, the rest as commands. */
export function runAction(host: ActionHost, a: Pick<ShortcutInfo, "command" | "args">) {
  if (a.command === "app.palette") replica.palette(true);
  else if (a.command === "app.projectSettings") replica.projectSettings(true);
  else if (a.command === "app.save") replica.confirmSaved();
  else if (a.command === "app.open") host.openDialog();
  else if (a.command.startsWith("app.")) host.app(a.command);
  else if (a.command === "project.undo") host.undo();
  else if (a.command === "project.redo") host.redo();
  else host.run(a.command, a.args ?? {});
}
