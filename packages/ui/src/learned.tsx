import { useRef, useState } from "react";
import { keysLabel, type LearnedShortcut, type MemoryChange } from "@beacon/model";
import { Button, Toast, TrashButton } from "./controls";
import { useView } from "./store";

interface LearnedHost {
  memoryChange(change: MemoryChange): void;
}

/** The answered or closed offers and removals: shown once each while the window is open. */
const seen = new Set<string>();

/**
 * Beacon's offers of a shortcut for a panel item used often ("You often use Drop Shadow: give it : D S?"), asked and
 * never added by itself; and shortcuts gone for going unused, with Undo.
 */
export function LearnedToasts({ host }: { host: LearnedHost }) {
  const shortcuts = useView((v) => v.memory?.shortcuts);
  const [, redraw] = useState(0);
  // Removals from before this window opened were told then.
  const opened = useRef(Date.now() - 60_000);
  if (!shortcuts) return null;
  const done = (key: string) => {
    seen.add(key);
    redraw((n) => n + 1);
  };
  const offer = shortcuts.offers.find((o) => !seen.has(`offer:${o.item}`));
  const removed = shortcuts.removed.filter((r) => (r.at ?? 0) > opened.current && !seen.has(`removed:${r.item}:${r.at}`));
  return (
    <>
      {offer && (
        <Toast
          title="A shortcut for what you use often"
          done={false}
          onDismiss={() => {
            host.memoryChange({ shortcut: { decline: offer.item } });
            done(`offer:${offer.item}`);
          }}
        >
          <div className="flex flex-col gap-2" data-shortcut-offer={offer.item}>
            <span className="text-text">
              You often use {offer.name}: give it <kbd className="rounded-sm bg-chip px-1.5 font-sans text-text-strong">{keysLabel(offer.keys)}</kbd>?
            </span>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  host.memoryChange({ shortcut: { decline: offer.item } });
                  done(`offer:${offer.item}`);
                }}
                data-shortcut-not-now
              >
                Not Now
              </Button>
              <Button
                look="primary"
                onClick={() => {
                  host.memoryChange({ shortcut: { add: offer.item } });
                  done(`offer:${offer.item}`);
                }}
                data-shortcut-add
              >
                Add
              </Button>
            </div>
          </div>
        </Toast>
      )}
      {removed.map((r) => (
        <Toast key={`${r.item}:${r.at}`} title="A learned shortcut went" done onDismiss={() => done(`removed:${r.item}:${r.at}`)}>
          <div className="flex items-center gap-2" data-shortcut-removed={r.item}>
            <span className="min-w-0 flex-1 text-label text-text">
              <kbd className="rounded-sm bg-chip px-1.5 font-sans text-text-strong">{keysLabel(r.keys)}</kbd> {r.name}: unused for a week of editing
            </span>
            <Button
              onClick={() => {
                host.memoryChange({ shortcut: { restore: r.item } });
                done(`removed:${r.item}:${r.at}`);
              }}
              data-shortcut-undo
            >
              Undo
            </Button>
          </div>
        </Toast>
      ))}
    </>
  );
}

function Row({ s, children }: { s: LearnedShortcut; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-groove px-3 py-1.5" data-learned-shortcut={s.item}>
      <kbd className="min-w-12 shrink-0 rounded-sm bg-chip px-1.5 text-center font-sans text-label text-text-strong">{keysLabel(s.keys)}</kbd>
      <span className="min-w-0 flex-1 truncate text-text">{s.name}</span>
      {children}
    </div>
  );
}

/** Settings › Memory's learned shortcuts: those added, with Remove (never offered again), and those offered, with Add. */
export function LearnedShortcuts({ host, shortcuts }: { host: LearnedHost; shortcuts: { learned: LearnedShortcut[]; offers: LearnedShortcut[] } }) {
  return (
    <div className="flex flex-col gap-1" data-memory-shortcuts>
      <div className="text-label text-text-faint">
        Leader shortcuts for the effects and annotations you use most, offered after about 5 uses over 2 days, never added without asking. One goes after a week of editing without it.
      </div>
      {!shortcuts.learned.length && !shortcuts.offers.length && <div className="text-text-muted">Nothing yet.</div>}
      {shortcuts.learned.map((s) => (
        <Row key={s.item} s={s}>
          <span className="shrink-0 text-caption text-text-faint">
            {s.uses} {s.uses === 1 ? "use" : "uses"}
          </span>
          <TrashButton label="Remove for good" onClick={() => host.memoryChange({ shortcut: { remove: s.item } })} />
        </Row>
      ))}
      {shortcuts.offers.map((s) => (
        <Row key={s.item} s={s}>
          <span className="shrink-0 text-caption text-text-faint">offered · used {s.uses} times</span>
          <Button look="primary" onClick={() => host.memoryChange({ shortcut: { add: s.item } })} data-learned-add>
            Add
          </Button>
        </Row>
      ))}
    </div>
  );
}
