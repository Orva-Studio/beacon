import { useEffect, useMemo, useRef, useState } from "react";
import { assetName, type Asset } from "@beacon/model";
import { Icon, Modal, TextInput, type IconName } from "./controls";
import { KIND_ICON } from "./media-bin";
import { AI_TOOLS, allItems, inFavoriteOrder } from "./panel-items";
import { searchByName } from "./search";
import { replica, useView } from "./store";

interface PaletteHost {
  run(command: string, args?: unknown): void;
}

/** Something the palette adds: what the panels' tiles do on a double-click, an AI tool's review, or a medium of the bin. */
interface Entry {
  id: string;
  name: string;
  description: string;
  group: string;
  art?: string;
  /** A medium's picture, as the Media Bin shows it, else its kind's icon. */
  thumb?: string;
  icon?: IconName;
  starred: boolean;
  start: (host: PaletteHost) => void;
}

const KIND: Record<Exclude<Asset["kind"], "file">, string> = { recording: "Recording", video: "Video", audio: "Audio", image: "Image" };

const search = (entries: Entry[], query: string) => searchByName(entries, query, (e) => e.name, (e) => `${e.name} ${e.description} ${e.group}`);

/**
 * The command palette (⌘K by default): what can be done to clips or added to the timeline, by name or what it
 * does. Annotations are added at the playhead; effects and fades go on the selected clips, as a double-click on
 * their tile does; an AI tool opens its review; the selected clip's effects can be removed. Favourites come first.
 * Media from the bin, once something is typed (a big bin would bury the rest), go on the timeline at the playhead.
 */
export function Palette({ host }: { host: PaletteHost }) {
  const open = useView((v) => !!v.palette && !!v.opened);
  return open ? <PaletteUi host={host} /> : null;
}

function PaletteUi({ host }: { host: PaletteHost }) {
  const init = useView((v) => v.init);
  const favorites = useView((v) => v.favorites);
  const assets = useView((v) => v.project?.assets);
  const thumbs = useView((v) => v.thumbs);
  const tracks = useView((v) => v.project?.tracks);
  const first = useView((v) => v.session?.selection[0]);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => {
    const items = allItems(init).map((it): Entry & { favorite: string } => ({ id: it.favorite, favorite: it.favorite, name: it.label, description: it.title, group: it.group, art: it.art, starred: favorites.includes(it.favorite), start: (h) => {
      const effect = it.group !== "Annotation";
      replica.focusInputs(effect);
      h.run(it.command, it.args);
      if (effect) h.run("inspector.tab", { tab: "effects" });
    } }));
    const tools = AI_TOOLS.map((t): Entry => ({ id: `ai:${t.id}`, name: t.label, description: t.title, group: "AI", art: t.art, starred: false, start: t.start }));
    // The effects of the clip the properties show; two of a kind numbered.
    const clip = first ? (tracks ?? []).flatMap((t) => t.clips).find((c) => c.id === first) : undefined;
    const title = (type: string) => init?.effects.find((d) => d.id === type)?.title ?? type;
    const removals = (clip?.effects ?? []).map((fx, i, all): Entry => {
      const same = all.filter((f) => f.type === fx.type);
      const name = `Remove ${title(fx.type)}${same.length > 1 ? ` ${same.indexOf(fx) + 1}` : ""}`;
      return { id: `remove:${fx.id}`, name, description: "Take this effect off the selected clip", group: "Selected Clip", icon: "trash", starred: false, start: (h) => h.run("effect.remove", { clip: clip!.id, effect: fx.id }) };
    });
    return [...inFavoriteOrder(items, favorites), ...items.filter((e) => !e.starred), ...removals, ...tools];
  }, [init, favorites, tracks, first]);
  const media = useMemo(
    () =>
      // As the bin: a LUT or other file a feature imported isn't media to place.
      Object.values(assets ?? {}).filter((a) => a.kind !== "file").map(
        (a): Entry => ({ id: `media:${a.id}`, name: assetName(a), description: KIND[a.kind as keyof typeof KIND], group: "Media Bin", thumb: thumbs[`asset:${a.id}`], icon: KIND_ICON[a.kind as keyof typeof KIND_ICON], starred: false, start: (h) => h.run("edit.addMedia", { asset: a.id }) }),
      ),
    [assets, thumbs],
  );
  const found = useMemo(() => search(query.trim() ? [...entries, ...media] : entries, query), [entries, media, query]);
  useEffect(() => {
    setAt(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const close = () => replica.palette(false);
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    close();
    e.start(host);
  };
  return (
    <Modal width={600} onClose={close} onEnter={() => choose(found[at])}>
      <div className="relative" data-palette>
        <Icon name="magnifying-glass" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
        <TextInput
          autoFocus
          value={query}
          placeholder="Add an annotation, an effect, an AI tool or media"
          className="w-full py-2 pl-9 text-body"
          data-palette-search
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Tab moves through the list as the arrows do, rather than focus out of it.
            const step = e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) ? 1 : e.key === "ArrowUp" || e.key === "Tab" ? -1 : 0;
            if (step) {
              e.preventDefault();
              setAt((i) => Math.max(0, Math.min(found.length - 1, i + step)));
            }
          }}
        />
      </div>
      <div className="mt-2 text-caption text-text-faint">Annotations and media go in at the playhead; effects on the selected clips</div>
      <div ref={list} className="-mx-2 mt-2 max-h-[min(420px,60vh)] overflow-y-auto" role="listbox">
        {found.map((e, i) => (
          <div
            key={e.id}
            role="option"
            aria-selected={i === at}
            data-index={i}
            data-entry={e.id}
            className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ${i === at ? "bg-accent-wash" : "hover:bg-item-hover"}`}
            onPointerMove={() => i !== at && setAt(i)}
            onClick={() => choose(e)}
          >
            <span
              className={`flex aspect-[3/2] w-12 shrink-0 items-center justify-center rounded-sm bg-groove bg-cover bg-center text-text-disabled ${e.art ? `art-${e.art}` : ""}`}
              style={e.thumb ? { backgroundImage: `url(${JSON.stringify(e.thumb)})` } : undefined}
            >
              {!e.thumb && e.icon && <Icon name={e.icon} size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`flex items-center gap-1.5 truncate ${i === at ? "text-text-strong" : "text-text"}`}>
                {e.name}
                {e.starred && <Icon name="star" size={12} filled className="text-favorite" />}
              </div>
              <div className="truncate text-caption text-text-faint">{e.description}</div>
            </div>
            <span className="shrink-0 text-label text-text-muted">{e.group}</span>
          </div>
        ))}
        {!found.length && <div className="px-2 py-6 text-center text-text-faint">Nothing matches “{query}”</div>}
      </div>
    </Modal>
  );
}
