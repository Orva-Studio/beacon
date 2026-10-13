import { useEffect, useRef, useState } from "react";
import { assetName, type Asset, type Clip, type Project, type Track } from "@beacon/model";
import type { Host } from "./app";
import { pressItem, type PanelItem } from "./drop";
import type { Init } from "./rpc";
import { replica, useView, type BinKind, type BinSort } from "./store";
import { Icon, MediaTile, Progress, TextInput, Waveform, type IconName } from "./controls";
import { openPreview } from "./media-preview";
import { innerTracks } from "./timeline";

/** Each sort with its two directions, as one menu. */
const SORTS: [BinSort, string, string, string][] = [
  ["added", "Date Added", "oldest first", "newest first"],
  ["name", "Name", "A–Z", "Z–A"],
  ["created", "Date Created", "oldest first", "newest first"],
  ["duration", "Duration", "shortest first", "longest first"],
  ["dimensions", "Size", "smallest first", "largest first"],
];

const KINDS: [BinKind, string][] = [
  ["all", "All"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["image", "Images"],
];

/** Recordings are video too. */
const ofKind = (a: Asset, kind: BinKind) => kind === "all" || a.kind === kind || (kind === "video" && a.kind === "recording");

const video = (a: Asset) => ((a.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined)?.streams ?? []).find((s) => s.kind === "video");
const duration = (a: Asset) => (a.kind === "image" ? 0 : Number((a.derived.media as { duration?: number } | undefined)?.duration ?? 0));
/** The file's modification time, kept in its fingerprint ("size-mtime"): when a recording was made. */
const created = (a: Asset) => Number(a.fingerprint.split("-")[1] ?? 0);
const SORT_KEY: Record<Exclude<BinSort, "added">, (a: Asset) => number | string> = {
  name: (a) => assetName(a).toLowerCase(),
  created,
  dimensions: (a) => (video(a)?.width ?? 0) * (video(a)?.height ?? 0),
  duration,
};

/** Assets keep the order they were imported in (Date Added). */
function sortAssets(assets: Asset[], { by, desc }: { by: BinSort; desc: boolean }): Asset[] {
  const key = by === "added" ? undefined : SORT_KEY[by];
  const sorted = key ? [...assets].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)) : [...assets];
  return desc ? sorted.reverse() : sorted;
}

const KIND_ICON: Record<Asset["kind"], IconName> = { recording: "monitor-play", image: "image", audio: "music-note", video: "video-camera" };

