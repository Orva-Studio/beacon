import { expect, test } from "bun:test";
import keymap from "../../../keymaps/default.json";
import { LocalCore } from "../src";

test("every shortcut runs a real command", () => {
  const ids = new Set([...new LocalCore().commands().map((c) => c.id), "project.undo", "project.redo"]);
  const bindings = keymap.bindings as { command: string }[];
  expect(bindings.filter((b) => b.command && !ids.has(b.command)).map((b) => b.command)).toEqual([]);
});
