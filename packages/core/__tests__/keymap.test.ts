import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chordId, sameArgs } from "@beacon/model";
import actions from "../../../keymaps/actions.json";
import keymap from "../../../keymaps/default.json";
import { LocalCore } from "../src";

const bindings = keymap.bindings as { keys: { key: string; modifiers: string[] }; command: string; args?: Record<string, unknown> }[];
const listed = actions.actions as { id: string; command?: string; args?: Record<string, unknown> }[];

test("every action runs a real command, and every shortcut is one action's", () => {
  const ids = new Set(new LocalCore().commands().map((c) => c.id));
  // The app's own (menus, dialogs) and undo/redo run by their id.
  expect(listed.filter((a) => !ids.has(a.command ?? a.id) && !/^(app\.|project\.(undo|redo)$)/.test(a.id)).map((a) => a.id)).toEqual([]);
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
});

test("a shortcut changed is saved over the defaults; a key taken is refused unless moved; reset puts them back", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "beacon-keymap-"));
  try {
    const core = new LocalCore({ configDir });
    const keys = async (id: string) => (await core.shortcuts()).find((s) => s.id === id)!.keys;
    const cmdD = { key: "d", modifiers: ["command"] };
    expect(core.shortcutSet("edit.split", [cmdD])).rejects.toThrow("⌘D is Duplicate's shortcut");
    await core.shortcutSet("edit.split", [cmdD], true);
    // Read again by a new core, as the next launch would.
    const again = new LocalCore({ configDir });
    const list = await again.shortcuts();
    expect(list.find((s) => s.id === "edit.split")!.keys).toEqual([cmdD]);
    expect(list.find((s) => s.id === "edit.duplicate")!.keys).toEqual([]);
    expect(list.filter((s) => !s.standard).map((s) => s.id).sort()).toEqual(["edit.duplicate", "edit.split"]);
    expect(core.shortcutSet("edit.copy", [{ key: "y", modifiers: ["command"] }])).rejects.toThrow("can't be changed");
    await core.shortcutReset("edit.split");
    expect(await keys("edit.split")).toEqual([{ key: "t", modifiers: ["command"] }]);
    await core.shortcutReset();
    expect(await keys("edit.duplicate")).toEqual([cmdD]);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
