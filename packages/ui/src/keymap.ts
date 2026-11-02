import { chordId, eventChordId, keysLabel, LEADER_ACTION, sameArgs, type ShortcutInfo } from "@beacon/model";
import type { Binding } from "./rpc";
import { useMemo } from "react";
import { AI_TOOLS } from "./panel-items";
import { replica, useView } from "./store";

/** Each action's keys as the window matches them; the leader key's own only starts the sequences that have it. */
const bindingsOf = (shortcuts: ShortcutInfo[]): Binding[] =>
  shortcuts.filter((s) => s.id !== LEADER_ACTION).flatMap((s) => s.keys.map((keys) => ({ keys, command: s.command, ...(s.args ? { args: s.args } : {}), action: s.id })));

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

/**
 * A key pressed partway through a sequence (`pending`: the chords so far, `chordId`'s form), or one that could start
 * one: the binding it completes, or the sequence it continues (`pending`), or neither (the sequence is dropped).
 */
export function sequenceStep(map: Map<string, Binding>, pending: string | undefined, e: KeyboardEvent): { binding?: Binding; pending?: string } {
  const so = pending ? `${pending} ${eventChordId(e)}` : eventChordId(e);
  const binding = pending ? map.get(so) : undefined;
  if (binding) return { binding };
  for (const id of map.keys()) if (id.startsWith(`${so} `)) return { pending: so };
  return {};
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

/**
 * Runs an action as its key or menu item would: the app's own through the main process, an AI tool's (`ai.<tool>`)
 * as its tile, the rest as commands.
 */
export function runAction(host: ActionHost, a: Pick<ShortcutInfo, "command" | "args">) {
  if (a.command === "app.palette") replica.palette(true);
  else if (a.command === "app.projectSettings") replica.projectSettings(true);
  else if (a.command === "app.save") replica.confirmSaved();
  else if (a.command === "app.open") host.openDialog();
  else if (a.command.startsWith("app.")) host.app(a.command);
  else if (a.command.startsWith("ai.")) AI_TOOLS.find((t) => `ai.${t.id}` === a.command)?.start(host);
  else if (a.command === "inspector.step") {
    replica.focusInputs(false, replica.get().session?.inspector ?? "");
    host.run(a.command, a.args ?? {});
  }
  else if (a.command === "project.undo") host.undo();
  else if (a.command === "project.redo") host.redo();
  else host.run(a.command, a.args ?? {});
}
