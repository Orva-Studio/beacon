import { expect, test } from "bun:test";
import { anyAgent, authorIs, ProjectStore, TICKS_PER_SECOND, UndoBlocked } from "../src";
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

  const r = store.run("clip.set", { clip, start: TICKS_PER_SECOND * 2 }, { dryRun: true });
  expect(r.dryRun).toBe(true);
  expect(r.diff).toEqual([`set clip ${clip}: start 0 -> 2`]);
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

test("the diff names what a removal took, not every clip it shifted", () => {
  const { store } = setup();
  const first = store.run<string>("track.add", { name: "A" }).result;
  const second = store.run<string>("track.add", { name: "B" }).result;
  const gone = store.run<string>("clip.add", { type: "video", track: first, start: 0, duration: 5 }).result;
  for (const t of [0, 10, 20]) store.run("clip.add", { type: "video", track: second, start: t, duration: 5 });
  const r = store.run("track.remove", { track: first });
  expect(r.diff).toEqual([`remove track ${first}`, `remove clip ${gone} (was video 0-5s on ${first})`]);
});

test("the diff makes one line of many clips added alike", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Captions" }).result;
  const r = store.transaction("Add Captions", (tx) => {
    for (let t = 0; t < 10; t++) tx.run("clip.add", { type: "video", track, start: t * 2, duration: 2 });
  });
  expect(r.diff).toEqual([`add 10 video clips on ${track}, 0-20s`]);
});

test("an insertion before others is undone under someone else's later step, and their neighbours aren't taken as changed", () => {
  const { store } = setup();
  const a = store.run<string>("track.add", { name: "A" }).result;
  const b = store.run<string>("track.add", { name: "B", index: 0 }).result;
  const c = store.run<string>("track.add", { name: "C" }, { author: "codex" }).result;
  expect(store.doc.tracks.map((t) => t.id)).toEqual([b, a, c]);
  expect(store.undo()?.label).toBe("track.add");
  expect(store.doc.tracks.map((t) => t.id)).toEqual([a, c]);

  // A track taken out from the front shifts the rest: an agent's later change to one of them doesn't block its undo.
  store.run("track.remove", { track: a });
  store.run("track.set", { track: c, name: "C2" }, { author: "codex" });
  expect(store.undo()?.label).toBe("track.remove");
  expect(store.doc.tracks.map((t) => [t.id, t.name])).toEqual([
    [a, "A"],
    [c, "C2"],
  ]);
});

test("a redo is refused when an agent changed the same clip again in a step that merged with its earlier one", () => {
  const { store } = setup();
  const track = store.run<string>("track.add", { name: "Screen" }).result;
  const clip = store.run<string>("clip.add", { type: "video", track, start: 0, duration: 100 }).result;
  store.run("clip.set", { clip, start: 10 }, { author: "codex", coalesce: "drag" });
  store.run("clip.set", { clip, start: 20 });
  store.undo();
  store.run("clip.set", { clip, start: 30 }, { author: "codex", coalesce: "drag" });
  expect(store.steps.undo.filter((s) => s.author === "codex")).toHaveLength(1);
  expect(() => store.redo()).toThrow(UndoBlocked);
  expect(store.doc.tracks[0]!.clips[0]!.start).toBe(30);
});
