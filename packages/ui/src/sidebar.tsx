import { effectName } from "./effect-names";
import { memo, type ReactNode } from "react";
import type { Project, Session } from "@beacon/model";
import type { Host } from "./app";
import { pressItem, type PanelItem } from "./drop";
import type { Init } from "./rpc";
import { Icon, ItemTile, RailButton, type IconName } from "./controls";
import { MediaBin } from "./media-bin";

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
  if (tool === "media") return <MediaBin project={project} init={init} thumbs={thumbs} waveforms={waveforms} host={host} />;
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
