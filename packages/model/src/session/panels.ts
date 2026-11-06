import { z } from "zod";
import { inspected, TOOL_PANELS, sessionCommand, type SessionCommandDef, inspectorTabs } from "./shared";

export const PANEL_COMMANDS: SessionCommandDef[] = [
  sessionCommand({
    id: "panel.show",
    description: `Show a tool panel on the left (${TOOL_PANELS.join(", ")}; null collapses it) and/or open or close the properties panel`,
    args: z.strictObject({ tool: z.enum(TOOL_PANELS).nullable().optional(), properties: z.boolean().optional() }),
    apply: (s, { tool, properties }) => {
      if (tool !== undefined) s.panels.tool = tool;
      if (properties !== undefined) s.panels.properties = properties;
    },
  }),
  sessionCommand({
    id: "inspector.tab",
    description: 'Show a tab of the properties panel: a property group id (e.g. "transform", "cursor"), "effects", "audio" or "speed"',
    args: z.strictObject({ tab: z.string().min(1) }),
    apply: (s, { tab }, { registry }) => {
      if (tab !== "effects" && tab !== "audio" && tab !== "speed" && !registry.propGroups.has(tab)) {
        throw new Error(`no property group "${tab}"; there are: ${[...registry.propGroups.keys()].join(", ")}, effects, audio, speed`);
      }
      s.inspector = tab;
      s.panels.properties = true;
    },
  }),
  sessionCommand({
    id: "inspector.step",
    description: "Show the properties panel's next tab (`by` 1) or the one before (-1), round from the last to the first",
    args: z.strictObject({ by: z.union([z.literal(1), z.literal(-1)]) }),
    apply: (s, { by }, { project, registry }) => {
      const clip = inspected(s, project);
      if (!clip) throw new Error("select a clip to step through its properties");
      const tabs = inspectorTabs(clip, registry.tabsFor(clip.type).map((g) => g.id), !!registry.clipTypes.get(clip.type)?.retimes, s.inspector);
      if (!tabs.length) return;
      const at = Math.max(0, tabs.indexOf(s.inspector));
      s.inspector = tabs[(at + by + tabs.length) % tabs.length]!;
      s.panels.properties = true;
    },
  }),
  sessionCommand({
    id: "inspector.effects",
    description: "Show the selected clip's Effects (fx) tab; with no effects on it, the Visual Effects panel to add one",
    args: z.strictObject({}),
    apply: (s, _, { project }) => {
      if (inspected(s, project)?.effects.length) {
        s.inspector = "effects";
        s.panels.properties = true;
      } else s.panels.tool = "visualEffects";
    },
  }),
  sessionCommand({
    id: "canvas.zoom",
    description:
      'Zoom the canvas preview: "fit" (⌘0, centred), a percent (100 = actual size, ⌥Z), or "in"/"out" (⌘= / ⌘-); `pan`: the canvas point (pixels from its centre, y down) to show at the view\'s centre, as the wheel and a middle-button drag set it',
    args: z.strictObject({ zoom: z.union([z.enum(["fit", "in", "out"]), z.number().min(5).max(800)]), pan: z.tuple([z.number(), z.number()]).optional() }),
    apply: (s, { zoom, pan }, ctx) => {
      if (zoom === "fit") {
        s.canvas = { ...s.canvas, zoom, pan: [0, 0] };
        return;
      }
      if (pan) s.canvas.pan = pan;
      if (typeof zoom === "number") {
        s.canvas.zoom = zoom;
        return;
      }
      const steps = [10, 25, 33, 50, 66, 75, 100, 150, 200, 300, 400];
      const current = s.canvas.zoom === "fit" ? ctx.fitPercent ?? 50 : s.canvas.zoom;
      const next = zoom === "in" ? steps.find((x) => x > current + 0.5) : steps.findLast((x) => x < current - 0.5);
      s.canvas.zoom = next ?? current;
    },
  }),
];
