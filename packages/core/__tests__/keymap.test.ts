import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chordId, keysClash, keysLabel, sameArgs } from "@beacon/model";
import actions from "../../../keymaps/actions.json";
import keymap from "../../../keymaps/default.json";
import { LocalCore } from "../src";

const bindings = keymap.bindings as { keys: { key: string; modifiers: string[] }; command: string; args?: Record<string, unknown> }[];
const listed = actions.actions as { id: string; command?: string; args?: Record<string, unknown> }[];

test("every action runs a real command, and every shortcut is one action's", () => {
  const ids = new Set(new LocalCore().commands().map((c) => c.id));
  // The app's own (menus, dialogs), the AI panel's tiles and undo/redo run by their id.
  expect(listed.filter((a) => !ids.has(a.command ?? a.id) && !/^(app\.|ai\.|project\.(undo|redo)$)/.test(a.id)).map((a) => a.id)).toEqual([]);
  expect(bindings.filter((b) => listed.filter((a) => (a.command ?? a.id) === b.command && sameArgs(a.args, b.args)).length !== 1).map((b) => b.command)).toEqual([]);
  // ⇧I and ⇧i are one chord written twice for one action; a chord on two actions is a clash.
  const owner = new Map<string, string>();
  const clashes = bindings.filter((b) => {
    const c = chordId(b.keys);
    const action = `${b.command} ${JSON.stringify(b.args ?? {})}`;
    if (!c || (owner.has(c) && owner.get(c) !== action)) return true;
    owner.set(c, action);
    return false;
  });
  expect(clashes.map((b) => b.keys)).toEqual([]);
  // A shortcut that begins another's would never let the longer one be pressed (: would hide : a).
  const prefixes = bindings.flatMap((a) => bindings.filter((b) => b !== a && chordId(a.keys) !== chordId(b.keys) && keysClash(a.keys, b.keys)).map((b) => `${keysLabel(a.keys)} / ${keysLabel(b.keys)}`));
  expect(prefixes).toEqual([]);
});

test("the leader key: : then a key is a shortcut of its own, labelled as typed; : alone can't be one while sequences start with it", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "beacon-leader-"));
  try {
    const core = new LocalCore({ configDir });
    const list = await core.shortcuts();
    expect(list.find((s) => s.id === "edit.deleteAudio")!.keys.map(keysLabel)).toEqual([": A"]);
    expect(list.find((s) => s.id === "edit.label:red")!.keys.map(keysLabel)).toEqual([": C R"]);
    expect(list.find((s) => s.id === "edit.unlink")!.keys.map(keysLabel)).toEqual(["⌘L", ": U"]);
    expect(list.find((s) => s.id === "app.palette")!.keys.map(keysLabel)).toEqual(["⌘K", ": P"]);
    const colon = { key: ":", modifiers: [] };
    await expect(core.shortcutSet("edit.split", [colon])).rejects.toThrow(/: [A-Z].* is .*'s shortcut/);
    await core.shortcutSet("edit.split", [{ ...colon, then: [{ key: "x", modifiers: [] }] }]);
    expect((await core.shortcuts()).find((s) => s.id === "edit.split")!.keys.map(keysLabel)).toEqual([": X"]);
    // : C is a group (Color Label…): taking it alone would hide its colours.
    await expect(core.shortcutSet("edit.split", [{ ...colon, then: [{ key: "c", modifiers: [] }] }])).rejects.toThrow(/Color Label/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("an action's keys are one per chord, labelled as pressed: capital I is ⇧I, < is itself", async () => {
  const list = await new LocalCore().shortcuts();
  const labels = (id: string) => list.find((s) => s.id === id)!.keys.map(keysLabel);
  expect(labels("playhead.jump:previousAnimation")).toEqual(["⇧I"]);
  expect(labels("playhead.jump:nextAnimation").sort()).toEqual(["⌥I", "⌥⇧I"].sort());
  expect(labels("range.extend:left")).toEqual(["<"]);
});

test("a shortcut changed is saved over the defaults; a key taken is refused unless moved; reset puts them back", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "beacon-keymap-"));
  try {
    const core = new LocalCore({ configDir });
    const keys = async (id: string) => (await core.shortcuts()).find((s) => s.id === id)!.keys;
    const cmdD = { key: "d", modifiers: ["command"] };
    await expect(core.shortcutSet("edit.split", [cmdD])).rejects.toThrow("⌘D is Duplicate's shortcut");
    await core.shortcutSet("edit.split", [cmdD], true);
    // Read again by a new core, as the next launch would.
    const again = new LocalCore({ configDir });
    const list = await again.shortcuts();
    expect(list.find((s) => s.id === "edit.split")!.keys).toEqual([cmdD]);
    expect(list.find((s) => s.id === "edit.duplicate")!.keys).toEqual([]);
    expect(list.filter((s) => !s.standard).map((s) => s.id).sort()).toEqual(["edit.duplicate", "edit.split"]);
    await expect(core.shortcutSet("edit.copy", [{ key: "y", modifiers: ["command"] }])).rejects.toThrow("can't be changed");
    await core.shortcutReset("edit.split");
    expect(await keys("edit.split")).toEqual([{ key: "t", modifiers: ["command"] }]);
    await core.shortcutReset();
    expect(await keys("edit.duplicate")).toEqual([cmdD]);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
