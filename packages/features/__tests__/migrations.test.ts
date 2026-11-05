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
  expect(out.features.captions).toBe(6);
  const [bottom, middle] = out.tracks;
  expect(bottom!.props!.captionStyle).toMatchObject({ anchorY: "bottom", offsetY: 80, anchorX: "center", offsetX: 0 });
  expect(bottom!.props!.captionStyle).not.toHaveProperty("position");
  expect(middle!.props!.captionStyle).toMatchObject({ anchorY: "middle", offsetY: 0 });
  expect(out.tracks.flatMap((t) => t.clips).every((c) => !("captionStyle" in c.props))).toBe(true);
});

test("captions v4 to v6: a caption track's style gains Dynamic Captions' fields at their defaults, so it draws as before", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.captions = 3;
  doc.settings.height = 1920;
  const style = { font: "Helvetica Neue", weight: 700, size: 54, color: [1, 1, 1, 1], background: [0, 0, 0, 0.75], cornerRadius: 12, anchorY: "bottom", offsetY: 80, anchorX: "center", offsetX: 0, highlight: [1, 0.84, 0.2, 1], maxWidth: 0.8, uppercase: true };
  doc.tracks = [{ id: "t1", name: "Captions", props: { captionStyle: style }, clips: [{ id: "c1", type: "caption", start: 0, duration: 10, mediaStart: 0, props: { caption: { words: [{ text: "Hi", start: 0, end: 1 }] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.captions).toBe(6);
  const s = out.tracks[0]!.props!.captionStyle as any;
  expect(s).toMatchObject({ ...style, reveal: "phrase", enter: "none", exit: "none", layout: "line", upcoming: [1, 1, 1, 0], shadow: [0, 0, 0, 0], shadowBlur: Math.round(6 * (1920 / 1080)), stretch: false, lineWords: 0, countUp: false, behind: false, shadowAngle: -Math.PI / 2 });
  // The shadow falls where it always did: straight down at 0.3 of its softness.
  expect(s.shadowDistance).toBeCloseTo(Math.round(6 * (1920 / 1080)) * 0.3, 2);
  expect(s.emphasis).toMatchObject({ decoration: "none", scale: 1, font: "" });
  expect(registry.propGroups.get("captionStyle")!.schema.safeParse(s).success).toBe(true);
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

test("broll v2: a B-roll clip's takes saved as bare asset ids become { assetId }, so the project opens (and v3 follows)", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 1;
  doc.tracks = [{ id: "t1", name: "B-roll", clips: [{ id: "c1", type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field", why: "", guide: "", research: true, takes: ["a1", "a2"] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect((out.tracks[0]!.clips[0]!.props.broll as { takes: unknown }).takes).toEqual([{ assetId: "a1" }, { assetId: "a2" }]);
});

test("broll v3: a B-roll clip's guide gives way to where its prompt comes from (Auto); its style, then None, is gone at v6", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 2;
  doc.tracks = [{ id: "t1", name: "B-roll", clips: [{ id: "c1", type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field", why: "", guide: "keep it abstract", research: true, takes: [] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect(out.tracks[0]!.clips[0]!.props.broll).toEqual({ prompt: "a field", why: "", source: "auto", manual: "", research: true, model: "", takes: [] });
});

test("broll v4: Prompt from Transcript becomes Manual, its typed prompt empty (still the words said), Auto's kept", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 3;
  doc.tracks = [{ id: "t1", name: "B-roll", clips: [{ id: "c1", type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field", why: "because", style: "none", source: "transcript", research: true, takes: [] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect(out.tracks[0]!.clips[0]!.props.broll).toEqual({ prompt: "a field", why: "because", source: "manual", manual: "", research: true, model: "", takes: [] });
});

test("broll v5: a clip saved at v4 before Manual had its own prompt gets an empty one, so the project opens", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 4;
  doc.tracks = [{ id: "t1", name: "B-roll", clips: [{ id: "c1", type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field", why: "", style: "none", source: "auto", research: true, takes: [] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect((out.tracks[0]!.clips[0]!.props.broll as { manual: string }).manual).toBe("");
});

test("broll v6: a clip's style is dropped (the look is typed in the prompt), its prompts kept; inside a group too", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 5;
  const b = (id: string) => ({ id, type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field at dusk, grainy 16mm", why: "", style: "vintage-film", source: "manual", manual: "a field", research: true, takes: [] } }, effects: [], animations: [] });
  doc.tracks = [
    { id: "t1", name: "B-roll", clips: [b("c1")] },
    { id: "t2", name: "", clips: [{ id: "g1", type: "group", start: 0, duration: 10, props: { group: { width: 1920, height: 1080, tracks: [{ id: "gt", name: "", clips: [b("c2")] }] } }, effects: [], animations: [] }] },
  ];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect(out.tracks[0]!.clips[0]!.props.broll).toEqual({ prompt: "a field at dusk, grainy 16mm", why: "", source: "manual", manual: "a field", research: true, model: "", takes: [] });
  const inner = (out.tracks[1]!.clips[0]!.props.group as { tracks: { clips: { props: { broll: object } }[] }[] }).tracks[0]!.clips[0]!;
  expect(inner.props.broll).not.toHaveProperty("style");
});

test("broll v7: a clip gets its own model, empty for Settings › AI's", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.broll = 6;
  doc.tracks = [{ id: "t1", name: "B-roll", clips: [{ id: "c1", type: "broll", start: 0, duration: 10, props: { broll: { prompt: "a field", why: "", source: "auto", manual: "", research: true, takes: [] } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.broll).toBe(7);
  expect((out.tracks[0]!.clips[0]!.props.broll as { model: string }).model).toBe("");
});

test("regions v2: a blur, pixelate or spotlight region gets a highlight's colour (yellow), so it validates", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.regions = 1;
  doc.tracks = [{ id: "t1", name: "", clips: [{ id: "c1", type: "region", start: 0, duration: 10, props: { region: { kind: "blur", width: 400, height: 200, cornerRadius: 6, intensity: 1, invert: false } }, effects: [], animations: [] }] }];
  const out = migrateProject(doc, registry);
  expect(out.features.regions).toBe(3);
  expect((out.tracks[0]!.clips[0]!.props.region as { color: number[] }).color).toEqual([1, 0.93, 0.25, 1]);
});

test("regions v3: a pixelate region, Pixelate gone, becomes a blur about as strong; a blur stays as it was", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.regions = 2;
  const region = (kind: string, intensity: number) => ({ kind, width: 400, height: 200, cornerRadius: 6, intensity, invert: false, color: [1, 0.93, 0.25, 1] });
  doc.tracks = [{ id: "t1", name: "", clips: [["c1", "pixelate", 0.33], ["c2", "blur", 2]].map(([id, kind, i], n) => ({ id, type: "region", start: n * 10, duration: 10, props: { region: region(kind as string, i as number) }, effects: [], animations: [] })) }];
  const out = migrateProject(doc, registry);
  expect(out.features.regions).toBe(3);
  const [pixelated, blurred] = out.tracks[0]!.clips.map((c) => c.props.region as { kind: string; intensity: number });
  expect(pixelated!.kind).toBe("blur");
  expect(pixelated!.intensity).toBeCloseTo(1.2375, 4);
  expect(blurred).toMatchObject({ kind: "blur", intensity: 2 });
});

test("motion v2 to v4: a motion graphics clip made before Looks, then from callouts, becomes an HTML one: its takes' pieces templates, its group a box to draw again, no background setting; inside a group too", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.motion = 1;
  const piece = { kind: "title", start: 0, end: 4, area: "full", text: "Hello there", detail: "", value: 0, prefix: "", suffix: "", items: [] };
  const motion = (id: string) => ({
    id,
    type: "motion",
    start: 0,
    duration: 10,
    props: { motion: { prompt: "", why: "", source: "manual", manual: "Hi", takes: [{ prompt: "Hi", pieces: [piece] }], shown: 0 }, group: { width: 960, height: 540, tracks: [] } },
    effects: [],
    animations: [],
  });
  const group = { id: "g1", type: "group", start: 20, duration: 10, props: { group: { width: 1920, height: 1080, tracks: [{ id: "t2", name: "", clips: [motion("c2")] }] } }, effects: [], animations: [] };
  doc.tracks = [{ id: "t1", name: "Motion graphics", clips: [motion("c1"), group] }];
  const out = migrateProject(doc, registry);
  expect(out.features.motion).toBe(4);
  const inner = (out.tracks[0]!.clips[1]!.props.group as { tracks: { clips: { props: Record<string, unknown> }[] }[] }).tracks[0]!.clips[0]!;
  for (const c of [out.tracks[0]!.clips[0]!, inner]) {
    expect(c.props.motion).toMatchObject({ look: "clean", timing: "speech", manual: "Hi" });
    expect(c.props.motion).not.toHaveProperty("backdrop");
    expect((c.props.motion as { takes: { html: string }[] }).takes[0]!.html).toContain("Hello");
    expect(c.props.group).toBeUndefined();
    expect(c.props.motionBox).toEqual({ width: 960, height: 540 });
  }
});

test("motion v4: a background set on the clip becomes the first thing in each take's HTML, drawn as before; none adds nothing", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.motion = 3;
  const motion = (id: string, backdrop: unknown, start: number) => ({
    id,
    type: "motion",
    start,
    duration: 4,
    props: { motion: { prompt: "", why: "", source: "manual", manual: "Hi", look: "clean", backdrop, timing: "speech", takes: [{ prompt: "Hi", html: "<b>Hi</b>" }, { prompt: "Yo", html: "<b>Yo</b>" }], shown: 0 }, motionBox: { width: 1920, height: 1080 } },
    effects: [],
    animations: [],
  });
  doc.tracks = [{ id: "t1", name: "Motion graphics", clips: [motion("c1", { kind: "card", color: [0, 0, 0, 0.5] }, 0), motion("c2", { kind: "none", color: [0, 0, 0, 0.6] }, 10)] }];
  const out = migrateProject(doc, registry);
  expect(out.features.motion).toBe(4);
  const [card, none] = out.tracks[0]!.clips.map((c) => c.props.motion as { takes: { html: string }[] });
  for (const t of card!.takes) expect(t.html).toMatch(/^<div style="position: absolute; inset: min\(5vw, 5vh\); border-radius: min\(3vw, 3vh\); background: rgba\(0, 0, 0, 0\.5\);[^"]*"><\/div>\n<b>/);
  expect(none!.takes.map((t) => t.html)).toEqual(["<b>Hi</b>", "<b>Yo</b>"]);
  for (const m of [card, none]) expect(m).not.toHaveProperty("backdrop");
});

test("device-frame v2: Monitor's grade becomes a Film Look on the clip at its strength, the settings it no longer has go and zoom comes in, so a project the dev app saved opens", () => {
  const registry = createRegistry();
  const clip = (id: string, effects: object[]) => ({ id, type: "screen", start: Number(id.slice(1)) * 10, duration: 10, props: {}, effects, animations: [] });
  const doc = createProject(registry) as any;
  doc.features["device-frame"] = 1;
  const look = { strength: 1, exposure: 0, warmth: 0, tint: 0, fade: 0, contrast: 1, saturation: 1, grain: 0, grainSize: 0, halation: 0, halationSize: 4, vignette: 0, splitTone: 0, shadowHue: 30, highlightHue: 210, highlightStrength: 0.5 };
  const v1 = { move: "still", screen: "sunlit", room: "teal-studio", shot: "wide", focus: "cursor", focusX: 0.48, focusY: 0.38, blur: 0.56, glow: 0.21, drift: 0.45 };
  doc.tracks = [
    {
      id: "t1",
      name: "Screen",
      clips: [
        clip("c1", [{ id: "fx-5b4f9bed", type: "device-frame", enabled: true, params: { ...v1, grade: 0.57 } }]),
        clip("c2", [{ id: "fx-00000001", type: "film-look", enabled: true, params: look }, { id: "fx-00000002", type: "device-frame", enabled: true, params: { ...v1, grade: 1 } }]),
        clip("c3", [{ id: "fx-00000003", type: "device-frame", enabled: true, params: { ...v1, grade: 0 } }]),
      ],
    },
  ];
  const out = migrateProject(doc, registry) as any;
  expect(out.features["device-frame"]).toBe(6);
  const [graded, ownLook, ungraded] = out.tracks[0].clips;
  expect(graded.effects.map((e: any) => [e.id, e.type])).toEqual([["fx-d3c71365", "film-look"], ["fx-5b4f9bed", "device-frame"]]);
  expect(graded.effects[0].params).toMatchObject({ strength: 0.57, warmth: 0.4, vignette: 0.3 });
  expect(graded.effects[1].params).toEqual({ corner: "top-left", shot: "head-on", room: "teal-studio", screen: "matte", focus: "cursor", focusX: 0.48, focusY: 0.38, blur: 0.56, glow: 0.21, pixels: 0.5, reflection: 0.5, drift: 0.45, zoom: 2 });
  // A clip with a Film Look of its own keeps it as it was; no grade adds none.
  expect(ownLook.effects.map((e: any) => e.type)).toEqual(["film-look", "device-frame"]);
  expect(ownLook.effects[0].params).toEqual(look);
  expect(ungraded.effects.map((e: any) => e.type)).toEqual(["device-frame"]);
});

test("device-frame v3: a Monitor saved at v2 gets the Shot and Room menus as v2 drew it (head on, the studio photo), its settings kept", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features["device-frame"] = 2;
  const v2 = { move: "still", screen: "glossy", focus: "cursor", focusX: 0.5, focusY: 0.5, blur: 0.56, glow: 0.21, drift: 0.45, zoom: 3.49 };
  doc.tracks = [{ id: "t1", name: "Screen", clips: [{ id: "c1", type: "screen", start: 0, duration: 10, props: {}, effects: [{ id: "fx-1", type: "device-frame", enabled: true, params: v2 }], animations: [] }] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features["device-frame"]).toBe(6);
  const { move: _, ...kept } = v2;
  expect(out.tracks[0].clips[0].effects[0].params).toEqual({ corner: "top-left", shot: "head-on", room: "teal-studio", pixels: 0.5, reflection: 0.5, ...kept });
});

test("device-frame v4: a head-on Monitor saved at v3 is close on the top-left corner, as v3 always was", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features["device-frame"] = 3;
  const v3 = { shot: "head-on", room: "none", move: "push", screen: "matte", focus: "cursor", focusX: 0.5, focusY: 0.5, blur: 0.6, glow: 0.5, drift: 0.5, zoom: 2 };
  doc.tracks = [{ id: "t1", name: "Screen", clips: [{ id: "c1", type: "screen", start: 0, duration: 10, props: {}, effects: [{ id: "fx-1", type: "device-frame", enabled: true, params: v3 }], animations: [] }] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features["device-frame"]).toBe(6);
  const { move: _, ...kept } = v3;
  expect(out.tracks[0].clips[0].effects[0].params).toEqual({ corner: "top-left", pixels: 0.5, reflection: 0.5, ...kept });
});

test("device-frame v5: Move goes from a Monitor saved at v4 (the clip's Scale and Position move the camera), its other settings kept", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features["device-frame"] = 4;
  const v4 = { shot: "edge-right", corner: "bottom-right", room: "teal-studio", move: "slide", screen: "glossy", focus: "cursor", focusX: 0.29, focusY: 0.3, blur: 0.6, glow: 0.21, drift: 0.45, zoom: 1.242 };
  doc.tracks = [{ id: "t1", name: "Screen", clips: [{ id: "c1", type: "screen", start: 0, duration: 10, props: {}, effects: [{ id: "fx-1", type: "device-frame", enabled: true, params: v4 }], animations: [] }] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features["device-frame"]).toBe(6);
  const { move: _, ...kept } = v4;
  expect(out.tracks[0].clips[0].effects[0].params).toEqual({ pixels: 0.5, reflection: 0.5, ...kept });
});

test("device-frame v6: a Monitor saved at v5 gets Pixels and Reflection at their defaults, its settings kept", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features["device-frame"] = 5;
  const v5 = { shot: "head-on", corner: "top-right", room: "none", screen: "glossy", focus: "point", focusX: 0.2, focusY: 0.7, blur: 0.4, glow: 0.3, drift: 0, zoom: 6 };
  doc.tracks = [{ id: "t1", name: "Screen", clips: [{ id: "c1", type: "screen", start: 0, duration: 10, props: {}, effects: [{ id: "fx-1", type: "device-frame", enabled: true, params: v5 }], animations: [] }] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features["device-frame"]).toBe(6);
  expect(out.tracks[0].clips[0].effects[0].params).toEqual({ ...v5, pixels: 0.5, reflection: 0.5 });
});

test("noise v2: Noise Removal, taken out, comes off the clips of a project saved with it; the clips' other effects stay", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.noise = 1;
  const nr = { id: "fx-1", type: "noise-removal", enabled: true, params: { strength: 12, learnFrom: 0, learnTo: 0 } };
  const polish = { id: "fx-2", type: "polish", enabled: true, params: { removeClicks: true, repairClipping: true, sibilance: 0.2 } };
  doc.tracks = [{ id: "t1", name: "Audio", clips: [{ id: "c1", type: "audio", start: 0, duration: 10, props: {}, effects: [nr, polish], animations: [] }] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features.noise).toBe(2);
  expect(out.tracks[0].clips[0].effects.map((e: any) => e.type)).toEqual(["polish"]);
});

test("angles v2: an Angle clip set to a side profile, the profiles gone, becomes the three-quarter view on that side, its takes kept", () => {
  const registry = createRegistry();
  const doc = createProject(registry) as any;
  doc.features.angles = 1;
  const angle = (id: string, view: string, n: number) => ({ id, type: "angle", start: n * 10, duration: 3, props: { angle: { view, move: "handheld", note: "", takes: [{ assetId: "a1" }], crop: false } }, effects: [], animations: [] });
  doc.tracks = [{ id: "t1", name: "Angles", clips: [angle("c1", "profile-left", 0), angle("c2", "profile-right", 1), angle("c3", "wide", 2)] }];
  const out = migrateProject(doc, registry) as any;
  expect(out.features.angles).toBe(2);
  expect(out.tracks[0].clips.map((c: any) => c.props.angle.view)).toEqual(["three-quarter-left", "three-quarter-right", "wide"]);
  expect(out.tracks[0].clips[0].props.angle.takes).toEqual([{ assetId: "a1" }]);
});
