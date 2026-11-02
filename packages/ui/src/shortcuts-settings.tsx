import { useState } from "react";
import { chordId, keysClash, keysLabel, keysOfEvent, LEADER_ACTION, leaderClash, leaderOf, type Keys, type ShortcutInfo } from "@beacon/model";
import { Button, Icon, TextInput } from "./controls";
import { useView } from "./store";
import { searchByName } from "./search";

export interface ShortcutsHost {
  shortcutSet(action: string, keys: Keys[], replace?: boolean): void;
  shortcutReset(action?: string): void;
}

/** A key pressed while recording that another action has: replace it there, or not. */
interface Clash {
  action: string;
  keys: Keys;
  owner: ShortcutInfo;
}

const search = (shortcuts: ShortcutInfo[], query: string) => searchByName(shortcuts, query, (s) => s.name, (s) => `${s.name} ${s.description} ${s.keys.map(keysLabel).join(" ")}`);

/**
 * Settings › Shortcuts: every action with its keys, searchable. Clicking an action's keys and pressing new ones
 * rebinds it (Escape stops); a key another action has asks first. Saved app-wide over the defaults.
 */
export function ShortcutsSettings({ host }: { host: ShortcutsHost }) {
  const shortcuts = useView((v) => v.shortcuts);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string>();
  const [clash, setClash] = useState<Clash>();
  /** The keys of a sequence pressed so far while recording (; then…). */
  const [steps, setSteps] = useState<Keys[]>([]);
  const shown = search(shortcuts, query);
  const changed = shortcuts.some((s) => !s.standard);
  /** The leader key: always the start of a sequence, never a shortcut alone. */
  const leader = leaderOf(shortcuts);
  const pressed = (s: ShortcutInfo, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Focus goes back to the row, inside the dialog, so Escape still closes it.
    const row = e.currentTarget.closest("[data-shortcut]");
    const done = () => {
      setRecording(undefined);
      setSteps([]);
      setTimeout(() => (row?.querySelector("[data-shortcut-keys]") as HTMLElement | null)?.focus());
    };
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return done();
    const step = keysOfEvent(e);
    if (!step) return;
    const all = [...steps, step];
    const keys: Keys = { ...all[0]!, ...(all.length > 1 ? { then: all.slice(1) } : {}) };
    // The leader, or keys that begin another sequence: the next key is part of this one. The leader itself is one key.
    const id = chordId(keys);
    if (s.id !== LEADER_ACTION && all.length < 3 && (id === chordId(leader) || shortcuts.some((o) => o.keys.some((k) => chordId(k)?.startsWith(`${id} `))))) return setSteps(all);
    done();
    const owner = shortcuts.find((o) => o.id !== s.id && o.keys.some((k) => (o.id === LEADER_ACTION || s.id === LEADER_ACTION ? leaderClash : keysClash)(k, keys)));
    if (owner) setClash({ action: s.id, keys, owner });
    else host.shortcutSet(s.id, [keys]);
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-shortcuts>
      <div className="relative">
        <Icon name="magnifying-glass" size={14} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-muted" />
        <TextInput value={query} placeholder="Search actions or keys" className="w-full pl-7" data-shortcuts-search onChange={(e) => setQuery(e.target.value)} />
      </div>
      <p className="text-caption text-text-faint">Click an action's keys, then press the new ones (Escape stops); the Leader Key ({keysLabel(leader)}) starts a sequence ({keysLabel(leader)} then a key, as in vi). Menus and the command palette show them.</p>
      {clash && (
        <div className="flex items-center gap-2 rounded-md bg-chip px-3 py-2 text-caption text-warning" data-shortcut-clash>
          <span className="flex-1">
            {keysLabel(clash.keys)} is {clash.owner.name}'s shortcut{clash.owner.fixed ? `, which can't change (${clash.owner.fixed})` : ". Use it here instead?"}
          </span>
          {!clash.owner.fixed && (
            <Button
              look="primary"
              onClick={() => {
                host.shortcutSet(clash.action, [clash.keys], true);
                setClash(undefined);
              }}
              data-clash-replace
            >
              Replace
            </Button>
          )}
          <Button onClick={() => setClash(undefined)}>Cancel</Button>
        </div>
      )}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto">
        {shown.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-item-hover" title={s.description} data-shortcut={s.id}>
            <span className="min-w-0 flex-1 truncate text-text">{s.name}</span>
            {!s.standard && (
              <button className="text-caption text-text-faint hover:text-text-strong" title="Back to the default keys" onClick={() => host.shortcutReset(s.id)} data-shortcut-reset>
                Reset
              </button>
            )}
            {recording === s.id ? (
              <span tabIndex={0} ref={(el) => el?.focus()} onKeyDown={(e) => pressed(s, e)} onBlur={() => (setRecording(undefined), setSteps([]))} className="flex w-36 items-center rounded-sm bg-accent-wash py-0.5 pr-1 pl-2 text-label text-accent outline-none" data-recording>
                <span className="flex-1 text-center" data-recording-steps>{steps.length ? `${steps.map(keysLabel).join(" ")} …` : "Press keys…"}</span>
                {s.keys.length > 0 && s.id !== LEADER_ACTION && (
                  <button
                    title="No shortcut"
                    aria-label="No shortcut"
                    className="text-text-muted hover:text-text-strong"
                    // Keeps focus on the recorder until the click lands.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => (setRecording(undefined), host.shortcutSet(s.id, []))}
                    data-shortcut-clear
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            ) : (
              <button
                disabled={!!s.fixed}
                title={s.fixed ? `Can't change: ${s.fixed}` : "Click, then press the new keys"}
                className="flex w-36 flex-wrap justify-end gap-1 rounded-sm px-1 py-0.5 hover:bg-chip disabled:hover:bg-transparent"
                onClick={() => (setClash(undefined), setRecording(s.id))}
                data-shortcut-keys
              >
                {s.keys.length ? s.keys.map((k) => <kbd key={chordId(k)} className="rounded-sm bg-chip px-1.5 font-sans text-label text-text-muted">{keysLabel(k)}</kbd>) : <span className="text-label text-text-disabled">None</span>}
              </button>
            )}
          </div>
        ))}
      </div>
      {changed && (
        <div className="flex justify-start">
          <Button onClick={() => host.shortcutReset()} data-shortcuts-reset-all>
            Reset All to Defaults
          </Button>
        </div>
      )}
    </div>
  );
}
