import { memo, useEffect, useState, type ReactNode } from "react";
import type { Project, Session } from "@beacon/model";
import type { Host } from "./app";
import { pressItem } from "./drop";
import { AI_TOOLS, ANNOTATIONS, AUDIO_EFFECTS, visualEffects, type Item } from "./panel-items";
import type { AudioLevel, Init, RecordPreview, RecordSheet } from "./rpc";
import { Button, Icon, ItemTile, LevelMeter, RailButton, Select, type IconName } from "./controls";
import { previewListeners } from "./record-preview";
import { clock, useNarrationSpan } from "./record";
import { MediaBin } from "./media-bin";
import { CaptionsWaiting } from "./captions";
import { replica, useView } from "./store";
import { useOnline } from "./online";

/** The tool panels, in order, with an icon each. */
export const TOOLS: { id: string; label: string; icon: IconName }[] = [
  { id: "favorites", label: "Favorites", icon: "star" },
  { id: "media", label: "Media", icon: "film-strip" },
  { id: "annotations", label: "Annotations", icon: "chat-centered-text" },
  { id: "visualEffects", label: "Visual Effects", icon: "magic-wand" },
  { id: "audioEffects", label: "Audio Effects", icon: "waveform" },
  { id: "narration", label: "Narration", icon: "microphone" },
  { id: "ai", label: "AI", icon: "sparkle" },
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

/** Memoised: it doesn't show the session, so playback ticks don't re-render it. */
export const ToolPanel = memo(function ToolPanel({
  tool,
  project,
  init,
  thumbs,
  waveforms,
  host,
}: {
  tool: string;
  project: Project;
  init?: Init;
  thumbs: Record<string, string>;
  waveforms: Record<string, Record<number, number[]>>;
  host: Host;
}) {
  const label = TOOLS.find((t) => t.id === tool)?.label ?? tool;
  if (tool === "media") return <MediaBin project={project} thumbs={thumbs} waveforms={waveforms} host={host} />;
  if (tool === "ai") return <AiPanel host={host} />;
  if (tool === "narration") return <NarrationPanel host={host} />;
  const effects = visualEffects(init);
  const items: Record<string, Item[]> = { annotations: ANNOTATIONS, visualEffects: effects, audioEffects: AUDIO_EFFECTS };
  if (tool === "favorites") return <ItemsPanel key={tool} title={label} items={[...ANNOTATIONS, ...effects, ...AUDIO_EFFECTS]} host={host} ordered />;
  if (items[tool]) return <ItemsPanel key={tool} title={label} items={items[tool]} host={host} />;
  return (
    <Panel title={label}>
      <div className="mt-6 text-center text-body text-text-faint">Not in Beacon yet</div>
    </Panel>
  );
});

/** The favourite under a point in the Favorites panel (a tile dragged over another is moved to its place). */
const favoriteAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-favorites] [data-item]") as HTMLElement | null)?.dataset.item;

/**
 * Annotations, effects or favourites, as Camtasia's panels have them: dragged onto media (on the timeline or the
 * canvas); a click selects one, showing a star that adds it to Favorites; a double-click applies it to the selected
 * clips. `ordered`: the Favorites panel, holding the favourites in their order, which a drop on another tile changes.
 */
function ItemsPanel({ title, items, host, ordered }: { title: string; items: Item[]; host: Host; ordered?: boolean }) {
  const favorites = useView((v) => v.favorites);
  const [selected, setSelected] = useState<string>();
  const over = useView((v) => (ordered && v.dragging ? favoriteAt(v.dragging.x, v.dragging.y) : undefined));
  const shown = ordered ? favorites.flatMap((f) => items.find((it) => it.favorite === f) ?? []) : items;
  const hint = ordered ? "Drag onto media, or onto another tile to reorder; double-click to apply to the selection" : "Drag onto media, or double-click to apply to the selection";
  return (
    <Panel title={title}>
      <div className="mb-3 text-center text-label text-text-faint">{hint}</div>
      <div className="grid grid-cols-2 gap-2" {...(ordered ? { "data-favorites": "" } : {})}>
        {shown.map((it) => {
          const favorite = favorites.includes(it.favorite);
          return (
            <ItemTile
              key={it.favorite}
              art={it.art}
              title={`${it.title}. Drag it onto media, or double-click to apply it to the selection`}
              data-item={it.favorite}
              selected={selected === it.favorite || over === it.favorite}
              star={favorite ? "on" : selected === it.favorite ? "off" : undefined}
              onStar={() => (favorite ? host.favoriteRemove(it.favorite) : host.favoriteAdd(it.favorite))}
              onPointerDown={(e) =>
                pressItem(e, it, (command, args) => host.run(command, args), {
                  click: () => setSelected(it.favorite),
                  ...(ordered ? { missed: (x, y) => moveFavorite(host, favorites, it.favorite, favoriteAt(x, y)) } : {}),
                })
              }
              onDoubleClick={() => host.run(it.command, it.args)}
            >
              {it.label}
            </ItemTile>
          );
        })}
      </div>
    </Panel>
  );
}

function moveFavorite(host: Host, favorites: string[], item: string, onto: string | undefined) {
  if (onto && onto !== item) host.favoriteMove(item, favorites.indexOf(onto));
}

/**
 * Voice narration, as Camtasia's Narration tab has it: pick the microphone (its level shown), whether the timeline
 * is heard, then Start: a countdown, and the timeline plays while it records. The Record dialog does the same.
 */
