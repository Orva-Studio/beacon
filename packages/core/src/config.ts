import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  formatIssues,
  isPanelEffect,
  SESSION_COMMANDS,
  withPatch,
  type AppSettings,
  type Decision,
  type FeatureRegistry,
  type Format,
  memoryMarkdown,
  MemoryFileSchema,
  readMemoryMarkdown,
  type MemoryChange,
  type MemoryFile,
  type MemoryState,
  type Sentence,
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
/** JSON text a schema preference accepts. */
function fits(schema: ZodType, value: string): boolean {
  try {
    return schema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

const DECISIONS_KEPT = 5000;

const inRange = (v: string, r: { min: number; max: number }) => v.trim() !== "" && Number(v) >= r.min && Number(v) <= r.max;

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
    return v !== undefined && (def.range ? inRange(v, def.range) : def.schema ? fits(def.schema, v) : def.options.some((o) => o.id === v)) ? v : def.default;
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
        ...(def.range ? { range: def.range } : {}),
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
    if (def.range) {
      if (!inRange(value, def.range)) throw new Error(`${def.title}: "${value}" isn't a number from ${def.range.min} to ${def.range.max}`);
    } else if (def.schema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${def.title}: not JSON`);
      }
      const r = def.schema.safeParse(parsed);
      if (!r.success) throw new Error(`${def.title}: ${formatIssues(r.error)}`);
    } else {
      const option = def.options.find((o) => o.id === value);
      if (!option) throw new Error(`${def.title}: "${value}" isn't one of ${def.options.map((o) => `"${o.id}"`).join(", ")}`);
      // The default can always be had: it's what removing a key falls back to, and asks for its key when it's used.
      if (option.secret && value !== def.default && (await this.secrets.get(option.secret)) === undefined) {
        throw new Error(`${option.title} needs the ${this.registry.secrets.get(option.secret)!.title}, which only the user can add in Settings`);
      }
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
    return [...this.registry.preferences.values()].filter((def) => this.pref(def.id) !== def.default && def.options.find((o) => o.id === this.pref(def.id))?.secret === id).map((def) => def.id);
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

  /** The user's review decisions (`decisions.json`), oldest first. */
  decisions(): Decision[] {
    const saved = this.read("decisions.json");
    return Array.isArray(saved) ? (saved as Decision[]) : [];
  }

  /** Adds decisions, keeping the newest `DECISIONS_KEPT`: old ones count for little by then. None while learning is off. */
  recordDecisions(decisions: Decision[]) {
    if (!decisions.length || !this.#memoryFile().learning) return;
    this.write("decisions.json", [...this.decisions(), ...decisions].slice(-DECISIONS_KEPT));
    this.emit({ kind: "memory", memory: this.memory() });
  }

  /** Takes back the decisions an undo step recorded, returning them for its redo. */
  dropDecisions(step: string): Decision[] {
    const all = this.decisions();
    const dropped = all.filter((d) => d.step === step);
    if (!dropped.length) return [];
    this.write("decisions.json", all.filter((d) => d.step !== step));
    this.emit({ kind: "memory", memory: this.memory() });
    return dropped;
  }

  /** Whether reviews learn from decisions and open with what they learned (Settings › Memory). */
  learning(): boolean {
    return this.#memoryFile().learning;
  }

  #memoryFile(): MemoryFile {
    const saved = MemoryFileSchema.safeParse(this.read("memory.json") ?? {});
    return saved.success ? saved.data : MemoryFileSchema.parse({});
  }

  get #memoryMd() {
    return join(this.dir, "memory.md");
  }

  /** `memory.md`'s sentences; before it was written, those `memory.json` kept. */
  #sentences(file: MemoryFile): Sentence[] {
    let md: string | undefined;
    try {
      md = readFileSync(this.#memoryMd, "utf8");
    } catch {}
    const list = md === undefined ? (file.sentences ?? []) : readMemoryMarkdown(md);
    return list.map((s) => ({ id: Bun.hash(`${s.format ?? ""}:${s.text}`).toString(36), text: s.text, ...(s.format ? { format: s.format } : {}) }));
  }

  /** Settings › Memory: the sentences, those proposed, and what the features learned for each format. */
  memory(): MemoryState {
    const file = this.#memoryFile();
    const decisions = this.decisions();
    const habits = (format: Format) => [...this.registry.features.values()].flatMap((f) => f.habits?.(decisions, format) ?? []);
    return { learning: file.learning, sentences: this.#sentences(file), proposals: file.proposals, file: this.#memoryMd, habits: { short: habits("short"), long: habits("long") }, decisions: decisions.length };
  }

  memoryChange(change: MemoryChange): MemoryState {
    const file = this.#memoryFile();
    let sentences = this.#sentences(file);
    const before = JSON.stringify(sentences);
    const find = <T extends { id: string }>(list: T[], id: string, what: string) => {
      const found = list.find((x) => x.id === id);
      if (!found) throw new Error(`no ${what} "${id}" in the memory`);
      return found;
    };
    const same = (text: string, format?: Format) => (x: { text: string; format?: Format }) => x.text.toLowerCase() === text.toLowerCase() && x.format === format;
    const add = (text: string, format?: Format) => void (sentences.some(same(text, format)) || sentences.push({ id: "", text, ...(format ? { format } : {}) }));
    if ("add" in change) add(change.add.text, change.add.format);
    else if ("edit" in change) {
      const s = find(sentences, change.edit.id, "sentence");
      s.text = change.edit.text;
      if (change.edit.format === null) delete s.format;
      else if (change.edit.format) s.format = change.edit.format;
    } else if ("remove" in change) sentences = sentences.filter((x) => x !== find(sentences, change.remove, "sentence"));
    else if ("propose" in change) {
      // Said already, or waiting: not twice.
      const { text, format } = change.propose;
      const said = (x: { text: string }) => x.text.toLowerCase() === text.toLowerCase();
      if (!sentences.some(said) && !file.proposals.some(said)) file.proposals.push({ id: crypto.randomUUID().slice(0, 8), text, ...(format ? { format } : {}), at: Date.now() });
    } else if ("accept" in change) {
      const p = find(file.proposals, change.accept, "proposal");
      file.proposals = file.proposals.filter((x) => x !== p);
      add(p.text, p.format);
    } else if ("dismiss" in change) file.proposals = file.proposals.filter((x) => x !== find(file.proposals, change.dismiss, "proposal"));
    else if ("learning" in change) file.learning = change.learning;
    else {
      const f = change.forget;
      const kept = f === "all" ? [] : this.decisions().filter((d) => !f.rules.includes(d.rule) || (f.format !== undefined && d.format !== f.format));
      this.write("decisions.json", kept);
    }
    // Rewritten only when its sentences change (or it isn't there yet), so a hand edit's layout stays until then.
    if (JSON.stringify(sentences) !== before || !existsSync(this.#memoryMd)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${this.#memoryMd}.tmp`, memoryMarkdown(sentences));
      renameSync(`${this.#memoryMd}.tmp`, this.#memoryMd);
    }
    if (!("forget" in change)) this.write("memory.json", { learning: file.learning, proposals: file.proposals });
    const memory = this.memory();
    this.emit({ kind: "memory", memory });
    return memory;
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
