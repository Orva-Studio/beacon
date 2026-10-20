import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importCmproj } from "@beacon/camtasia";
import { copyClips, createProject, projectDuration, ProjectStore, ticksToSeconds, type Clip } from "@beacon/model";
import { createRegistry } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const AI_SLOP = join(FIXTURES, "project.cmproj");

test.skipIf(!existsSync(AI_SLOP))("editing a real project validates, and undo restores it exactly", async () => {
  const registry = createRegistry();
  const { project } = await importCmproj(AI_SLOP, registry);
  const store = new ProjectStore(registry, project);
  const before = JSON.stringify(store.doc);
  const length = ticksToSeconds(projectDuration(store.doc));
  const screen = store.doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "screen" && ticksToSeconds(c.duration) > 4)!;
  const mid = ticksToSeconds(screen.start + screen.duration / 2);

  // Media Bin → timeline, placed as importing places it: linked, starting together.
  let placed: string[] = [];
  store.transaction("Add Media", (tx) => {
    tx.run("asset.rename", { asset: screen.assetId!, name: "Take 1" });
    placed = tx.run<string[]>("asset.place", { asset: screen.assetId!, time: length + 5 });
  });
  const clips = store.doc.tracks.flatMap((t) => t.clips).filter((c) => placed.includes(c.id));
  expect(clips.length).toBeGreaterThan(1);
  // The camera and audio are linked; the screen is placed apart from them.
  const av = clips.filter((c) => c.type !== "screen");
  expect(new Set(av.map((c) => c.linkId)).size).toBe(1);
  expect(av[0]!.linkId).toBeDefined();
  expect(clips.filter((c) => c.type === "screen").every((c) => c.linkId === undefined)).toBe(true);
  expect(new Set(clips.map((c) => c.start)).size).toBe(1);
  store.undo();
  expect(JSON.stringify(store.doc)).toBe(before);

  store.transaction("Agent: rough cut", (tx) => {
    tx.run("zoom.to", { clip: screen.id, at: mid - 1.5, rect: { x: 0, y: 0, width: 960, height: 540 }, until: mid - 1 });
    tx.run("timeline.rippleDelete", { ranges: [{ start: 1, end: 2.5 }, { start: mid - 0.5, end: mid + 0.5 }, { start: length - 3, end: length - 1 }] });
    tx.run("clip.split", { at: 10 });
    tx.run("marker.add", { time: 5, name: "check" });
  });
  expect(ticksToSeconds(projectDuration(store.doc))).toBeCloseTo(length - 4.5, 1);

  store.undo();
  expect(JSON.stringify(store.doc)).toBe(before);
});

test.skipIf(!existsSync(AI_SLOP))("timeline edits from the editor keep tracks in sync and undo exactly", async () => {
  const registry = createRegistry();
  const { project } = await importCmproj(AI_SLOP, registry);
  const store = new ProjectStore(registry, project);
  const before = JSON.stringify(store.doc);
  const length = ticksToSeconds(projectDuration(store.doc));
  const screen = store.doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "screen" && ticksToSeconds(c.duration) > 4)!;
  const mid = ticksToSeconds(screen.start + screen.duration / 2);
  const board = copyClips(store.doc, { clips: [screen.id] }, registry)!;

  store.transaction("Edit", (tx) => {
    tx.run("timeline.insertSpace", { at: mid, duration: 2 });
    // Closing part of that gap again, then a gap on one track only, opened and closed.
    tx.run("timeline.removeSpace", { at: mid + 2, duration: 1 });
    expect(() => tx.run("timeline.removeSpace", { at: mid + 1, duration: 2 })).toThrow("only empty time can be closed");
    const one = store.doc.tracks.find((t) => t.clips.some((c) => c.id === screen.id))!.id;
    tx.run("timeline.insertSpace", { at: mid + 1, duration: 1, track: one });
    tx.run("timeline.removeSpace", { at: mid + 2, duration: 1, track: one });
    tx.run("timeline.insertSpace", { at: mid + 1, duration: 1 });
    const pasted = tx.run<string[]>("clip.paste", { clipboard: board, at: length + 2 });
    tx.run("clip.remove", { clips: pasted, ripple: true });
    tx.run("timeline.deleteRanges", { ranges: [{ start: mid, end: mid + 2 }] });
    tx.run("clip.trim", { clip: screen.id, end: ticksToSeconds(screen.start + screen.duration) - 1, ripple: true });
    tx.run("clip.extendFrame", { clip: screen.id, duration: 1, ripple: true });
    const track = store.doc.tracks.find((t) => t.clips.some((c) => c.id === screen.id))!;
    tx.run("track.set", { track: track.id, magnetic: true });
  });
  expect(ticksToSeconds(projectDuration(store.doc))).toBeGreaterThan(length - 0.1);
  const magnetic = store.doc.tracks.find((t) => t.magnetic)!;
  let at = 0;
  for (const c of [...magnetic.clips].sort((a, b) => a.start - b.start)) {
    expect(c.start).toBe(at);
    at += c.duration;
  }

  store.undo();
  expect(JSON.stringify(store.doc)).toBe(before);
});

