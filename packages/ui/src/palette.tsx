import { useEffect, useMemo, useRef, useState } from "react";
import { keysLabel, type ShortcutInfo } from "@beacon/model";
import { Icon, Modal, TextInput } from "./controls";
import { replica, useView } from "./store";

export interface ActionHost {
  run(command: string, args?: unknown): void;
  undo(): void;
  redo(): void;
  openDialog(): void;
  /** One of the app's own actions (`app.export`…), as its menu item runs it. */
  app(id: string): void;
}

/** Runs an action as its key or menu item would: the app's own through the main process, the rest as commands. */
export function runAction(host: ActionHost, a: Pick<ShortcutInfo, "command" | "args">) {
  if (a.command === "app.palette") replica.palette(true);
  else if (a.command === "app.open") host.openDialog();
  else if (a.command.startsWith("app.")) host.app(a.command);
  else if (a.command === "project.undo") host.undo();
  else if (a.command === "project.redo") host.redo();
  else host.run(a.command, a.args ?? {});
}

/** Every word of the search is in the name, the description or the keys; names that start with it come first. */
export function search(shortcuts: ShortcutInfo[], query: string): ShortcutInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return shortcuts;
  const text = (s: ShortcutInfo) => `${s.name} ${s.description} ${s.keys.map(keysLabel).join(" ")}`.toLowerCase();
  const rank = (s: ShortcutInfo) => (s.name.toLowerCase().startsWith(words[0]!) ? 0 : s.name.toLowerCase().includes(words[0]!) ? 1 : 2);
  return shortcuts
    .filter((s) => words.every((w) => text(s).includes(w)))
    .map((s, i) => [s, rank(s), i] as const)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([s]) => s);
}

/** The command palette (⌘K by default): every action by name and description, with its keys; Enter runs the one chosen. */
export function Palette({ host }: { host: ActionHost }) {
  const open = useView((v) => !!v.palette);
  return open ? <PaletteUi host={host} /> : null;
}

function PaletteUi({ host }: { host: ActionHost }) {
  const all = useView((v) => v.shortcuts);
  const opened = useView((v) => !!v.opened);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Without a project only the app's own actions can run.
  const found = useMemo(() => search(opened ? all : all.filter((s) => s.command.startsWith("app.")), query).filter((s) => s.id !== "app.palette"), [all, opened, query]);
  useEffect(() => {
    setAt(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const close = () => replica.palette(false);
  const choose = (s: ShortcutInfo | undefined) => {
    if (!s) return;
    close();
    runAction(host, s);
  };
  return (
    <Modal width={600} onClose={close} onEnter={() => choose(found[at])}>
      <div className="relative" data-palette>
        <Icon name="magnifying-glass" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
        <TextInput
          autoFocus
          value={query}
          placeholder="Search actions"
          className="w-full py-2 pl-9 text-body"
          data-palette-search
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, Math.min(found.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            }
          }}
        />
      </div>
      <div ref={list} className="-mx-2 mt-3 max-h-[min(420px,60vh)] overflow-y-auto" role="listbox">
        {found.map((s, i) => (
          <div
            key={s.id}
            role="option"
            aria-selected={i === at}
            data-index={i}
            data-action={s.id}
            className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ${i === at ? "bg-accent-wash" : "hover:bg-item-hover"}`}
            onPointerMove={() => i !== at && setAt(i)}
            onClick={() => choose(s)}
          >
            <div className="min-w-0 flex-1">
              <div className={`truncate ${i === at ? "text-text-strong" : "text-text"}`}>{s.name}</div>
              {s.description && <div className="truncate text-caption text-text-faint">{s.description}</div>}
            </div>
            {s.keys[0] && <kbd className="shrink-0 rounded-sm bg-chip px-1.5 py-0.5 font-sans text-label text-text-muted">{keysLabel(s.keys[0])}</kbd>}
          </div>
        ))}
        {!found.length && <div className="px-2 py-6 text-center text-text-faint">No action matches “{query}”</div>}
      </div>
    </Modal>
  );
}
