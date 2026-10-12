import { effectName } from "./effect-names";
import { memo, useEffect, type ReactNode } from "react";
import { assetName, type Asset, type Project, type Session } from "@beacon/model";
import type { Host } from "./app";
import { pressItem, type PanelItem } from "./drop";
import type { Init } from "./rpc";
import { replica, useView, type BinSort } from "./store";
import { Icon, ItemTile, MediaTile, Progress, RailButton, Select, Waveform, type IconName } from "./controls";
import { openPreview } from "./media-preview";

/** The tool panels, in order, with an icon each. */
export const TOOLS: { id: string; label: string; icon: IconName }[] = [
  { id: "favorites", label: "Favorites", icon: "star" },
  { id: "media", label: "Media", icon: "film-strip" },
  { id: "annotations", label: "Annotations", icon: "chat-centered-text" },
  { id: "visualEffects", label: "Visual Effects", icon: "magic-wand" },
  { id: "audioEffects", label: "Audio Effects", icon: "waveform" },
  { id: "narration", label: "Narration", icon: "microphone" },
];

export function ToolRail({ session, host }: { session?: Session; host: Host }) {
  return (
    <div className="panel-card flex w-14 shrink-0 flex-col items-center gap-1 overflow-hidden py-2 select-none">
      {TOOLS.map((t) => {
        const on = session?.panels.tool === t.id;
        return (
          <RailButton key={t.id} active={on} title={t.label} aria-label={t.label} onClick={() => host.run("panel.show", { tool: on ? null : t.id })}>
            <Icon name={t.icon} size={22} filled={on} />
          </RailButton>
        );
      })}
    </div>
  );
}

const GROUPS: { title: string; test: (a: Asset) => boolean }[] = [
  { title: "Screen Recordings", test: (a) => a.kind === "recording" },
  { title: "Video", test: (a) => a.kind === "video" },
  { title: "Images", test: (a) => a.kind === "image" },
  { title: "Audio", test: (a) => a.kind === "audio" },
];

/** Sort by options for the Media Bin. */
const SORTS: [BinSort, string][] = [
  ["type", "Media Type"],
  ["name", "Name"],
  ["added", "Date Added"],
  ["created", "Date Created"],
  ["dimensions", "Dimensions"],
  ["duration", "Duration"],
];

const video = (a: Asset) => ((a.derived.media as { streams?: { kind: string; width?: number; height?: number }[] } | undefined)?.streams ?? []).find((s) => s.kind === "video");
/** The file's modification time, kept in its fingerprint ("size-mtime"): when a recording was made. */
const created = (a: Asset) => Number(a.fingerprint.split("-")[1] ?? 0);
const SORT_KEY: Record<Exclude<BinSort, "type" | "added">, (a: Asset) => number | string> = {
  name: (a) => assetName(a).toLowerCase(),
  created,
  dimensions: (a) => (video(a)?.width ?? 0) * (video(a)?.height ?? 0),
  duration: (a) => Number((a.derived.media as { duration?: number } | undefined)?.duration ?? 0),
};

/** The bin's items in order: assets keep the order they were imported in (Date Added). */
function sortAssets(assets: Asset[], { by, desc }: { by: BinSort; desc: boolean }): Asset[] {
  const key = by === "type" || by === "added" ? undefined : SORT_KEY[by];
  const sorted = key ? [...assets].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)) : [...assets];
  return desc ? sorted.reverse() : sorted;
}

/** The mark beside a bin item's name: a record dot for recordings, else what the file is. */
const KIND_ICON: Record<Asset["kind"], IconName> = { recording: "monitor-play", image: "image", audio: "music-note", video: "video-camera" };

function KindIcon({ kind }: { kind: Asset["kind"] }) {
  return <Icon name={KIND_ICON[kind]} size={15} className="shrink-0 text-text-dim" />;
}


/** The Annotations panel: presets of `edit.addAnnotation`, so agents add the same ones. */
const ANNOTATIONS: (PanelItem & { title: string })[] = (
  [
    ["Text", "text", "White text with a drop shadow"],
    ["Rectangle", "rectangle", "A black rounded rectangle"],
    ["Spotlight", "spotlight", "Darken everything outside the box"],
    ["Blur", "blur", "Blur what is inside the box"],
    ["Pixelate", "pixelate", "Pixelate what is inside the box"],
  ] as const
).map(([label, preset, title]) => ({ label, title, command: "edit.addAnnotation", args: { preset }, traits: [], media: { seconds: 5 } }));