test.skipIf(!existsSync(AI_SLOP))("a drag's changes are one undo step that restores the project exactly", async () => {
  const registry = createRegistry();
  const { project } = await importCmproj(AI_SLOP, registry);
  const store = new ProjectStore(registry, project);
  const before = JSON.stringify(store.doc);
  const screen = store.doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "screen")!;
  for (const x of [10, 20, 30]) store.run("clip.set", { clip: screen.id, props: { transform: { x } } }, { coalesce: "drag-1" });
  const dragged = JSON.stringify(store.doc);
  store.run("clip.set", { clip: screen.id, props: { transform: { y: 5 } } }, { coalesce: "drag-2" });
  expect(store.history.undo.length).toBe(2);

  store.undo();
  expect(JSON.stringify(store.doc)).toBe(dragged);
  store.undo();
  expect(JSON.stringify(store.doc)).toBe(before);
  store.redo();
  expect(JSON.stringify(store.doc)).toBe(dragged);
});

test.skipIf(!existsSync(AI_SLOP))("groups and stitched media come apart as they went in, paste into other projects and undo exactly", async () => {
  const registry = createRegistry();
  const { project } = await importCmproj(AI_SLOP, registry);
  const store = new ProjectStore(registry, project);
  const before = JSON.stringify(store.doc);
  const clips = () => store.doc.tracks.flatMap((t) => t.clips);
  // A screen recording with cursor effects, as the house style has them.
  const screen = clips().find((c) => c.type === "screen" && c.effects.some((e) => e.type.startsWith("cursor")))!;
  const cursorFx = screen.effects.filter((e) => e.type.startsWith("cursor")).map((e) => e.type);
  const mid = ticksToSeconds(screen.start + screen.duration / 2);
  const look = (c: Clip) => JSON.stringify(c.props.transform ?? {});

  store.transaction("Edit", (tx) => {
    const [right] = tx.run<string[]>("clip.split", { at: mid, clips: [screen.id], linked: false });
    const stitched = tx.run<string>("clip.stitch", { clips: [screen.id, right!] });
    expect(tx.run<string[]>("clip.unstitch", { clip: stitched })).toHaveLength(2);
  });
  const pieces = clips().filter((c) => c.type === "screen" && c.start >= screen.start && c.start < screen.start + screen.duration);
  expect(pieces).toHaveLength(2);
  for (const p of pieces) expect(p.effects.map((e) => e.type).filter((t) => t.startsWith("cursor")).sort()).toEqual([...cursorFx].sort());
  expect(look(pieces[0]!)).toBe(look(screen));

  const visual = clips().filter((c) => c.type !== "audio" && c.type !== "group").slice(0, 2);
  const group = store.run<string>("clip.group", { clips: visual.map((c) => c.id) }).result;
  // Cuts through a group: the right-hand piece's inner clips need ids of their own.
  const g = clips().find((c) => c.id === group)!;
  const gm = ticksToSeconds(g.start + g.duration / 2);
  store.run("clip.split", { at: gm, clips: [group], linked: false });
  store.undo();
  store.run("timeline.rippleDelete", { ranges: [{ start: gm - 0.5, end: gm + 0.5 }] });
  store.undo();
  const board = copyClips(store.doc, { clips: [group] }, registry)!;
  const other = new ProjectStore(registry, createProject(registry, {}));
  const [pasted] = other.run<string[]>("clip.paste", { clipboard: board, at: 0 }).result;
  expect(other.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === pasted)?.type).toBe("group");

  const out = store.run<string[]>("clip.ungroup", { clip: group }).result;
  expect(out.sort()).toEqual(visual.map((c) => c.id).sort());
  for (const c of visual) expect(look(clips().find((x) => x.id === c.id)!)).toBe(JSON.stringify({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1, ...(c.props.transform as object) }));

  while (store.canUndo) store.undo();
  expect(JSON.stringify(store.doc)).toBe(before);
});
