import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  formatIssues,
  isPanelEffect,
  SESSION_COMMANDS,
  withPatch,
  type AppSettings,
  type FeatureRegistry,
  type Keys,
  type SettingsPatch,
  type ShortcutInfo,
} from "@beacon/model";
import type { AppEvent, PreferenceInfo } from "./api";
import type { Secrets } from "./keychain";
import { KeymapFileSchema, setShortcut, shortcutList, type KeymapOverrides } from "./shortcuts";

/**
 * The app's own choices, kept as JSON files in one folder (and secrets in the Keychain): preferences, favourites,
 * settings and keys. Each change is written at once and told to `emit`, for the app's windows and agents.
 */
export class AppConfig {
  #prefs: Record<string, string>;
  /** Commands' descriptions by id, for the shortcuts list; the registry doesn't change, so read once. */
  #descriptions?: Map<string, string>;

  constructor(
    readonly dir: string,
    readonly registry: FeatureRegistry,
    readonly secrets: Secrets,
    readonly emit: (e: AppEvent) => void,
  ) {
    const prefs = this.read("preferences.json");
    this.#prefs = prefs && typeof prefs === "object" ? (prefs as Record<string, string>) : {};
    // What the file holds now: `reloadSettings` tells what differs from it.
    this.#told = this.settings();
  }

  /** A preference's value: the user's choice, or its default when unset or no longer an option. */
  readonly pref = (id: string): string => {
    const def = this.registry.preferences.get(id);
    if (!def) throw new Error(`no preference "${id}"`);
    const v = this.#prefs[id];
    return v !== undefined && def.options.some((o) => o.id === v) ? v : def.default;
  };

