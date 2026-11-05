import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodType } from "zod";
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
  type LearnedShortcut,
  chordId,
  keysClash,
  DEFAULT_LEADER,
  LEADER_ACTION,
} from "@beacon/model";
import type { AppEvent, PreferenceInfo } from "./api";
import { JsonStore, readJson, writeAtomic } from "./json-store";
import type { Secrets } from "./keychain";
import { clearedKeys, dayOf, emptyLearned, firstKeys, learnedInfo, offers, sweep, type ItemAction, type LearnedFile } from "./learned";
import { defaultKeys, KeymapFileSchema, savedLeader, setShortcut, shortcutList, swapLeader, type KeymapOverrides } from "./shortcuts";

/** Uses of a panel item kept, newest last; and how fast one counts for less (a use two weeks old counts half). */
const USES_KEPT = 20;
const USE_HALF_LIFE = 14 * 24 * 3600 * 1000;

/**
 * The app's own choices, kept as JSON files in one folder (and secrets in the Keychain): preferences, panel items' use,
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
  readonly #prefs: JsonStore<Record<string, string>, Record<string, unknown>>;
  readonly #settings: JsonStore<AppSettings, Partial<AppSettings>>;
  /** Commands' descriptions by id, for the shortcuts list; the registry doesn't change, so read once. */
  #descriptions?: Map<string, string>;

  constructor(
    readonly dir: string,
    readonly registry: FeatureRegistry,
    readonly secrets: Secrets,
    readonly emit: (e: AppEvent) => void,
  ) {
    // Values are checked one by one when read (`pref`), so one gone stale doesn't lose the others.
    this.#prefs = new JsonStore(join(dir, "preferences.json"), z.record(z.string(), z.unknown()), (saved) => (saved ?? {}) as Record<string, string>);
    this.#settings = new JsonStore(join(dir, "settings.json"), AppSettingsSchema.partial(), (saved) => (saved ? { ...DEFAULT_APP_SETTINGS, ...saved } : DEFAULT_APP_SETTINGS));
  }

  /** A preference's value: the user's choice, or its default when unset or no longer an option. */
  readonly pref = (id: string): string => this.#prefOf(this.#prefs.value, id);

  #prefOf(prefs: Record<string, string>, id: string): string {
    const def = this.registry.preferences.get(id);
    if (!def) throw new Error(`no preference "${id}"`);
    const v = prefs[id];
    return v !== undefined && (def.range ? inRange(v, def.range) : def.schema ? fits(def.schema, v) : def.options.some((o) => o.id === v)) ? v : def.default;
  }

  /** Reads the preferences again after another process (or a hand edit) may have written them, telling each that changed; returns their ids. */
  reloadPreferences(): string[] {
    const before = this.#prefs.value;
    if (!this.#prefs.reload()) return [];
    const changed = [...this.registry.preferences.keys()].filter((id) => this.#prefOf(before, id) !== this.pref(id));
    for (const id of changed) this.emit({ kind: "preference", id, value: this.pref(id) });
    return changed;
  }

  /** A JSON file of the app's own (panel items' use, settings, keys, the desktop's recent projects); undefined when missing or unreadable. */
  read(name: string): unknown {
    return readJson(join(this.dir, name));
  }

  /** Writes one atomically, so a crash never leaves it half written. */
  write(name: string, value: unknown) {
    writeAtomic(join(this.dir, name), JSON.stringify(value, null, 2));
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
    this.#prefs.write({ ...this.#prefs.value, [id]: value });
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

  /** Panel items by use (`usage.json`): those used most, and most lately, first. */
  recentItems(now = Date.now()): string[] {
    const usage = this.#usage();
    const score = (times: number[]) => times.reduce((sum, t) => sum + 0.5 ** ((now - t) / USE_HALF_LIFE), 0);
    return Object.entries(usage)
      .filter(([item]) => this.#itemKnown(item))
      .map(([item, times]) => [item, score(times)] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([item]) => item);
  }

  /** Counts a use of a panel item (from a tile, the palette or an agent): what ⌘K lists first. */
  itemUsed(item: string, now = Date.now()): string[] {
    if (!this.#itemKnown(item)) throw new Error(`"${item}" isn't an item of the panels: ${this.registry.panelItems.map((i) => i.id).join(", ")}, effect:<id>, or ai:<tool>`);
    const usage = this.#usage();
    const before = JSON.stringify(this.#offers(now));
    usage[item] = [...(usage[item] ?? []), now].slice(-USES_KEPT);
    this.write("usage.json", usage);
    const items = this.recentItems(now);
    this.emit({ kind: "usage", items });
    // A learned shortcut's own use keeps it, and counts towards losing "new".
    const learned = this.#learned();
    const mine = learned.shortcuts.find((s) => s.item === item);
    if (mine) {
      mine.uses++;
      mine.last = dayOf(now);
      this.#saveLearned(learned);
      this.emit({ kind: "shortcuts", shortcuts: this.shortcuts() });
    }
    if (mine || JSON.stringify(this.#offers(now)) !== before) this.emit({ kind: "memory", memory: this.memory(now) });
    return items;
  }

  /** The panel items a shortcut can run, by id: the features' panel items and the Visual Effects panel's effects. */
  #items(): Map<string, ItemAction> {
    const out = new Map<string, ItemAction>();
    for (const i of this.registry.panelItems) out.set(i.id, { item: i.id, name: i.label, command: i.command, args: i.args });
    for (const e of this.registry.effects.values()) if (isPanelEffect(e.traits)) out.set(`effect:${e.id}`, { item: `effect:${e.id}`, name: e.title, command: "edit.addEffect", args: { type: e.id } });
    return out;
  }

  #learned(): LearnedFile {
    const raw = this.read("learned.json") as Partial<LearnedFile> | undefined;
    return { ...emptyLearned(), ...(raw && typeof raw === "object" ? raw : {}) };
  }

  #saveLearned(file: LearnedFile) {
    this.write("learned.json", file);
  }

  /** Every key in use: Beacon's actions', those the user cleared, and the learned ones (as their leader is now). */
  #takenKeys(): Keys[] {
    // The leader key itself starts every sequence: not a key a sequence clashes with.
    const base = this.#shortcutList(this.#keymapOverrides(), false).filter((s) => s.id !== LEADER_ACTION);
    return [...base.flatMap((s) => s.keys), ...clearedKeys(base, defaultKeys), ...this.#learnedList().flatMap((s) => s.keys)];
  }

  #offers(now = Date.now()) {
    const leader = savedLeader(this.#keymapOverrides());
    const own = this.#shortcutList(this.#keymapOverrides(), false).filter((s) => s.id !== LEADER_ACTION).flatMap((s) => s.keys);
    return offers(this.#learned(), this.#usage(), this.#items(), leader, this.#takenKeys(), firstKeys(own, leader));
  }

  /** The learned shortcuts as the shortcut list has them, their keys on the leader as it is now. */
  #learnedList(): ShortcutInfo[] {
    const items = this.#items();
    const leader = savedLeader(this.#keymapOverrides());
    // One whose keys the user has since given an action of Beacon's yields to it.
    const own = this.#shortcutList(this.#keymapOverrides(), false).filter((x) => x.id !== LEADER_ACTION).flatMap((x) => x.keys);
    return this.#learned().shortcuts.flatMap((s) => {
      const action = items.get(s.item);
      const keys = swapLeader(s.keys, DEFAULT_LEADER, leader);
      return action && !own.some((k) => keysClash(k, keys)) ? [learnedInfo(s, action, keys)] : [];
    });
  }

  /** Memory's learned shortcuts: added, offered, gone for going unused; the unused ones are swept first, today counted. */
  #memoryShortcuts(now: number): MemoryState["shortcuts"] {
    const swept = sweep(this.#learned(), now);
    if (swept.removed.length || !this.#learned().days.includes(dayOf(now))) {
      this.#saveLearned(swept.file);
      if (swept.removed.length) this.emit({ kind: "shortcuts", shortcuts: this.shortcuts() });
    }
    const items = this.#items();
    const leader = savedLeader(this.#keymapOverrides());
    const shown = (item: string, keys: Keys, uses: number, at?: number): LearnedShortcut[] => {
      const action = items.get(item);
      return action ? [{ item, name: action.name, keys: swapLeader(keys, DEFAULT_LEADER, leader), uses, ...(at ? { at } : {}) }] : [];
    };
    return {
      learned: swept.file.shortcuts.flatMap((s) => shown(s.item, s.keys, s.uses, s.added)),
      offers: this.#offers(now).flatMap((o) => shown(o.item, swapLeader(o.keys, leader, DEFAULT_LEADER), o.uses)),
      removed: swept.file.removed.filter((r) => !swept.file.shortcuts.some((s) => s.item === r.item)).flatMap((r) => shown(r.item, r.keys, 0, r.at)),
    };
  }

  /** An offer added or turned down, a learned shortcut removed, or one gone for going unused put back. */
  #shortcutChange(change: Extract<MemoryChange, { shortcut: unknown }>["shortcut"], now: number) {
    const file = this.#learned();
    if ("add" in change) {
      const offer = this.#offers(now).find((o) => o.item === change.add);
      if (!offer) throw new Error(`"${change.add}" isn't offered a shortcut`);
      const leader = savedLeader(this.#keymapOverrides());
      file.shortcuts.push({ item: offer.item, keys: swapLeader(offer.keys, leader, DEFAULT_LEADER), added: now, uses: 0, last: dayOf(now) });
      delete file.declined[offer.item];
    } else if ("decline" in change) file.declined[change.decline] = now;
    else if ("remove" in change) {
      if (!file.shortcuts.some((s) => s.item === change.remove)) throw new Error(`no learned shortcut for "${change.remove}"`);
      file.shortcuts = file.shortcuts.filter((s) => s.item !== change.remove);
      file.stopped = [...new Set([...file.stopped, change.remove])];
    } else {
      const r = file.removed.findLast((x) => x.item === change.restore);
      if (!r) throw new Error(`"${change.restore}" wasn't removed`);
      // Its keys again, unless something has taken them since.
      const taken = this.#takenKeys();
      const leader = savedLeader(this.#keymapOverrides());
      if (taken.some((k) => chordId(k) === chordId(swapLeader(r.keys, DEFAULT_LEADER, leader)))) throw new Error("its keys are another shortcut's now");
      file.shortcuts.push({ item: r.item, keys: r.keys, added: now, uses: 0, last: dayOf(now) });
      file.removed = file.removed.filter((x) => x !== r);
    }
    this.#saveLearned(file);
    this.emit({ kind: "shortcuts", shortcuts: this.shortcuts() });
  }

  #usage(): Record<string, number[]> {
    const raw = this.read("usage.json");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number[]] => Array.isArray(e[1]) && e[1].every((t) => typeof t === "number")));
  }

  /** An item the panels have (one a feature lists, a Visual Effects panel effect), or an AI panel tool (the UI's own). */
  #itemKnown(item: string): boolean {
    if (/^ai:[a-z-]+$/.test(item)) return true;
    if (this.registry.panelItems.some((i) => i.id === item)) return true;
    const effect = item.startsWith("effect:") ? this.registry.effects.get(item.slice(7)) : undefined;
    return !!effect && isPanelEffect(effect.traits);
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
  memory(now = Date.now()): MemoryState {
    const file = this.#memoryFile();
    const decisions = this.decisions();
    const habits = (format: Format) => [...this.registry.features.values()].flatMap((f) => f.habits?.(decisions, format) ?? []);
    return { learning: file.learning, sentences: this.#sentences(file), proposals: file.proposals, file: this.#memoryMd, habits: { short: habits("short"), long: habits("long") }, decisions: decisions.length, shortcuts: this.#memoryShortcuts(now) };
  }

  memoryChange(change: MemoryChange, now = Date.now()): MemoryState {
    if ("shortcut" in change) {
      this.#shortcutChange(change.shortcut, now);
      const memory = this.memory(now);
      this.emit({ kind: "memory", memory });
      return memory;
    }
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
    if (JSON.stringify(sentences) !== before || !existsSync(this.#memoryMd)) writeAtomic(this.#memoryMd, memoryMarkdown(sentences));
    if (!("forget" in change)) this.write("memory.json", { learning: file.learning, proposals: file.proposals });
    const memory = this.memory();
    this.emit({ kind: "memory", memory });
    return memory;
  }

  /** Read afresh each time: another process (an agent's core) may have written them since. */
  settings(): AppSettings {
    return this.#settings.load();
  }

  /** Reads the settings again after another process (an agent's core) may have written them, telling a change. */
  reloadSettings(): AppSettings {
    const changed = this.#settings.reload();
    if (changed) this.emit({ kind: "settings", settings: this.#settings.value });
    return this.#settings.value;
  }

  setSettings(patch: SettingsPatch): AppSettings {
    // Only a folder being chosen must exist: one gone since (an unplugged drive) mustn't stop other changes being saved.
    if (typeof patch.snapshotFolder === "string" && !existsSync(patch.snapshotFolder)) throw new Error(`${patch.snapshotFolder} doesn't exist`);
    const next = AppSettingsSchema.safeParse(withPatch(this.settings(), patch));
    if (!next.success) throw new Error(`settings: ${formatIssues(next.error)}`);
    this.#settings.write(next.data);
    this.emit({ kind: "settings", settings: next.data });
    return next.data;
  }

  #keymapOverrides(): KeymapOverrides {
    const saved = KeymapFileSchema.safeParse(this.read("keymap.json"));
    return saved.success ? saved.data.overrides : {};
  }

  #shortcutList(overrides: KeymapOverrides, learned = true): ShortcutInfo[] {
    this.#descriptions ??= new Map(
      [...this.registry.commands.values(), ...SESSION_COMMANDS, ...this.registry.sessionCommands.values(), ...this.registry.actions.values()].map((c) => [c.id, c.description]),
    );
    const described = this.#descriptions;
    const own = shortcutList(overrides, (command) => described.get(command));
    return learned ? [...own, ...this.#learnedList()] : own;
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
