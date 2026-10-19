import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importCmproj } from "@beacon/camtasia";
import { defineFeature, evaluate, ProjectStore, type CamtasiaContext, type CamtasiaObject, type VisualLayer } from "@beacon/model";
import { createRegistry } from "../src";

const FIXTURES = process.env.BEACON_FIXTURES ?? join(homedir(), "beacon-fixtures");
const PROJECT = join(FIXTURES, "project.cmproj");

test.skipIf(!existsSync(PROJECT))("an effect draws only while enabled, on visual content; imported effects have every param", async () => {
  const registry = createRegistry();
  const { project } = await importCmproj(PROJECT, registry);
  for (const fx of project.tracks.flatMap((t) => t.clips).flatMap((c) => c.effects)) {
    expect(Object.keys(fx.params).sort()).toEqual(Object.keys(registry.effect(fx.type).defaults()).sort());
  }
  const store = new ProjectStore(registry, project);
  const clip = store.doc.tracks.flatMap((t) => t.clips).find((c) => c.type === "screen" && !c.effects.some((fx) => fx.type === "round-corners"))!;
  const at = clip.start + Math.floor(clip.duration / 2);
  const radius = () =>
    evaluate(store.doc, registry, at)
      .layers.filter((l): l is VisualLayer => l.kind === "visual")
      .map((l) => l.radius)
      .filter(Boolean);
  const before = radius();
  const effect = store.run<string>("effect.add", { clip: clip.id, type: "round-corners", params: { radius: 37 } }).result!;
  expect(radius().length).toBe(before.length + 1);
  store.run("effect.set", { clip: clip.id, effect, enabled: false });
  expect(radius()).toEqual(before);
});

test("a Camtasia shadow that leaves parameters out gets Camtasia's defaults, for a clip's and the cursor's", () => {
  const registry = createRegistry();
  const ctx = { numbers: () => ({}) } as unknown as CamtasiaContext;
  const mappers = [...registry.features.values()].flatMap((f) => Object.entries(f.camtasia?.effects ?? {}));
  for (const name of ["DropShadow", "CursorShadow"]) {
    const map = mappers.find(([n]) => n === name)![1];
    expect(map({ parameters: {} } as CamtasiaObject, ctx)!.params).toEqual({ angle: 5.49779, offset: 10, blur: 10, opacity: 0.4, color: [0, 0, 0, 1] });
  }
});

test("a panel item naming an annotation preset no feature registers is refused at registration", () => {
  const item = { id: "annotation:arrow", label: "Arrow", title: "An arrow", command: "edit.addAnnotation", args: { preset: "arrow" } };
  expect(() => createRegistry().register(defineFeature({ id: "arrows", version: 1, panelItems: [item] }))).toThrow('names annotation preset "arrow"');
});

test("panel items: a feature may name its own preset; a repeated id, or an Annotations item without a preset, is refused; other items' presets aren't checked", () => {
  const annotation = (id: string, args: Record<string, unknown>) => ({ id, label: id, title: id, command: "edit.addAnnotation", args });
  const box = { type: "callout", title: "Add Box", props: { callout: { shape: "rectangle", width: 10, height: 10, cornerRadius: 0, fill: [0, 0, 0, 1] } } };
  expect(() => createRegistry().register(defineFeature({ id: "boxes", version: 1, annotations: { box }, panelItems: [annotation("annotation:box", { preset: "box" })] }))).not.toThrow();
  expect(() => createRegistry().register(defineFeature({ id: "twice", version: 1, annotations: { box }, panelItems: [annotation("annotation:box", { preset: "box" }), annotation("annotation:box", { preset: "box" })] }))).toThrow("already registered");
  expect(() => createRegistry().register(defineFeature({ id: "bare", version: 1, panelItems: [annotation("annotation:bare", {})] }))).toThrow("names annotation preset");
  const animation = { id: "animation:restore", label: "Restore", title: "Restore", command: "edit.addAnimation", args: { preset: "restore" } };
  expect(() => createRegistry().register(defineFeature({ id: "anim", version: 1, panelItems: [animation] }))).not.toThrow();
});
