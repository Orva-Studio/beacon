import type { BeaconCore, CoreEvent } from "@beacon/core";
import type { Project } from "@beacon/model";
import type { Init, SettingsSheet, SettingsTab } from "./rpc";

/**
 * What the main process tells the window, built the same way by the app and by the UI harness (which stands in
 * for it), so the two can't drift. Only core's types are imported: this runs in those processes, not the page.
 */

type Core = Pick<BeaconCore, "schema" | "shortcuts" | "favorites" | "preferences" | "settings" | "resources" | "secrets">;

/** The window's init payload, but for what only the app knows (the open project, recent projects, its socket). */
export async function initPayload(core: Core): Promise<Omit<Init, "opened" | "recent" | "socket" | "keyLog">> {
  const schema = core.schema();
  return {
    shortcuts: await core.shortcuts(),
    propGroups: schema.props.map((p) => ({ id: p.id, description: p.description, defaults: p.defaults })),
    effects: schema.effects,
    panelItems: schema.panelItems,
    clipTypes: Object.fromEntries(schema.clipTypes.map((c) => [c.id, c.traits])),
    nested: Object.fromEntries(schema.clipTypes.flatMap((c) => (c.nested ? [[c.id, c.nested]] : []))),
    favorites: await core.favorites(),
    preferences: await core.preferences(),
  };
}

/** The app-wide changes the window follows as they are: favourites and preferences. (Settings and keys are applied by the main process first.) */
export async function appWideMessage(core: Pick<Core, "preferences">, e: CoreEvent): Promise<{ type: "favorites"; data: { items: string[] } } | { type: "preferences"; data: Init["preferences"] } | undefined> {
  if (e.kind === "favorites") return { type: "favorites", data: { items: e.items } };
  if (e.kind === "preference") return { type: "preferences", data: await core.preferences() };
  return undefined;
}

/** The Export dialog's canvas line: size and frame rate (to two decimals). */
export const exportCanvas = ({ width, height, fps }: Project["settings"]) => ({ width, height, fps: Math.round((fps.num / fps.den) * 100) / 100 });

/** Settings as it opens: the app settings, the tab, and what General's transcript and download choices need. */
export async function settingsSheet(core: Core, extra: { tab?: SettingsTab; devices?: SettingsSheet["devices"] } = {}): Promise<SettingsSheet> {
  return { ...(await core.settings()), ...(extra.tab ? { tab: extra.tab } : {}), ...(extra.devices ? { devices: extra.devices } : {}), resources: await core.resources(), preferences: await core.preferences(), secrets: await core.secrets() };
}