function NarrationPanel({ host }: { host: Host }) {
  const span = useNarrationSpan();
  const narrating = useView((v) => !!v.narrating);
  const dialog = useView((v) => !!v.recordSheet);
  const [devices, setDevices] = useState<RecordSheet>();
  const [microphone, setMicrophone] = useState<string>();
  const [hear, setHear] = useState(false);
  const [level, setLevel] = useState<AudioLevel>();
  const [counting, setCounting] = useState<number>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void host.narrationDevices().then((d) => {
      setDevices(d);
      setMicrophone(d.microphones.some((m) => m.id === d.sources.microphone?.id) ? d.sources.microphone!.id : d.microphones[0]?.id);
      setHear(!!d.hear);
    });
  }, []);
  // Its level: previewed while idle; while it records, the take sends it. The Record dialog has the microphone while open.
  const granted = devices?.permissions.microphone === "granted";
  useEffect(() => {
    const listen = (e: RecordPreview) => "microphone" in e && e.microphone && setLevel(e.microphone);
    previewListeners.add(listen);
    const preview = granted && !!microphone && !narrating && !dialog;
    if (preview) host.recordPreview({ microphone: { id: microphone } });
    return () => {
      previewListeners.delete(listen);
      setLevel(undefined);
      if (preview) host.recordPreview({});
    };
  }, [granted, microphone, narrating, dialog]);
  useEffect(() => {
    if (counting === undefined) return;
    if (counting > 0) {
      const t = setTimeout(() => setCounting(counting - 1), 1000);
      return () => clearTimeout(t);
    }
    void host.startNarration({ id: microphone }, hear && !span.still).then((r) => {
      setCounting(undefined);
      setError(r.ok ? undefined : r.error);
    });
  }, [counting]);
  const start = () => {
    setError(undefined);
    setCounting(3);
  };
  return (
    <Panel title="Narration">
      <div className="flex flex-col gap-3 text-body" data-narration-panel>
        <Select value={microphone ?? ""} disabled={narrating || counting !== undefined} onChange={(e) => setMicrophone(e.target.value)} aria-label="Microphone">
          {devices?.microphones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <div className="flex">
          <LevelMeter label="Microphone level" db={level?.db} peak={level?.peak} />
        </div>
        {devices && !granted && devices.permissions.microphone !== "not asked" && (
          <span className="text-caption text-warning">Allow Beacon in System Settings › Privacy & Security › Microphone</span>
        )}
        {!span.still && (
          <label className="flex items-center gap-2 text-text">
            <input type="checkbox" checked={hear} disabled={narrating} onChange={(e) => setHear(e.target.checked)} data-narration-hear />
            Hear the timeline while recording
          </label>
        )}
        {hear && !span.still && <span className="text-caption text-warning">Use headphones: from speakers, the timeline records into the narration</span>}
        {narrating ? (
          <Button look="danger" onClick={() => host.stopNarration()} data-narration-stop-panel>
            Stop Recording
          </Button>
        ) : counting !== undefined ? (
          <Button onClick={() => setCounting(undefined)} data-narration-countdown>
            Starting in {Math.max(counting, 1)}… (Cancel)
          </Button>
        ) : (
          <Button look="primary" disabled={!microphone} onClick={start} data-narration-start>
            Start Voice Recording
          </Button>
        )}
        {error && <span className="text-caption text-danger">{error}</span>}
      </div>
    </Panel>
  );
}

/**
 * The AI tools read transcripts: offline, with a transcriber that needs the internet and media that has none yet,
 * they can't work. Returns that transcriber's name then.
 */
function useOffline(host: Host): string | undefined {
  const online = useOnline();
  const project = useView((v) => v.project);
  const transcriber = useView((v) => v.preferences.find((p) => p.id === "transcriber"));
  const chosen = transcriber?.options.find((o) => o.id === transcriber.value);
  const needs = !online && !!chosen?.online;
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!needs) {
      setWaiting(false);
      return;
    }
    let live = true;
    host.query("transcript.silences", {}).then(
      (r) => live && setWaiting((r as { waiting: string[] }).waiting.length > 0),
      () => live && setWaiting(false),
    );
    return () => {
      live = false;
    };
  }, [needs, project]);
  return needs && waiting ? chosen!.title : undefined;
}

/** Edits that read the media (its transcript, its recording's cursor) and change the whole timeline: each opens its review in the properties panel. */
function AiPanel({ host }: { host: Host }) {
  const offline = useOffline(host);
  return (
    <Panel title="AI">
      <div className="mb-3 text-center text-label text-text-faint">Click to review it on the timeline, then apply</div>
      {offline && (
        <div className="mb-3 rounded-md bg-chip px-3 py-2 text-caption text-warning" data-ai-offline>
          You're offline, and {offline} transcribes over the internet: media here has no transcript yet, so these can't work until you're back online. Apple's transcriber works offline (Settings › General).
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {AI_TOOLS.map((t) => (
          <ItemTile key={t.id} art={t.art} title={offline ? `Needs a transcript ${offline} can't make offline` : t.title} disabled={!!offline} onClick={() => t.start(host)} data-ai={t.id}>
            {t.label}
          </ItemTile>
        ))}
      </div>
      <CaptionsWaiting />
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel-card flex w-[290px] shrink-0 flex-col overflow-y-auto">
      <div className="py-3 text-center text-[17px] font-semibold text-text-strong">{title}</div>
      <div className="px-3">{children}</div>
    </div>
  );
}
