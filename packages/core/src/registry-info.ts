import { z } from "zod";
import { jsonSchemaOf, SESSION_COMMANDS, type FeatureRegistry } from "@beacon/model";
import type { CommandInfo, QueryInfo, SchemaInfo } from "./api";

export const UI_STATE: { id: string; description: string; args: z.ZodType; resource: QueryInfo["resource"]; summary?: boolean } = {
  id: "ui.state",
  description: "The editor's state: playhead, playing, selection, in/out range, visible timeline span, open panels, inspector tab, canvas zoom",
  args: z.strictObject({}),
  resource: { uri: "beacon://ui/state", name: "Editor state", mimeType: "application/json" },
};

interface RegistryInfo {
  commands: CommandInfo[];
  queries: QueryInfo[];
  schema: SchemaInfo;
}

// Each is a JSON schema per command, query and prop group, asked for by every agent's tool list: worked out once
// per registry, again only when a feature registers.
const cache = new WeakMap<FeatureRegistry, { features: number; info: RegistryInfo }>();

/** What agents are told of the registry: its commands, queries and schema. */
export function registryInfo(registry: FeatureRegistry): RegistryInfo {
  const hit = cache.get(registry);
  if (hit?.features === registry.features.size) return hit.info;
  const info = { commands: commands(registry), queries: queries(registry), schema: schema(registry) };
  cache.set(registry, { features: registry.features.size, info });
  return info;
}

function commands(r: FeatureRegistry): CommandInfo[] {
  const owner = owners(r);
  return [
    ...[...r.commands.values()].map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: owner.get(c.id) ?? "core" })),
    ...SESSION_COMMANDS.map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: "session" })),
    ...[...r.sessionCommands.values()].map((c) => ({ id: c.id, description: c.description, args: jsonSchemaOf(c.args), feature: owner.get(c.id) ?? "session" })),
    ...[...r.actions.values()].map((a) => ({ id: a.id, description: a.description, args: jsonSchemaOf(a.args), feature: owner.get(a.id) ?? "core" })),
  ];
}

function queries(r: FeatureRegistry): QueryInfo[] {
  const owner = owners(r);
  return [UI_STATE, ...r.queries.values()].map((q) => ({
    id: q.id,
    description: q.description,
    args: jsonSchemaOf(q.args),
    feature: q === UI_STATE ? "session" : (owner.get(q.id) ?? "core"),
    ...(q.resource ? { resource: q.resource } : {}),
    ...(q.summary ? { summary: true } : {}),
  }));
}

/** Command and query id → the feature that registered it; core's own are absent. */
function owners(r: FeatureRegistry): Map<string, string> {
  return new Map([...r.features.values()].flatMap((f) => [...(f.commands ?? []), ...(f.queries ?? []), ...(f.actions ?? []), ...(f.sessionCommands ?? [])].map((x) => [x.id, f.id] as const)));
}

function schema(r: FeatureRegistry): SchemaInfo {
  return {
    clipTypes: [...r.clipTypes.values()].map((t) => ({
      id: t.id,
      description: t.description,
      traits: t.traits,
      props: r.groupsFor(t.id).map((g) => g.id),
      effects: [...r.effects.values()].filter((e) => e.traits.some((x) => t.traits.includes(x))).map((e) => e.id),
      ...((g) => (g ? { nested: g.id } : {}))(r.groupsFor(t.id).find((g) => g.nested)),
    })),
    props: [...r.propGroups.values()].map((g) => ({ id: g.id, description: g.description, animatable: g.animatable ?? [], schema: jsonSchemaOf(g.schema) })),
    effects: [...r.effects.values()].map((e) => ({ id: e.id, title: e.title, description: e.description, traits: e.traits, schema: jsonSchemaOf(e.params) })),
    panelItems: r.panelItems,
  };
}