  /** A JSON file of the app's own (favourites, settings, keys, the desktop's recent projects); undefined when missing or unreadable. */
  read(name: string): unknown {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Writes one atomically, so a crash never leaves it half written. */
  write(name: string, value: unknown) {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  async preferences(): Promise<PreferenceInfo[]> {
    return Promise.all(
      [...this.registry.preferences.values()].map(async (def) => ({
        id: def.id,
        title: def.title,
        description: def.description,
        value: this.pref(def.id),
        options: await Promise.all(
          def.options.map(async (o) => ({
            id: o.id,
            title: o.title,
            description: o.description,
            ...(o.secret ? { secret: { id: o.secret, title: this.registry.secrets.get(o.secret)!.title, set: (await this.secrets.get(o.secret)) !== undefined } } : {}),
            ...(o.online ? { online: true } : {}),
          })),
        ),
      })),
    );
  }

  /** Sets a preference; false when it already had that value. */
  async setPreference(id: string, value: string): Promise<boolean> {
    const def = this.registry.preferences.get(id);
    if (!def) throw new Error(`no preference "${id}"; there are: ${[...this.registry.preferences.keys()].join(", ")}`);
    const option = def.options.find((o) => o.id === value);
    if (!option) throw new Error(`${def.title}: "${value}" isn't one of ${def.options.map((o) => `"${o.id}"`).join(", ")}`);
    if (option.secret && (await this.secrets.get(option.secret)) === undefined) {
      throw new Error(`${option.title} needs the ${this.registry.secrets.get(option.secret)!.title}, which only the user can add (Settings › Transcripts)`);
    }
    if (this.pref(id) === value) return false;
    this.#prefs = { ...this.#prefs, [id]: value };
    this.write("preferences.json", this.#prefs);
    this.emit({ kind: "preference", id, value });
    return true;
  }

  /** Sets or removes a secret (an API key); returns the preferences whose choice needed it, when it was removed. */
  async setSecret(id: string, value: string | null): Promise<string[]> {
    if (!this.registry.secrets.has(id)) throw new Error(`no secret "${id}"`);
    await this.secrets.set(id, value);
    if (value !== null) return [];
    return [...this.registry.preferences.values()].filter((def) => def.options.find((o) => o.id === this.pref(def.id))?.secret === id).map((def) => def.id);
  }

  favorites(): string[] {
    const items = this.read("favorites.json");
    if (Array.isArray(items)) return items.filter((i): i is string => typeof i === "string" && this.#favoriteKnown(i));
    return this.registry.favorites.filter((i) => this.#favoriteKnown(i));
  }

  /** An item the panels have: one a feature lists, or a Visual Effects panel effect. */
  #favoriteKnown(item: string): boolean {
    if (this.registry.panelItems.some((i) => i.id === item)) return true;
    const effect = item.startsWith("effect:") ? this.registry.effects.get(item.slice(7)) : undefined;
    return !!effect && isPanelEffect(effect.traits);
  }

  #saveFavorites(items: string[]): string[] {
    this.write("favorites.json", items);
    this.emit({ kind: "favorites", items });
    return items;
  }

  favoriteAdd(item: string, index?: number): string[] {
    if (!this.#favoriteKnown(item)) throw new Error(`"${item}" isn't an item of the panels: ${this.registry.panelItems.map((i) => i.id).join(", ")}, or effect:<id> as effect_add takes`);
    const items = this.favorites();
    if (items.includes(item)) return items;
    items.splice(index === undefined ? items.length : Math.max(0, Math.min(index, items.length)), 0, item);
    return this.#saveFavorites(items);
  }

  favoriteRemove(item: string): string[] {
    const items = this.favorites();
    if (!items.includes(item)) return items;
    return this.#saveFavorites(items.filter((i) => i !== item));
  }

  favoriteMove(item: string, index: number): string[] {
    const items = this.favorites();
    const from = items.indexOf(item);
    if (from < 0) throw new Error(`"${item}" isn't a favourite; there are: ${items.join(", ")}`);
    items.splice(from, 1);
    items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
    return this.#saveFavorites(items);
  }

  /** The settings last told (written here, or found changed by `reloadSettings`). */
  #told: AppSettings;

  settings(): AppSettings {
    const saved = AppSettingsSchema.partial().safeParse(this.read("settings.json"));
    return saved.success ? { ...DEFAULT_APP_SETTINGS, ...saved.data } : DEFAULT_APP_SETTINGS;
  }

  /** Reads the settings again after another process (an agent's core) may have written them, telling a change. */
  reloadSettings(): AppSettings {
    const next = this.settings();
    const changed = !Bun.deepEquals(next, this.#told);
    this.#told = next;
    if (changed) this.emit({ kind: "settings", settings: next });
    return next;
  }

  setSettings(patch: SettingsPatch): AppSettings {
    // Only a folder being chosen must exist: one gone since (an unplugged drive) mustn't stop other changes being saved.
    if (typeof patch.snapshotFolder === "string" && !existsSync(patch.snapshotFolder)) throw new Error(`${patch.snapshotFolder} doesn't exist`);
    const next = AppSettingsSchema.safeParse(withPatch(this.settings(), patch));
    if (!next.success) throw new Error(`settings: ${formatIssues(next.error)}`);
    this.write("settings.json", next.data);
    this.#told = next.data;
    this.emit({ kind: "settings", settings: next.data });
    return next.data;
  }

  #keymapOverrides(): KeymapOverrides {
    const saved = KeymapFileSchema.safeParse(this.read("keymap.json"));
    return saved.success ? saved.data.overrides : {};
  }

  #shortcutList(overrides: KeymapOverrides): ShortcutInfo[] {
    this.#descriptions ??= new Map(
      [...this.registry.commands.values(), ...SESSION_COMMANDS, ...this.registry.sessionCommands.values(), ...this.registry.actions.values()].map((c) => [c.id, c.description]),
    );
    const described = this.#descriptions;
    return shortcutList(overrides, (command) => described.get(command));
  }

  #saveKeymap(overrides: KeymapOverrides): ShortcutInfo[] {
    this.write("keymap.json", { overrides });
    const shortcuts = this.#shortcutList(overrides);
    this.emit({ kind: "shortcuts", shortcuts });
    return shortcuts;
  }

  shortcuts(): ShortcutInfo[] {
    return this.#shortcutList(this.#keymapOverrides());
  }

  shortcutSet(action: string, keys: Keys[], replace = false): ShortcutInfo[] {
    return this.#saveKeymap(setShortcut(this.#keymapOverrides(), action, keys, replace));
  }

  shortcutReset(action?: string): ShortcutInfo[] {
    if (action === undefined) return this.#saveKeymap({});
    const { [action]: _, ...rest } = this.#keymapOverrides();
    return this.#saveKeymap(rest);
  }
}