const clock = (s: number) => {
  const t = Math.round(s);
  const two = (n: number) => String(n).padStart(2, "0");
  return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}` : `${Math.floor(t / 60)}:${two(t % 60)}`;
};

/** Assets with a clip on the timeline, inside groups and stitched clips too. */
function usedAssets(project: Project, nested: Record<string, string>): Set<string> {
  const used = new Set<string>();
  const walk = (tracks: Track[]) => {
    for (const t of tracks) {
      for (const c of t.clips as Clip[]) {
        if (c.assetId) used.add(c.assetId);
        const inner = innerTracks(c, nested);
        if (inner) walk(inner);
      }
    }
  };
  walk(project.tracks);
  return used;
}

/** A Media Bin item as something to drag onto the timeline or canvas. */
const binItem = (a: Asset): PanelItem => ({ label: assetName(a), command: "edit.addMedia", args: { asset: a.id }, traits: [], media: { seconds: a.kind === "image" ? 5 : duration(a) || 5 } });

/**
 * The Media Bin: search, a kind filter, sorting and grid or list, with an Import tile first. Tiles show the
 * picture with its duration and kind; a P when it has a proxy, a check when it is on the timeline.
 */
export function MediaBin({
  project,
  init,
  thumbs,
  waveforms,
  host,
}: {
  project: Project;
  init?: Init;
  thumbs: Record<string, string>;
  waveforms: Record<string, Record<number, number[]>>;
  host: Host;
}) {
  useEffect(() => {
    // A focused tile takes ⌫ (Delete Media); clicking anywhere else lets go of it.
    const away = (e: PointerEvent) => {
      const tile = (document.activeElement as HTMLElement | null)?.closest?.("[data-asset]");
      if (tile && !tile.contains(e.target as Node)) (document.activeElement as HTMLElement).blur();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const sort = useView((s) => s.binSort);
  const selection = useView((s) => s.binSelected);
  const grid = useRef<HTMLDivElement>(null);
  // A box dragged over the bin's empty space: its corners in the grid's scrolled coordinates.
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; base: string[] }>();
  const at = (e: React.PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    return [e.clientX - r.left + grid.current!.scrollLeft, e.clientY - r.top + grid.current!.scrollTop] as const;
  };
  const bin = useView((s) => s.bin);
  const all = Object.values(project.assets);
  const query = bin.query.trim().toLowerCase();
  const assets = sortAssets(all, sort).filter((a) => ofKind(a, bin.kind) && (!query || assetName(a).toLowerCase().includes(query)));
  const used = usedAssets(project, init?.nested ?? {});
  const list = bin.view === "list";
  return (
    <div className="panel-card flex w-[290px] shrink-0 flex-col overflow-hidden" data-media-bin>
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Icon name="magnifying-glass" size={14} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-muted" />
            <TextInput
              value={bin.query}
              placeholder="Search media"
              className="w-full pl-7"
              data-bin-search
              onChange={(e) => replica.viewBin({ query: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && (replica.viewBin({ query: "" }), e.currentTarget.blur())}
            />
          </div>
          <div className="relative rounded-sm p-1.5 text-text-muted hover:bg-chip hover:text-text-strong" title={`Sort: ${SORTS.find((x) => x[0] === sort.by)?.[1]}, ${SORTS.find((x) => x[0] === sort.by)?.[sort.desc ? 3 : 2]}`}>
            <Icon name={sort.desc ? "sort-descending" : "sort-ascending"} size={16} />
            {/* The native menu opens from an invisible select over the icon. */}
            <select
              data-bin-sort
              aria-label="Sort"
              className="absolute inset-0 cursor-pointer opacity-0"
              value={`${sort.by}:${sort.desc}`}
              onChange={(e) => {
                const [by, desc] = e.target.value.split(":");
                replica.sortBin({ by: by as BinSort, desc: desc === "true" });
                e.currentTarget.blur();
              }}
            >
              {SORTS.flatMap(([id, name, up, down]) => [
                <option key={`${id}:false`} value={`${id}:false`}>{`${name}, ${up}`}</option>,
                <option key={`${id}:true`} value={`${id}:true`}>{`${name}, ${down}`}</option>,
              ])}
            </select>
          </div>
          <button
            title={list ? "Show as a grid" : "Show as a list"}
            className="rounded-sm p-1.5 text-text-muted hover:bg-chip hover:text-text-strong"
            data-bin-view
            onClick={() => replica.viewBin({ view: list ? "grid" : "list" })}
          >
            <Icon name={list ? "squares-four" : "list"} size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          {KINDS.map(([kind, label]) => (
            <button
              key={kind}
              data-bin-kind={kind}
              className={`rounded-full px-2.5 py-0.5 text-caption ${bin.kind === kind ? "bg-accent font-semibold text-black" : "bg-chip text-text-dim hover:text-text-strong"}`}
              onClick={() => replica.viewBin({ kind })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={grid}
        data-bin-items
        className={`relative min-h-0 flex-1 overflow-y-auto px-3 pb-3 ${list ? "flex flex-col gap-1" : "grid auto-rows-min grid-cols-2 gap-2"}`}
        // On the bin's empty space: a click clears the selection, a drag selects the items its box touches (⇧/⌘ adds to it).
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget || e.button !== 0) return;
          const [x, y] = at(e);
          const base = e.shiftKey || e.metaKey ? selection : [];
          replica.selectBin(base);
          e.currentTarget.setPointerCapture(e.pointerId);
          setBox({ x0: x, y0: y, x1: x, y1: y, base });
        }}
        onPointerMove={(e) => {
          if (!box) return;
          const [x, y] = at(e);
          const next = { ...box, x1: x, y1: y };
          setBox(next);
          const g = grid.current!.getBoundingClientRect();
          const [left, right] = [Math.min(next.x0, x), Math.max(next.x0, x)].map((v) => v + g.left - grid.current!.scrollLeft);
          const [top, bottom] = [Math.min(next.y0, y), Math.max(next.y0, y)].map((v) => v + g.top - grid.current!.scrollTop);
          const hits = [...grid.current!.querySelectorAll<HTMLElement>("[data-asset]")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.right >= left! && r.left <= right! && r.bottom >= top! && r.top <= bottom!;
            })
            .map((el) => el.dataset.asset!);
          replica.selectBin([...new Set([...next.base, ...hits])]);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          setBox(undefined);
        }}
      >
        <ImportTile list={list} host={host} empty={!all.length} />
        {assets.map((a) => (
          <BinItem key={a.id} asset={a} list={list} used={used.has(a.id)} thumb={thumbs[`asset:${a.id}`]} peaks={waveforms[a.id]?.[0]} selection={selection} host={host} />
        ))}
        {box && (
          <div
            className="pointer-events-none absolute rounded-sm border border-accent bg-accent/10"
            style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
          />
        )}
        {!!all.length && !assets.length && <div className="col-span-2 py-6 text-center text-label text-text-faint">No media matches</div>}
      </div>
    </div>
  );
}

function ImportTile({ list, host, empty }: { list: boolean; host: Host; empty: boolean }) {
  return (
    <button
      data-bin-import
      title="Import Media… (⌘I): or drop files anywhere on the window"
      onClick={() => host.importMedia()}
      className={`flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-field-edge text-label text-text-dim hover:border-accent hover:text-text-strong ${
        list ? "py-2" : empty ? "col-span-2 aspect-[16/7] flex-col" : "min-h-24 flex-col"
      }`}
    >
      <Icon name="plus" size={list ? 14 : 18} />
      <span>Import</span>
      {!list && empty && <span className="text-caption text-text-faint">or drop videos, images and audio here</span>}
    </button>
  );
}

function BinItem({ asset: a, list, used, thumb, peaks, selection, host }: { asset: Asset; list: boolean; used: boolean; thumb?: string; peaks?: number[]; selection: string[]; host: Host }) {
  const selected = selection.includes(a.id);
  const renaming = useView((s) => s.renamingMedia === a.id);
  const preparing = useView((s) => s.preparing[a.id]);
  const proxy = useView((s) => !!s.proxies[a.id]);
  const missing = useView((s) => s.missing.includes(a.id));
  const seconds = duration(a);
  const picture = (
    <div className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-md ${a.kind === "audio" && peaks ? "bg-clip-audio" : "bg-black"} ${list ? "h-9 w-14" : "aspect-[16/10] w-full"}`}>
      {thumb ? (
        <img src={thumb} draggable={false} className="h-full w-full object-cover" />
      ) : a.kind === "audio" && peaks ? (
        <Waveform peaks={peaks} className="h-full w-full" />
      ) : (
        <Icon name={KIND_ICON[a.kind]} size={list ? 14 : 20} className="text-text-disabled" />
      )}
      {!list && (
        <>
          <span className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-[3px] bg-black/60 text-white" title={a.kind}>
            <Icon name={KIND_ICON[a.kind]} size={11} />
          </span>
          {seconds > 0 && <span className="absolute right-1 bottom-1 rounded-[3px] bg-black/60 px-1 text-[10px] leading-4 font-medium text-white tabular-nums">{clock(seconds)}</span>}
          {used && (
            <span className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-white" data-used title="On the timeline">
              <Icon name="check" size={10} />
            </span>
          )}
        </>
      )}
      {preparing !== undefined ? (
        <div className={`absolute inset-x-1 ${list ? "bottom-0.5" : "bottom-6"}`} data-proxy-progress title="Making a proxy: a copy that seeks quickly, for scrubbing">
          <Progress value={preparing} className="bg-black/60" />
        </div>
      ) : (
        proxy &&
        !list && (
          <span className="absolute top-1 right-1 flex size-3.5 items-center justify-center rounded-[3px] bg-accent text-[9px] leading-none font-bold text-black ring-1 ring-black/50" data-proxy title="Has a proxy: scrubbing reads a quick-to-seek copy">
            P
          </span>
        )
      )}
      {missing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-black/70 text-center" data-missing title={`${a.path} was moved, renamed or deleted. Right-click and choose Locate Media… to find it.`}>
          <span className="text-label font-semibold text-danger">Missing</span>
          {!list && <span className="text-[10px] text-text-muted">Right-click › Locate Media…</span>}
        </div>
      )}
    </div>
  );
  const name = renaming ? (
    <input
      // Rename… comes from a native menu: take focus once it has closed, with the name selected to type over.
      ref={(el) => {
        if (el && document.activeElement !== el) requestAnimationFrame(() => (el.focus(), el.select()));
      }}
      defaultValue={assetName(a)}
      className="min-w-0 flex-1 rounded-sm border border-accent bg-well px-1 text-label text-text-strong outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") replica.renameMedia(undefined);
      }}
      onBlur={(e) => {
        const value = e.currentTarget.value.trim();
        if (replica.get().renamingMedia === a.id && value !== assetName(a)) host.run("asset.rename", { asset: a.id, name: value }, "Rename Media");
        replica.renameMedia(undefined);
      }}
    />
  ) : (
    <span className="min-w-0 truncate">{assetName(a)}</span>
  );
  return (
    <MediaTile
      title={a.path}
      selected={selected}
      data-asset={a.id}
      data-selected={selected || undefined}
      tabIndex={-1}
      className={list ? "flex items-center gap-2" : undefined}
      onPointerDown={(e) => {
        // ⇧/⌘-click adds or removes it; a plain click on an unselected item selects only it.
        if (e.button === 0 && (e.shiftKey || e.metaKey)) replica.selectBin(selected ? selection.filter((id) => id !== a.id) : [...selection, a.id]);
        else if (!selected) replica.selectBin([a.id]);
        // Focused, it takes ⌫ (Delete Media) from the timeline's Delete.
        e.currentTarget.focus({ preventScroll: true });
        pressItem(e, binItem(a), (command, args) => host.run(command, args), false);
      }}
      // A plain click on one of several selected items leaves just it selected (after any drag of it).
      onClick={(e) => !e.shiftKey && !e.metaKey && selection.length > 1 && replica.selectBin([a.id])}
      onDoubleClick={() => void openPreview(host, a.id, assetName(a))}
      onKeyDown={(e) => {
        if (e.key !== "Backspace" && e.key !== "Delete") return;
        e.preventDefault();
        e.stopPropagation();
        host.run("edit.deleteMedia", { asset: selected ? selection : [a.id] }, "Delete Media");
      }}
      // WebKit would start its own drag of the thumbnail and keep the pointer events from us.
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        host.binMenu(a.id);
      }}
    >
      {picture}
      {list ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-text-strong">
          {name}
          <span className="flex-1" />
          {used && (
            <span data-used title="On the timeline" className="text-text-muted">
              <Icon name="check" size={12} />
            </span>
          )}
          {proxy && (
            <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-accent text-[9px] leading-none font-bold text-black" data-proxy title="Has a proxy: scrubbing reads a quick-to-seek copy">
              P
            </span>
          )}
          {seconds > 0 && <span className="shrink-0 text-caption text-text-muted tabular-nums">{clock(seconds)}</span>}
        </div>
      ) : (
        <div className="mt-1 flex items-center px-0.5 text-label text-text-strong">{name}</div>
      )}
    </MediaTile>
  );
}
