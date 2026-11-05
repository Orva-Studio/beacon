import { chordId, keysClash, keysLabel, type Keys, type ShortcutInfo } from "@beacon/model";

/** Uses an item needs before Beacon offers it a shortcut, on at least this many days: a burst in one sitting isn't a habit. */
export const OFFER_USES = 5;
const OFFER_DAYS = 2;
/** Learned shortcuts kept at once. */
export const MOST_LEARNED = 10;
/** Days Beacon is used without a learned shortcut being used before it goes (days it isn't open don't count). */
export const UNUSED_DAYS = 7;
/** Uses after which a learned shortcut stops showing "new" in the leader popup. */
export const NEW_USES = 3;

/** `learned.json`: shortcuts learned from what the user uses, offers turned down, and the days Beacon was used. */
export interface LearnedFile {
  shortcuts: { item: string; keys: Keys; added: number; uses: number; last: string }[];
  /** Offers turned down, by item: when; offered again once it has been used OFFER_USES more times. */
  declined: Record<string, number>;
  /** Removed by the user in Memory: never offered again. */
  stopped: string[];
  /** Removed for going unused, newest last, for the toast's Undo. */
  removed: { item: string; keys: Keys; at: number }[];
  /** Days Beacon was used (YYYY-MM-DD), the last 60. */
  days: string[];
}

export const emptyLearned = (): LearnedFile => ({ shortcuts: [], declined: {}, stopped: [], removed: [], days: [] });

export const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A panel item a shortcut can run: its name and what it does. */
export interface ItemAction {
  item: string;
  name: string;
  command: string;
  args: Record<string, unknown>;
}

/** A shortcut Beacon offers for an item used often. */
export interface ShortcutOffer {
  item: string;
  name: string;
  keys: Keys;
  /** Its uses so far. */
  uses: number;
}

/**
 * Keys for an item, after the leader: two letters from its name where free (Drop Shadow → D S, then D R…), else the
 * first free pair. Never keys another action has, nor ones the user cleared from an action; a sequence can't be the
 * start of another, or have another as its start. Its first key is never one Beacon's own sequences start with
 * (`ownFirst`): a learned shortcut doesn't join Color Label's group, say. Learned ones may share a first key.
 */
export function pickKeys(name: string, leader: Keys, taken: Keys[], ownFirst: Set<string> = new Set()): Keys | undefined {
  const words = name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  const alphabet = [..."abcdefghijklmnopqrstuvwxyz"];
  const initials = words.map((w) => w[0]!);
  const letters = [...words.join("")];
  const firsts = [...new Set([...initials, ...letters, ...alphabet])].filter((a) => !ownFirst.has(a));
  for (const a of firsts) {
    for (const b of [...new Set([...initials, ...letters, ...alphabet])]) {
      if (b === a) continue;
      const keys: Keys = { key: leader.key, modifiers: leader.modifiers, then: [{ key: a, modifiers: [] }, { key: b, modifiers: [] }] };
      if (!taken.some((t) => keysClash(t, keys))) return keys;
    }
  }
  return undefined;
}

/** The first keys Beacon's own sequences take after the leader (their groups and single keys). */
export function firstKeys(own: Keys[], leader: Keys): Set<string> {
  const lead = chordId(leader);
  return new Set(own.filter((k) => k.then?.length && chordId({ key: k.key, modifiers: k.modifiers }) === lead).map((k) => k.then![0]!.key.toLowerCase()));
}

/** The items to offer a shortcut, most used first: used enough, on enough days, not learned, removed or turned down lately. */
export function offers(file: LearnedFile, usage: Record<string, number[]>, items: Map<string, ItemAction>, leader: Keys, taken: Keys[], ownFirst: Set<string>): ShortcutOffer[] {
  if (file.shortcuts.length >= MOST_LEARNED) return [];
  const learned = new Set(file.shortcuts.map((s) => s.item));
  const out: ShortcutOffer[] = [];
  const keys = [...taken];
  for (const [item, times] of Object.entries(usage).sort((a, b) => b[1].length - a[1].length)) {
    const action = items.get(item);
    if (!action || learned.has(item) || file.stopped.includes(item)) continue;
    const since = file.declined[item];
    const counted = since === undefined ? times : times.filter((t) => t > since);
    if (counted.length < OFFER_USES || new Set(counted.map(dayOf)).size < OFFER_DAYS) continue;
    const k = pickKeys(action.name, leader, keys, ownFirst);
    if (!k) continue;
    keys.push(k);
    out.push({ item, name: action.name, keys: k, uses: times.length });
  }
  return out.slice(0, MOST_LEARNED - file.shortcuts.length);
}

/** Learned shortcuts gone unused for UNUSED_DAYS days of use, after counting today as one. */
export function sweep(file: LearnedFile, now: number): { file: LearnedFile; removed: LearnedFile["removed"] } {
  const today = dayOf(now);
  const days = file.days.includes(today) ? file.days : [...file.days, today].slice(-60);
  const stale = file.shortcuts.filter((s) => days.filter((d) => d > s.last).length >= UNUSED_DAYS);
  const removed = stale.map((s) => ({ item: s.item, keys: s.keys, at: now }));
  return { file: { ...file, days, shortcuts: file.shortcuts.filter((s) => !stale.includes(s)), removed: [...file.removed, ...removed].slice(-10) }, removed };
}

/** A learned shortcut as the shortcut list shows it: `learned:<item>`, run as its tile's double-click is. */
export function learnedInfo(s: LearnedFile["shortcuts"][number], action: ItemAction, keys: Keys): ShortcutInfo {
  return {
    id: `learned:${s.item}`,
    name: action.name,
    description: `Learned from how often you use it (${s.uses ? `${s.uses} ${s.uses === 1 ? "use" : "uses"} of the shortcut` : "not used yet"}): see Settings › Memory`,
    command: action.command,
    args: action.args,
    keys: [keys],
    standard: true,
    learned: true,
    ...(s.uses < NEW_USES ? { fresh: true } : {}),
  };
}

/** Keys the user cleared from an action (a default they removed): never given to a learned shortcut. */
export function clearedKeys(list: ShortcutInfo[], defaults: (id: string) => Keys[]): Keys[] {
  return list.filter((s) => !s.standard).flatMap((s) => defaults(s.id).filter((d) => !s.keys.some((k) => chordId(k) === chordId(d))));
}

export const label = (keys: Keys) => keysLabel(keys);
