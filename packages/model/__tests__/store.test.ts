import { expect, test } from "bun:test";
import { anyAgent, authorIs, ProjectStore, UndoBlocked } from "../src";
import { setup } from "./fixture";

test("apply then undo returns the original document exactly, and redo the edited one", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Screen" }).result;
  const a = store.run<string>("clip.add", { type: "video", track, start: 0, duration: 100 }).result;
  store.run("clip.add", { type: "video", track, start: 200, duration: 50 });
  const before = store.doc;
  const beforeJson = JSON.stringify(before);

  store.transaction("Agent: rough cut", (tx) => {
    tx.run("clip.set", { clip: a, start: 100, props: { opacity: 0.5 } });
    tx.run("clip.remove", { clip: "clip-3" });
    tx.run("track.add", { name: "Camera" });
  });
  const after = store.doc;
  const afterJson = JSON.stringify(after);
  expect(afterJson).not.toBe(beforeJson);
  expect(store.history.undo.at(-1)).toBe("Agent: rough cut");

  store.undo();
  expect(store.doc).toEqual(before);
  expect(JSON.stringify(store.doc)).toBe(beforeJson);

  store.redo();
  expect(JSON.stringify(store.doc)).toBe(afterJson);

  while (store.canUndo) store.undo();
  expect(JSON.stringify(store.doc)).toBe(JSON.stringify(setup().initial));
});

test("a failing command or an invalid result applies nothing", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Screen" }).result;
  const clip = store.run<string>("clip.add", { type: "video", track, start: 0, duration: 100 }).result;
  const before = store.doc;

  expect(() =>
    store.transaction("half done", (tx) => {
      tx.run("clip.set", { clip, start: 10 });
      tx.run("clip.set", { clip: "missing" });
    }),
  ).toThrow("no clip missing");
  expect(() => store.run("clip.set", { clip, props: { opacity: 2 } })).toThrow("props.look.opacity");
  expect(() => store.run("clip.add", { type: "video", track, start: 50, duration: 100 })).toThrow("overlaps");
  expect(() => store.run("clip.set", { clip, start: "soon" })).toThrow("clip.set: start");

  expect(store.doc).toBe(before);
  expect(store.history.undo).toEqual(["track.add", "clip.add"]);
});

test("dry run returns the patch and a readable diff without applying", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Screen" }).result;
  const clip = store.run<string>("clip.add", { type: "video", track, start: 0, duration: 100 }).result;
  const before = store.doc;

  const r = store.run("clip.set", { clip, start: 300 }, { dryRun: true });
  expect(r.dryRun).toBe(true);
  expect(r.diff).toEqual(["set tracks/0/clips/0/start: 0 -> 300"]);
  expect(store.doc).toBe(before);
  expect(store.canRedo).toBe(false);
});

test("⌘Z undoes the user's own step under an agent's, and the agent's undo takes only its own; redone, the document is as it was, exactly", () => {
  const { store, initial } = setup();
  const screen = store.run<string>("track.add", { name: "Screen" }).result;
  const camera = store.run<string>("track.add", { name: "Camera" }, { author: "claude-code" }).result;
  const mine = store.run<string>("clip.add", { type: "video", track: screen, start: 0, duration: 100 }).result;
  store.run("clip.add", { type: "video", track: camera, start: 0, duration: 50 }, { author: "claude-code" });
  const both = JSON.stringify(store.doc);

  expect(store.undo()?.label).toBe("clip.add");
  const clips = () => store.doc.tracks.flatMap((t) => t.clips.map((c) => c.id));
  expect(clips()).not.toContain(mine);
  expect(clips()).toHaveLength(1);
  expect(store.undo(authorIs("claude-code"))?.label).toBe("clip.add");
  expect(clips()).toHaveLength(0);
  expect(store.undo(authorIs("someone-else"))).toBeUndefined();

  store.redo();
  store.redo(authorIs("claude-code"));
  expect(JSON.stringify(store.doc)).toBe(both);
  store.undo(authorIs("claude-code"));
  store.undo(authorIs("claude-code"));
  store.undo();
  store.undo();
  expect(JSON.stringify(store.doc)).toBe(JSON.stringify(initial));
  expect(store.steps.redo.map((s) => s.author)).toEqual([undefined, undefined, "claude-code", "claude-code"]);
});

test("undoing out of turn is refused when someone else's later step changed the same clip, saying whose; nothing changes", () => {
  const { store } = setup();
  const named = new ProjectStore(store.registry, store.doc, { authorName: (a) => (a === "claude-code" ? "Claude Code" : (a ?? "you")) });
  const track = named.run<string>("track.add", { name: "Screen" }).result;
  const clip = named.run<string>("clip.add", { type: "video", track, start: 0, duration: 100 }).result;
  named.run("clip.set", { clip, start: 10 });
  named.run("clip.set", { clip, props: { opacity: 0.5 } }, { author: "claude-code" });
  const before = named.doc;
  expect(() => named.undo()).toThrow(new UndoBlocked("Claude Code changed this clip since: undo Claude Code's change first", "claude-code"));
  expect(named.doc).toBe(before);
  // Once the agent's change is undone, the user's goes.
  named.undo(anyAgent);
  named.undo();
  expect(named.doc.tracks[0]!.clips[0]!.start).toBe(0);
});

test("a removed clip undone under an agent's step comes back in its place; the user's redo survives the agent's change, and the user's own change ends it", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Screen" }).result;
  const other = store.run<string>("track.add", { name: "Camera" }).result;
  const ids = [0, 200, 400].map((start) => store.run<string>("clip.add", { type: "video", track, start, duration: 100 }).result);
  const before = JSON.stringify(store.doc.tracks[0]!.clips);
  store.run("clip.remove", { clip: ids[1] });
  store.run("clip.add", { type: "video", track: other, start: 0, duration: 50 }, { author: "codex" });
  store.undo();
  expect(JSON.stringify(store.doc.tracks[0]!.clips)).toBe(before);
  expect(store.doc.tracks[1]!.clips).toHaveLength(1);

  store.run("clip.add", { type: "video", track: other, start: 100, duration: 50 }, { author: "codex" });
  expect(store.canRedo).toBe(true);
  store.redo();
  expect(store.doc.tracks[0]!.clips.map((c) => c.id)).toEqual([ids[0]!, ids[2]!]);
  store.undo();
  store.run("clip.set", { clip: ids[0]!, start: 10 });
  expect(store.canRedo).toBe(false);
});
