import { expect, test } from "bun:test";
import { createProject, migrateProject } from "@beacon/model";
import { createRegistry } from "../src";

test("border v2: a video's Border effect becomes its border property; an annotation's is dropped; the rest is kept", () => {
  const registry = createRegistry();
  const fx = (type: string, params: object, enabled = true) => ({ id: `fx-${type}`, type, enabled, params });
  const clip = (id: string, type: string, effects: object[]) => ({ id, type, start: Number(id.slice(1)) * 10, duration: 10, props: {}, effects, animations: [] });
  const doc = createProject(registry) as any;
  doc.features.border = 1;
  doc.tracks = [
    {
      id: "t1",
      name: "Camera",
      clips: [
        clip("c1", "video", [fx("round-corners", { radius: 20, topLeft: true, topRight: true, bottomRight: true, bottomLeft: true }), fx("border", { thickness: 12, color: [1, 0, 0, 1] })]),
        clip("c2", "callout", [fx("border", { thickness: 4, color: [1, 1, 1, 1] })]),
        clip("c3", "image", [fx("border", { thickness: 6, color: [0, 0, 1, 1] }, false)]),
      ],
    },
  ];
  const out = migrateProject(doc, registry);
  const [video, callout, image] = out.tracks[0]!.clips;
  expect(out.features.border).toBe(2);
  expect(video!.props.border).toEqual({ thickness: 12, color: [1, 0, 0, 1] });
  expect(video!.effects.map((e) => e.type)).toEqual(["round-corners"]);
  expect(callout!.effects).toEqual([]);
  expect(callout!.props.border).toBeUndefined();
  // A disabled Border showed nothing: the image keeps no border.
  expect(image!.effects).toEqual([]);
  expect(image!.props.border).toBeUndefined();
});

test("captions v2 then v3: a vertical position and margin become anchors with offsets, kept once on the track", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.captions = 1;
  const style = (position: string) => ({ font: "Helvetica Neue", weight: 700, size: 54, color: [1, 1, 1, 1], background: [0, 0, 0, 0.75], cornerRadius: 12, position, margin: 80, highlight: [1, 0.84, 0.2, 1], maxWidth: 0.8, uppercase: false });
  const caption = (id: string, start: number, position: string) => ({ id, type: "caption", start, duration: 10, mediaStart: start, props: { caption: { words: [{ text: "Hi", start: 0, end: 1 }] }, captionStyle: style(position) }, effects: [], animations: [] });
  doc.tracks = [
    { id: "t1", name: "Captions", clips: [caption("c1", 0, "bottom"), caption("c2", 20, "bottom")] },
    { id: "t2", name: "More", clips: [caption("c3", 0, "middle")] },
  ];
  const out = migrateProject(doc, registry);
  expect(out.features.captions).toBe(3);
  const [bottom, middle] = out.tracks;
  expect(bottom!.props!.captionStyle).toMatchObject({ anchorY: "bottom", offsetY: 80, anchorX: "center", offsetX: 0 });
  expect(bottom!.props!.captionStyle).not.toHaveProperty("position");
  expect(middle!.props!.captionStyle).toMatchObject({ anchorY: "middle", offsetY: 0 });
  expect(out.tracks.flatMap((t) => t.clips).every((c) => !("captionStyle" in c.props))).toBe(true);
});

test("transform v2: every transform gets flat tilts, a clip inside a group's tracks too", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.transform = 1;
  const flat = { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
  const image = (id: string) => ({ id, type: "callout", start: 0, duration: 10, props: { transform: { ...flat } }, effects: [], animations: [] });
  const group = { id: "g1", type: "group", start: 0, duration: 10, mediaStart: 0, props: { transform: { ...flat }, group: { width: 1920, height: 1080, tracks: [{ id: "t2", name: "Inner", clips: [image("c2")] }] } }, effects: [], animations: [] };
  doc.tracks = [{ id: "t1", name: "Outer", clips: [group] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features.transform).toBe(2);
  const outer = out.tracks[0].clips[0];
  expect(outer.props.transform).toEqual({ ...flat, rotationX: 0, rotationY: 0 });
  expect(outer.props.group.tracks[0].clips[0].props.transform).toEqual({ ...flat, rotationX: 0, rotationY: 0 });
});

test("media v2: every clip's audio gets muted off, inside a group too; clips without audio props are left alone", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.media = 1;
  const audio = (id: string) => ({ id, type: "audio", start: 0, duration: 10, props: { audio: { gain: 1, volume: 0.5, normalize: false } }, effects: [], animations: [] });
  const group = { id: "g1", type: "group", start: 10, duration: 10, mediaStart: 0, props: { group: { width: 1920, height: 1080, tracks: [{ id: "t2", name: "Inner", clips: [audio("a2")] }] } }, effects: [], animations: [] };
  const callout = { id: "c1", type: "callout", start: 20, duration: 5, props: {}, effects: [], animations: [] };
  doc.tracks = [{ id: "t1", name: "Audio", clips: [audio("a1"), group, callout] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features.media).toBe(2);
  expect(out.tracks[0].clips[0].props.audio).toEqual({ gain: 1, volume: 0.5, normalize: false, muted: false });
  expect(out.tracks[0].clips[1].props.group.tracks[0].clips[0].props.audio.muted).toBe(false);
  expect(out.tracks[0].clips[2].props.audio).toBeUndefined();
});
