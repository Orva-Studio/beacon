import { effectName } from "./effect-names";
import { memo, type ReactNode } from "react";
import type { Project, Session } from "@beacon/model";
import type { Host } from "./app";
import { pressItem, type PanelItem } from "./drop";
import type { Init } from "./rpc";
import { Button, Icon, ItemTile, RailButton, type IconName } from "./controls";
import { clock, useNarrationSpan } from "./record";
import { MediaBin } from "./media-bin";
import { CaptionsWaiting } from "./captions";
import { replica, useView } from "./store";

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

/** A panel item with its tooltip and its tile's picture (`art/<art>.webp`). */
type Item = PanelItem & { title: string; art?: string };

/** The Annotations panel: presets of `edit.addAnnotation`, so agents add the same ones. */
const ANNOTATIONS: Item[] = (
  [
    ["Text", "text", "White text with a drop shadow"],
    ["Rectangle", "rectangle", "A black rounded rectangle"],
    ["Spotlight", "spotlight", "Darken everything outside the box"],
    ["Blur", "blur", "Blur what is inside the box"],
    ["Pixelate", "pixelate", "Pixelate what is inside the box"],
  ] as const
).map(([label, preset, title]) => ({ label, title, art: preset, command: "edit.addAnnotation", args: { preset }, traits: [], media: { seconds: 5 } }));

/** The default favourites. */
const FAVORITES = ["Text", "Rectangle", "Spotlight", "round-corners", "crt-monitor", "drop-shadow", "motion-blur"];

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
  // Items are dragged onto media (on the timeline or the canvas); a click applies them to the selection.
  const items: Record<string, Item[]> = {
    audioEffects: [
      { label: "Fade In", title: "Fade the audio in from silence over its first second", art: "fade-in", command: "edit.fade", args: { kind: "in" }, traits: ["audio"] },
      { label: "Fade Out", title: "Fade the audio out to silence over its last second", art: "fade-out", command: "edit.fade", args: { kind: "out" }, traits: ["audio"] },
    ],
  };
  const effects = (init?.effects ?? []).filter((e) => !e.traits.every((t) => t === "cursor"));
  const effect = (e: (typeof effects)[number]): Item => ({ label: effectName(e.id), title: e.description, art: e.id, command: "edit.addEffect", args: { type: e.id }, traits: e.traits });
  if (tool === "visualEffects") items.visualEffects = effects.map(effect);
  if (tool === "annotations") items.annotations = ANNOTATIONS;
  if (tool === "favorites") items.favorites = [...ANNOTATIONS.filter((a) => FAVORITES.includes(a.label)), ...effects.filter((e) => FAVORITES.includes(e.id)).map(effect)];
  if (items[tool]) {
    return (
      <Panel title={label}>
        <div className="mb-3 text-center text-label text-text-faint">Drag onto media, or click to apply to the selection</div>
        <div className="grid grid-cols-2 gap-2">
          {items[tool]!.map((it) => (
            <ItemTile key={it.label} art={it.art} title={`${it.title}. Drag it onto media, or click to apply it to the selection`} onPointerDown={(e) => pressItem(e, it, (command, args) => host.run(command, args))}>
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

/** Voice narration's way in, as Camtasia's tab is: what it does and plays, and the Record dialog with only the microphone. */
function NarrationPanel({ host }: { host: Host }) {
  const span = useNarrationSpan();
  const narrating = useView((v) => !!v.narrating);
  return (
    <Panel title="Narration">
      <div className="flex flex-col gap-3 text-body text-text-muted" data-narration-panel>
        <p>Record your voice while the timeline plays, talking over it. It goes on a new track where you began, in step with what played, and is transcribed.</p>
        <p className="text-text-faint">
          {span.still
            ? `Nothing plays after the playhead: it records at ${clock(span.from)} until you stop.`
            : span.ranged
              ? `Plays the range ${clock(span.from)}–${clock(span.until)}.`
              : `Plays from the playhead (${clock(span.from)}) until you stop or the timeline ends. Set an in/out range to narrate over part of it.`}
        </p>
        <Button look="primary" disabled={narrating} onClick={() => host.openRecord("narration")} data-narration-start>
          Record Narration…
        </Button>
      </div>
    </Panel>
  );
}

/** Edits that read the media (its transcript, its recording's cursor) and change the whole timeline: each opens its review in the properties panel. */
function AiPanel({ host }: { host: Host }) {
  const review = (command: string) => {
    host.run(command, {});
    host.run("panel.show", { properties: true });
  };
  return (
    <Panel title="AI">
      <div className="mb-3 text-center text-label text-text-faint">Click to review it on the timeline, then apply</div>
      <div className="grid grid-cols-2 gap-2">
        <ItemTile art="remove-silences" title="Shorten the pauses in speech, from its transcript (made on this Mac)" onClick={() => review("silences.review")} data-ai="silences">
          Remove Silences
        </ItemTile>
        <ItemTile art="remove-fillers" title={'Cut "um", "uh" and the like where the transcript has them'} onClick={() => review("fillers.review")} data-ai="fillers">
          Remove Filler Words
        </ItemTile>
        <ItemTile
          art="captions"
          title="Captions from the transcript, a few words at a time, the spoken word highlighted: burned into the export, with an .srt beside it"
          onClick={() => replica.pendCaptions(true)}
          data-ai="captions"
        >
          Captions
        </ItemTile>
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
