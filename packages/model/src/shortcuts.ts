/** A shortcut as keymaps write it: a key ("t", "⌫", "<") and its modifiers (control, option, shift, command). */
export interface Keys {
  key: string;
  modifiers: string[];
}

/** An action the editor lists (`keymaps/actions.json`): what keys, menus and the command palette run. */
export interface ActionListing {
  /** `command` alone, or `command:variant` when its args make it a separate action ("playhead.jump:start"). */
  id: string;
  name: string;
  /** The command it runs, with `args`; none for the app's own (`app.*`) and undo/redo, run by their id. */
  command?: string;
  args?: Record<string, unknown>;
  /** For actions with no command; others take their command's. */
  description?: string;
  /** Why its keys can't be changed (Cut, Copy and Paste are macOS's own). */
  fixed?: string;
}

/** An action with its keys, as Settings › Shortcuts and the palette list it. */
export interface ShortcutInfo {
  id: string;
  name: string;
  description: string;
  command: string;
  args?: Record<string, unknown>;
  keys: Keys[];
  /** Whether `keys` are the default ones. */
  standard: boolean;
  fixed?: string;
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

const ORDER = ["control", "option", "shift", "command"];

/** Physical key (KeyboardEvent.code) and modifiers: option changes `key` on macOS, so codes are what match. */
export interface Chord {
  code: string;
  /** Sorted, joined by "+". */
  mods: string;
}

export function chordOf(keys: Keys): Chord | undefined {
  const mods = new Set(keys.modifiers);
  let key = keys.key;
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

/** One string per physical chord, so "<" and ⇧, are the same shortcut. */
export const chordId = (keys: Keys): string | undefined => {
  const c = chordOf(keys);
  return c && `${c.mods}|${c.code}`;
};

/** The keys a key press makes, as keymaps write them (lower-case letters, shift as a modifier); undefined for a modifier alone. */
export function keysOfEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): Keys | undefined {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else key = Object.entries(NAMED).find(([, code]) => code === e.code)?.[0];
  if (!key) return undefined;
  const modifiers = ORDER.filter((m) => (m === "control" ? e.ctrlKey : m === "option" ? e.altKey : m === "shift" ? e.shiftKey : e.metaKey));
  return { key, modifiers };
}

/** "⇧⌘=" style label for menus, tooltips and Settings. */
export function keysLabel(keys: Keys): string {
  const sym: Record<string, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
  return ORDER.filter((m) => keys.modifiers.includes(m)).map((m) => sym[m]).join("") + (keys.key.length === 1 ? keys.key.toUpperCase() : keys.key);
}

/** Whether `args` are the same as an action's (key order aside). */
export function sameArgs(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const norm = (o: Record<string, unknown> | undefined) => JSON.stringify(Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}
