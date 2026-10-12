import type { Binding } from "./rpc";

/** Physical key (KeyboardEvent.code) and modifiers: option changes `key` on macOS, so codes are what match. */
interface Chord {
  code: string;
  mods: string;
}

const NAMED: Record<string, string> = {
  "↩": "Enter",
  "⇥": "Tab",
  Space: "Space",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "⌫": "Backspace",
  "⌦": "Delete",
  "⎋": "Escape",
  ",": "Comma",
  ".": "Period",
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
};

/** Characters typed with shift on a US layout, as keymaps write them. */
const SHIFTED: Record<string, string> = { "<": ",", ">": ".", "+": "=", _: "-", "{": "[", "}": "]", "|": "\\", "?": "/", ":": ";", '"': "'", "~": "`" };

function chordOf(b: Binding["keys"]): Chord | undefined {
  const mods = new Set(b.modifiers);
  let key = b.key;
  if (SHIFTED[key]) {
    key = SHIFTED[key]!;
    mods.add("shift");
  } else if (/^[A-Z]$/.test(key)) {
    mods.add("shift");
  }
  let code: string | undefined;
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  else code = NAMED[key];
  if (!code) return undefined;
  return { code, mods: [...mods].sort().join("+") };
}

function eventChord(e: KeyboardEvent): Chord {
  const mods = [e.ctrlKey && "control", e.altKey && "option", e.shiftKey && "shift", e.metaKey && "command"].filter(Boolean) as string[];
  return { code: e.code, mods: mods.sort().join("+") };
}

/** Bindings that resolve to a command, by chord. */
export function compileKeymap(bindings: Binding[]): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const b of bindings) {
    if (!b.command) continue;
    const c = chordOf(b.keys);
    if (c) map.set(`${c.mods}|${c.code}`, b);
  }
  return map;
}

export function match(map: Map<string, Binding>, e: KeyboardEvent): Binding | undefined {
  const c = eventChord(e);
  // Forward delete does what delete does unless bound itself (⌘⌦ Ripple Deletes, as ⌘⌫), for keyboards and remaps that send it.
  return map.get(`${c.mods}|${c.code}`) ?? (c.code === "Delete" ? map.get(`${c.mods}|Backspace`) : undefined);
}

/** "⇧⌘=" style label for menus and tooltips. */
export function label(b: Binding["keys"]): string {
  const sym: Record<string, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
  return ["control", "option", "shift", "command"].filter((m) => b.modifiers.includes(m)).map((m) => sym[m]).join("") + (b.key.length === 1 ? b.key.toUpperCase() : b.key);
}