/** The default favourites. */
const FAVORITES = ["Text", "Rectangle", "Spotlight", "round-corners", "crt-monitor", "drop-shadow", "motion-blur"];

/** A Media Bin item as something to drag onto the timeline or canvas. */
const binItem = (a: Asset): PanelItem => {
  const seconds = a.kind === "image" ? 5 : Number((a.derived.media as { duration?: number } | undefined)?.duration ?? 5);
  return { label: assetName(a), command: "edit.addMedia", args: { asset: a.id }, traits: [], media: { seconds } };
};

/** Memoised: it doesn't show the session, so playback ticks don't re-render it. */
export const ToolPanel = memo(function ToolPanel({
  tool,
  project,
  init,
  thumbs,
  waveforms,
  highlight,
  host,
}: {
  tool: string;
  project: Project;
  init?: Init;
  thumbs: Record<string, string>;
  waveforms: Record<string, Record<number, number[]>>;
  highlight?: string;
  host: Host;
}) {
  const label = TOOLS.find((t) => t.id === tool)?.label ?? tool;
  const renaming = useView((s) => s.renamingMedia);
  const preparing = useView((s) => s.preparing);
  const proxies = useView((s) => s.proxies);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const tile = (document.activeElement as HTMLElement | null)?.closest?.("[data-asset]");
      if (tile && !tile.contains(e.target as Node)) (document.activeElement as HTMLElement).blur();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const missing = useView((s) => s.missing);
  const binSort = useView((s) => s.binSort);
  if (tool === "media") {
    const sort = binSort;
    const assets = sortAssets(Object.values(project.assets), sort);
    // Sorted by anything but Media Type, the bin is one list.
    const groups = sort.by === "type" ? GROUPS : [{ title: "", test: () => true }];
    return (
      <Panel title="Media">
        <div className="mb-3 flex items-center justify-center gap-2 text-body text-text-dim">
          Sort by
          <div className="w-32">
            <Select value={sort.by} onChange={(e) => replica.sortBin({ ...sort, by: e.target.value as BinSort })}>
              {SORTS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          {([false, true] as const).map((desc) => (
            <button
              key={String(desc)}
              title={desc ? "Descending" : "Ascending"}
              className={`rounded-sm px-1.5 py-1 ${sort.desc === desc ? "bg-chip text-text-strong" : "text-text-muted hover:text-text-strong"}`}
              onClick={() => replica.sortBin({ ...sort, desc })}
            >
              <Icon name={desc ? "sort-descending" : "sort-ascending"} size={16} />
            </button>
          ))}
        </div>
        {groups.map((g) => {
          const items = assets.filter(g.test);
          if (!items.length) return null;
          return (
            <div key={g.title} className="mb-4">
              {g.title && <div className="mb-2 border-b border-divider pb-1 text-body text-text-dim">▾ {g.title}</div>}
              <div className="grid grid-cols-2 gap-2">
                {items.map((a) => (
                  <MediaTile
                    key={a.id}
                    title={a.path}
                    selected={highlight === a.id}
                    data-asset={a.id}
                    tabIndex={-1}
                    onPointerDown={(e) => {
                      if (e.button === 0) replica.media({ highlight: a.id });
                      // Focused, it takes ⌫ (Delete Media) from the timeline's Delete.
                      e.currentTarget.focus({ preventScroll: true });
                      pressItem(e, binItem(a), (command, args) => host.run(command, args), false);
                    }}
                    onDoubleClick={() => void openPreview(host, a.id, assetName(a))}
                    onKeyDown={(e) => {
                      if (e.key !== "Backspace" && e.key !== "Delete") return;
                      e.preventDefault();
                      e.stopPropagation();
                      host.run("edit.deleteMedia", { asset: a.id }, `Delete ${assetName(a)}`);
                    }}
                    // WebKit would start its own drag of the thumbnail and keep the pointer events from us.
                    onDragStart={(e) => e.preventDefault()}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      host.binMenu(a.id);
                    }}
                  >
                    <div className={`relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-sm ${a.kind === "audio" && waveforms[a.id]?.[0] ? "bg-clip-audio" : "bg-black"}`}>
                      {thumbs[`asset:${a.id}`] ? (
                        <img src={thumbs[`asset:${a.id}`]} draggable={false} className="h-full w-full object-cover" />
                      ) : a.kind === "audio" && waveforms[a.id]?.[0] ? (
                        <Waveform peaks={waveforms[a.id]![0]!} className="h-full w-full" />
                      ) : (
                        <span className="text-caption text-text-disabled">{a.kind}</span>
                      )}
                      {preparing[a.id] !== undefined ? (
                        <div className="absolute inset-x-1.5 bottom-1.5" data-proxy-progress title="Making a proxy: a copy that seeks quickly, for scrubbing">
                          <Progress value={preparing[a.id]!} className="bg-black/60" />
                        </div>
                      ) : (
                        proxies[a.id] && <span className="absolute bottom-1.5 left-1.5 size-2.5 rounded-full bg-accent ring-1 ring-black/50" data-proxy title="Has a proxy: scrubbing reads a quick-to-seek copy" />
                      )}
                      {missing.includes(a.id) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-black/70 text-center" data-missing title={`${a.path} was moved, renamed or deleted. Right-click and choose Locate Media… to find it.`}>
                          <span className="text-label font-semibold text-danger">Missing</span>
                          <span className="text-[10px] text-text-muted">Right-click › Locate Media…</span>
                        </div>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 truncate text-label text-text-strong">
                      <KindIcon kind={a.kind} />
                      {renaming === a.id ? (
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
                            const name = e.currentTarget.value.trim();
                            if (replica.get().renamingMedia === a.id && name !== assetName(a)) host.run("asset.rename", { asset: a.id, name }, "Rename Media");
                            replica.renameMedia(undefined);
                          }}
                        />
                      ) : (
                        assetName(a)
                      )}
                    </div>
                  </MediaTile>
                ))}
              </div>
            </div>
          );
        })}
      </Panel>
    );
  }
  // Items are dragged onto media (on the timeline or the canvas); a click applies them to the selection.
  const items: Record<string, (PanelItem & { title: string })[]> = {
    audioEffects: [
      { label: "Fade In", title: "Fade the audio in from silence over its first second", command: "edit.fade", args: { kind: "in" }, traits: ["audio"] },
      { label: "Fade Out", title: "Fade the audio out to silence over its last second", command: "edit.fade", args: { kind: "out" }, traits: ["audio"] },
    ],
  };
  const effects = (init?.effects ?? []).filter((e) => !e.traits.every((t) => t === "cursor"));
  const effect = (e: (typeof effects)[number]) => ({ label: effectName(e.id), title: e.description, command: "edit.addEffect", args: { type: e.id }, traits: e.traits });
  if (tool === "visualEffects") items.visualEffects = effects.map(effect);
  if (tool === "annotations") items.annotations = ANNOTATIONS;
  if (tool === "favorites") items.favorites = [...ANNOTATIONS.filter((a) => FAVORITES.includes(a.label)), ...effects.filter((e) => FAVORITES.includes(e.id)).map(effect)];
  if (items[tool]) {
    return (
      <Panel title={label}>
        <div className="mb-3 text-center text-label text-text-faint">Drag onto media, or click to apply to the selection</div>
        <div className="grid grid-cols-2 gap-2">
          {items[tool]!.map((it) => (
            <ItemTile key={it.label} title={`${it.title}. Drag it onto media, or click to apply it to the selection`} onPointerDown={(e) => pressItem(e, it, (command, args) => host.run(command, args))}>
              {it.label}
            </ItemTile>
          ))}
        </div>
      </Panel>
    );
  }
  return (
    <Panel title={label}>
      <div className="mt-6 text-center text-body text-text-faint">Not in Beacon yet</div>
    </Panel>
  );
});

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel-card flex w-[290px] shrink-0 flex-col overflow-y-auto">
      <div className="py-3 text-center text-[17px] font-semibold text-text-strong">{title}</div>
      <div className="px-3">{children}</div>
    </div>
  );
}
