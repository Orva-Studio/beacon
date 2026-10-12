import { expect, test } from "bun:test";
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
