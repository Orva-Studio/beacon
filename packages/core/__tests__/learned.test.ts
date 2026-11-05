import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@beacon/features";
import { DEFAULT_LEADER, keysLabel, type ShortcutInfo } from "@beacon/model";
import type { AppEvent } from "../src";
import { AppConfig } from "../src/config";
import { pickKeys } from "../src/learned";

const dir = mkdtempSync(join(tmpdir(), "beacon-learned-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;
/** Noon on the nth day from a fixed start, so days don't depend on when the test runs. */
const day = (n: number, minute = 0) => new Date(2026, 10, 2 + n, 12, minute).getTime();

// Asked, never added by itself (the user, 2026-10-31); panel items only, gone after 7 days of use unused (2026-11-03).
test("learned shortcuts: offered after 5 uses over 2 days, keys from the name where free, added only when the user says so; not now waits for 5 more uses; new until used 3 times; they follow the leader, yield to the user's own keys, go after 7 days of use unused (with Undo), and a removed one is never offered again", () => {
  const events: AppEvent[] = [];
  const config = new AppConfig(join(dir, "config"), createRegistry(), { get: async () => undefined, set: async () => {} }, (e) => events.push(e));
  const offers = (now: number) => config.memory(now).shortcuts.offers.map((o) => [o.item, keysLabel(o.keys)]);
  const learned = () => config.shortcuts().filter((s) => s.learned);
  const SHADOW = "effect:drop-shadow";

  // Five uses in one sitting: a burst, not a habit.
  for (let i = 0; i < 5; i++) config.itemUsed(SHADOW, day(0, i));
  expect(offers(day(0, 10))).toEqual([]);
  // On a second day: offered, D S from its name. Nothing is added by itself.
  config.itemUsed(SHADOW, day(1));
  expect(offers(day(1, 1))).toEqual([[SHADOW, ": D S"]]);
  expect(events.some((e) => e.kind === "memory" && e.memory.shortcuts.offers.length === 1)).toBe(true);
  expect(learned()).toEqual([]);

  // Not now: not offered again until used as often again.
  config.memoryChange({ shortcut: { decline: SHADOW } }, day(1, 2));
  for (let i = 0; i < 4; i++) config.itemUsed(SHADOW, day(2, i));
  expect(offers(day(2, 10))).toEqual([]);
  config.itemUsed(SHADOW, day(3));
  expect(offers(day(3, 1))).toEqual([[SHADOW, ": D S"]]);

  // Added: in the shortcut list as its tile's double-click, "new" until used 3 times by its keys.
  config.memoryChange({ shortcut: { add: SHADOW } }, day(3, 2));
  const [shadow] = learned() as [ShortcutInfo];
  expect(shadow).toMatchObject({ id: `learned:${SHADOW}`, name: "Drop Shadow", command: "edit.addEffect", args: { type: "drop-shadow" }, fresh: true });
  expect(shadow.keys.map(keysLabel)).toEqual([": D S"]);
  expect(offers(day(3, 3))).toEqual([]);
  for (let i = 0; i < 3; i++) config.itemUsed(SHADOW, day(3, 10 + i));
  expect(learned()[0]!.fresh).toBeUndefined();
  expect(config.memory(day(3, 20)).shortcuts.learned).toMatchObject([{ item: SHADOW, name: "Drop Shadow", uses: 3 }]);

  // Another leader key moves it; keys of Beacon's own given to it make it yield.
  config.shortcutSet("app.leader", [{ key: "\\", modifiers: [] }]);
  expect(learned()[0]!.keys.map(keysLabel)).toEqual(["\\ D S"]);
  config.shortcutReset("app.leader");
  config.shortcutSet("edit.split", [{ key: ":", modifiers: [], then: [{ key: "d", modifiers: [] }, { key: "s", modifiers: [] }] }]);
  expect(learned()).toEqual([]);
  config.shortcutReset("edit.split");
  expect(learned()).toHaveLength(1);

  // Unused for 7 days Beacon was used (days it wasn't open don't count): gone, and said with Undo.
  for (const n of [5, 6, 9, 10, 12, 13]) config.memory(day(n));
  expect(learned()).toHaveLength(1);
  const swept = config.memory(day(20));
  expect(learned()).toEqual([]);
  expect(swept.shortcuts.removed).toMatchObject([{ item: SHADOW, name: "Drop Shadow", at: day(20) }]);
  config.memoryChange({ shortcut: { restore: SHADOW } }, day(20, 1));
  expect(learned()).toHaveLength(1);

  // Removed by the user: gone for good, however often it is used.
  config.memoryChange({ shortcut: { remove: SHADOW } }, day(21));
  for (let i = 0; i < 6; i++) config.itemUsed(SHADOW, day(22 + (i % 2), i));
  expect(learned()).toEqual([]);
  expect(offers(day(24))).toEqual([]);

  // Another item: T starts Beacon's own sequences (Toggle), so its name's next letter leads.
  for (let i = 0; i < 5; i++) config.itemUsed("annotation:text", day(25 + (i % 2), i));
  expect(offers(day(27))).toEqual([["annotation:text", ": E T"]]);
  expect(DAY).toBeGreaterThan(0);
});

test("a learned shortcut's keys are two letters of its name where free, else the next free pair, never the start of another sequence or one starting with its keys, nor in a group of Beacon's own", () => {
  const seq = (...k: string[]) => ({ key: ":", modifiers: [], then: k.map((key) => ({ key, modifiers: [] })) });
  expect(keysLabel(pickKeys("Drop Shadow", DEFAULT_LEADER, [])!)).toBe(": D S");
  expect(keysLabel(pickKeys("Drop Shadow", DEFAULT_LEADER, [seq("d", "s")])!)).toBe(": D R");
  // ": d" alone is a shortcut: nothing can start with it.
  expect(keysLabel(pickKeys("Drop Shadow", DEFAULT_LEADER, [seq("d")])!)).toBe(": S D");
  // ": d s x" is one: ": d s" would cut it off.
  expect(keysLabel(pickKeys("Drop Shadow", DEFAULT_LEADER, [seq("d", "s", "x")])!)).toBe(": D R");
  // C starts Color Label's group: CRT Monitor goes elsewhere.
  expect(keysLabel(pickKeys("CRT Monitor", DEFAULT_LEADER, [], new Set(["c", "m", "r", "t"]))!)).toBe(": O C");
});
