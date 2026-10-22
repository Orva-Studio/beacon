import { z } from "zod";

/** Modifiers in the order menus show them (⌃⌥⇧⌘). */
export const MODIFIERS = ["control", "option", "shift", "command"] as const;

const StepSchema = z.object({
  key: z.string().describe('one character ("t", ",", "<") or ↩ ⇥ ⌫ ⌦ ⎋ ← → ↑ ↓ Space'),
  modifiers: z.array(z.enum(MODIFIERS)),
});

/**
 * A shortcut as keymaps write it: a key ("t", "⌫", "<") and its modifiers (control, option, shift, command); with
 * `then`, the keys pressed after it, one by one (the leader key: ":" then "a").
 */
export const KeysSchema = StepSchema.extend({ then: z.array(StepSchema).min(1).optional().describe("Keys pressed after it, in turn (a sequence: : then a)") });
export interface Keys {
  key: string;
  modifiers: string[];
  then?: { key: string; modifiers: string[] }[];
}

/** A shortcut's keys pressed in turn: one, or a sequence. */
export const keySteps = (keys: Keys): Keys[] => [{ key: keys.key, modifiers: keys.modifiers }, ...(keys.then ?? [])];

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

/** KeyboardEvent.code → the key keymaps write for it. */
const CODE_TO_KEY = new Map(Object.entries(NAMED).map(([key, code]) => [code, key]));

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

const chordKey = (mods: string, code: string) => `${mods}|${code}`;

/** One string per physical chord, so "<" and ⇧, are the same shortcut; a sequence's chords joined by spaces. */
export const chordId = (keys: Keys): string | undefined => {
  const ids = keySteps(keys).map((k) => chordOf(k));
  return ids.every(Boolean) ? ids.map((c) => chordKey(c!.mods, c!.code)).join(" ") : undefined;
};

/** Whether two shortcuts can't both be kept: the same keys, or one begins the other (: would never reach : a). */
export const keysClash = (a: Keys, b: Keys): boolean => {
  const [x, y] = [chordId(a), chordId(b)];
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
};

type KeyEventLike = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

const held = (e: KeyEventLike) => MODIFIERS.filter((m) => (m === "control" ? e.ctrlKey : m === "option" ? e.altKey : m === "shift" ? e.shiftKey : e.metaKey));

/** The chord a key press is (`chordId`'s form), whatever key it types. */
export const eventChordId = (e: KeyEventLike): string => chordKey([...held(e)].sort().join("+"), e.code);

/** Whether a shortcut can be a native menu's key equivalent: one with ⌘ or ⌃ never types into a text field. */
export const menuKey = (keys: Keys) => !keys.then && !!chordOf(keys) && (keys.modifiers.includes("command") || keys.modifiers.includes("control"));

/** The keys a key press makes, as keymaps write them (lower-case letters, shift as a modifier); undefined for a modifier alone. */
export function keysOfEvent(e: KeyEventLike): Keys | undefined {
  const key = keyOfCode(e.code);
  if (key === undefined) return undefined;
  // Written as typed, as the defaults are: ⇧; is ":" (the leader key), ⇧, is "<".
  const typed = e.shiftKey ? TYPED_SHIFTED.get(key) : undefined;
  return typed ? { key: typed, modifiers: held(e).filter((m) => m !== "shift") } : { key, modifiers: held(e) };
}

const TYPED_SHIFTED = new Map(Object.entries(SHIFTED).map(([typed, key]) => [key, typed]));

/** The key keymaps write for a KeyboardEvent.code (lower-case letters); undefined for one they don't name. */
export function keyOfCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_TO_KEY.get(code);
}

/**
 * "⇧⌘=" style label for menus, tooltips and Settings, from the chord pressed: "I" is ⇧I; a shifted symbol ("<")
 * shows as itself, its ⇧ implied.
 */
export function keysLabel(keys: Keys): string {
  if (keys.then) return keySteps(keys).map(keysLabel).join(" ");
  const sym: Record<string, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
  const mods = new Set(chordOf(keys)?.mods.split("+").filter(Boolean) ?? keys.modifiers);
  if (SHIFTED[keys.key]) mods.delete("shift");
  // ⎋ is macOS's own symbol for Escape, but few recognise it.
  const key = keys.key === "⎋" ? "Esc" : keys.key.length === 1 ? keys.key.toUpperCase() : keys.key;
  return MODIFIERS.filter((m) => mods.has(m)).map((m) => sym[m]).join("") + key;
}

/** Whether `args` are the same as an action's (key order aside). */
export function sameArgs(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const norm = (o: Record<string, unknown> | undefined) => JSON.stringify(Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}
