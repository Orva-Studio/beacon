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
