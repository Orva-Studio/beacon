import { z } from "zod";
import { chordId, keysClash, KeysSchema, keysLabel, sameArgs, type ActionListing, type Keys, type ShortcutInfo } from "@beacon/model";
import actionList from "../../../keymaps/actions.json";
import defaultKeymap from "../../../keymaps/default.json";

const ACTIONS = actionList.actions as ActionListing[];
const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const DEFAULTS = defaultKeymap.bindings as { keys: Keys; command: string; args?: Record<string, unknown> }[];

/** `keymap.json`: the user's keys by action id, replacing that action's defaults (an empty list: no keys). */
export const KeymapFileSchema = z.object({ overrides: z.record(z.string(), z.array(KeysSchema)) });
export type KeymapOverrides = Record<string, Keys[]>;

/** Key hints in command descriptions ("(⇧⌘T)", "(⌃⇧← / ⌃⇧→)") go stale once keys change: the list shows the real ones. */
const keyHints = /\s*\((?:[⌃⌥⇧⌘]*[^\s()⌃⌥⇧⌘]{1,2}(?:\s*(?:\/|,|or)\s*)?)+\)/g;

/** Each action's default keys, one per physical chord (the keymap writes ⇧I both as "I" and as shift "i"). */
const DEFAULT_KEYS = new Map(
  ACTIONS.map((a) => {
    const keys = new Map<string, Keys>();
    for (const b of DEFAULTS) if (b.command === (a.command ?? a.id) && sameArgs(b.args, a.args) && !keys.has(chordId(b.keys)!)) keys.set(chordId(b.keys)!, b.keys);
    return [a.id, [...keys.values()]];
  }),
);
const defaultKeys = (id: string) => DEFAULT_KEYS.get(id) ?? [];

/** Every action with its keys: the defaults, with the user's overrides merged over them. */
export function shortcutList(overrides: KeymapOverrides, describe: (command: string) => string | undefined): ShortcutInfo[] {
  return ACTIONS.map((a) => {
    const own = overrides[a.id];
    return {
      id: a.id,
      name: a.name,
      description: (a.description ?? describe(a.command ?? a.id) ?? "").replace(keyHints, ""),
      command: a.command ?? a.id,
      ...(a.args ? { args: a.args } : {}),
      keys: own && !a.fixed ? own : defaultKeys(a.id),
      standard: !own || !!a.fixed,
      ...(a.fixed ? { fixed: a.fixed } : {}),
      ...(a.palette ? { palette: true } : {}),
    };
  });
}

/**
 * The overrides after giving `id` these keys. A key another action has is refused, naming it, unless `replace`:
 * then it moves here. Keys equal to the defaults drop the override.
 */
export function setShortcut(overrides: KeymapOverrides, id: string, keys: Keys[], replace: boolean): KeymapOverrides {
  const action = ACTION_BY_ID.get(id);
  if (!action) throw new Error(`no action "${id}"; shortcuts_list lists them`);
  if (action.fixed) throw new Error(`${action.name}'s keys can't be changed: ${action.fixed}`);
  for (const k of keys) if (!chordId(k)) throw new Error(`"${keysLabel(k)}" isn't a key Beacon can bind`);
  const clashing = (k: Keys) => keys.some((mine) => keysClash(mine, k));
  const next = { ...overrides };
  for (const other of shortcutList(overrides, () => undefined)) {
    if (other.id === id) continue;
    const taken = other.keys.filter(clashing);
    if (!taken.length) continue;
    if (!replace) throw new Error(`${keysLabel(taken[0]!)} is ${other.name}'s shortcut`);
    if (other.fixed) throw new Error(`${keysLabel(taken[0]!)} is ${other.name}'s, which can't change (${other.fixed})`);
    const rest = other.keys.filter((k) => !clashing(k));
    if (sameKeys(rest, defaultKeys(other.id))) delete next[other.id];
    else next[other.id] = rest;
  }
  if (sameKeys(keys, defaultKeys(id))) delete next[id];
  else next[id] = keys;
  return next;
}

const sameKeys = (a: Keys[], b: Keys[]) => a.length === b.length && a.every((k, i) => chordId(k) === chordId(b[i]!));
