import { chordId, chordOf, keysLabel, sameArgs, type Keys, type ShortcutInfo } from "@beacon/model";
import type { Binding } from "./rpc";
import { useView } from "./store";

/** Each action's keys as the window matches them. */
export const bindingsOf = (shortcuts: ShortcutInfo[]): Binding[] =>
  shortcuts.flatMap((s) => s.keys.map((keys) => ({ keys, command: s.command, ...(s.args ? { args: s.args } : {}), action: s.id })));

/** " (⌘T)" for a button's tooltip: the first key of the action that runs `command` with `args`, as the user has them. */
export function useShortcutTip() {
  const shortcuts = useView((v) => v.shortcuts);
  return (command: string, args?: object) => {
    const keys = shortcuts.find((s) => s.command === command && sameArgs(s.args, args as Record<string, unknown> | undefined))?.keys[0];
    return keys ? ` (${keysLabel(keys)})` : "";
  };
}

/** Bindings that resolve to a command, by chord. */
export function compileKeymap(bindings: Binding[]): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const b of bindings) {
    const id = b.command && chordId(b.keys);
    if (id) map.set(id, b);
  }
  return map;
}

function eventChord(e: KeyboardEvent): string {
  const mods = [e.ctrlKey && "control", e.altKey && "option", e.shiftKey && "shift", e.metaKey && "command"].filter(Boolean) as string[];
  return `${mods.sort().join("+")}|${e.code}`;
}

export function match(map: Map<string, Binding>, e: KeyboardEvent): Binding | undefined {
  const c = eventChord(e);
  // Forward delete does what delete does unless bound itself (⌘⌦ Ripple Deletes, as ⌘⌫), for keyboards and remaps that send it.
  return map.get(c) ?? (e.code === "Delete" ? map.get(c.replace(/\|Delete$/, "|Backspace")) : undefined);
}

/** Whether a shortcut can be a native menu's key equivalent: one with ⌘ or ⌃ never types into a text field. */
export const menuKey = (keys: Keys) => !!chordOf(keys) && (keys.modifiers.includes("command") || keys.modifiers.includes("control"));
