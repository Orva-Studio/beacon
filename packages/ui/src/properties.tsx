import { useEffect, useMemo, useRef, useState } from "react";
import type { Clip, EffectInstance, Project, Session } from "@beacon/model";
import { assetName, clipSpeed, EASINGS, formatColor, inspectorTabs, KeptLooksSchema, rationalToNumber, ticksToSeconds, wordsInWindow } from "@beacon/model";
import type { Host } from "./app";
import { contentSize, valueAt } from "./canvas-clips";
import type { Init } from "./rpc";
import type { CaptionStyle } from "@beacon/features";
import { NO_NESTED, timelineView } from "./timeline-draw";
import { Button, Check, clamp, ColorRow, ColorSwatch, FoldSection, fromHex, ListSelect, NumberBox, Row, Section, Select, Slider, Stepper, Tab, TextArea, TrashButton, Icon, type IconName, type RGBA, RotationGizmo } from "./controls";
import { replica, useView } from "./store";
import { useQuery } from "./query";
import { propsOf } from "./props";
import { copiedIds } from "./clip-ids";
import { BrollTab } from "./broll";
import { MotionTab } from "./motion";

/**
 * The properties panel: icon tabs, the clip's name, then the tab's
 * controls, showing values at the playhead. Edits apply to every selected
 * clip at the playhead (`clip.set` with `at`); a slider drag is one undo step.
 */
export function Properties({ project: full, session, host, init }: { project: Project; session: Session; host: Host; init?: Init }) {
  // With a group open, its clips are the ones being edited, shown at main-timeline times.
  const { project } = timelineView(full, session, init?.nested ?? NO_NESTED);
  const all = project.tracks.flatMap((t) => t.clips);
  const selected = session.selection.map((id) => all.find((c) => c.id === id)).filter((c): c is Clip => !!c);
  const clip = selected[0];
  const panel = useRef<HTMLDivElement>(null);
  const rev = useView((s) => s.rev);
  const focus = useView((s) => s.focusInputs);
  // An effect or annotation picked in the palette, or a tab stepped to by : [ and : ]: once it has arrived, the caret goes in its first input.
  useEffect(() => {
    if (!focus || !clip || !panel.current) return;
    if (focus.tab !== undefined ? session.inspector === focus.tab : (rev ?? 0) <= focus.rev) return;
    // Only soon after it was asked, and not from under a dialog: a late one would take the caret from wherever it is.
    if (performance.now() - focus.at > FOCUS_MS || document.querySelector("[data-modal], [data-palette]")) return replica.focusInputs(undefined);
    const scope = focus.effect ? panel.current.querySelector(`[data-effect="${clip.effects.at(-1)?.id}"]`) : panel.current;
    const first = scope && inputsIn(scope)[0];
    if (!first) return;
    first.focus();
    replica.focusInputs(undefined);
  });
  return (
    <div
      ref={panel}
      className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto text-body"
      // Tab and ⇧Tab go through the inputs in order (value boxes, menus, colour wells); Esc gives the keys back to the timeline.
      onKeyDown={(e) => {
        if (e.key === "Escape" && panel.current?.contains(document.activeElement)) {
          e.stopPropagation();
          // A value box's own Escape runs first and cancels what was typed.
          setTimeout(() => (document.activeElement as HTMLElement | null)?.blur());
          return;
        }
        if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
        const list = inputsIn(panel.current!);
        const i = list.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        e.preventDefault();
        list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]!.focus();
      }}
    >
      {!clip ? (
        <div className="p-4 text-center text-text-faint">{session.selection.length ? "Selection is not on the timeline" : "Select media on the timeline to see its properties"}</div>
      ) : (
        <ClipProperties project={project} session={session} clip={clip} selected={selected} host={host} init={init} />
      )}
    </div>
  );
}

/** How long after a palette pick its effect's first input may still take the caret. */
const FOCUS_MS = 2000;

/** The properties panel's inputs, in order: value boxes, text, menus, colour wells and checkboxes, not a section's own header. */
function inputsIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-input], input, select, textarea, button[role=checkbox]")].filter(
    (e) => !e.closest("[data-fold-head]") && !(e as HTMLInputElement).disabled && e.offsetParent !== null,
  );
}

type Tab = { id: string; title: string; icon: IconName };

/** The tabs every clip with media or effects can have; the rest come from its groups (`Init.tabs`). */
const CLIP_TABS: Record<string, Tab> = {
  speed: { id: "speed", title: "Clip Speed", icon: "gauge" },
  effects: { id: "effects", title: "Effects", icon: "sparkle" },
};

/** Sets fields of a prop group on the selected clips that have it; `key` makes a drag's changes one undo step. */
type Edit = (group: string, fields: Record<string, unknown>, label: string, key?: string) => void;

function ClipProperties({
  project,
  session,
  clip,
  selected,
  host,
  init,
}: {
  project: Project;
  session: Session;
  clip: Clip;
  selected: Clip[];
  host: Host;
  init?: Init;
}) {
  const traits = init?.clipTypes[clip.type] ?? [];
  const own = new Map((init?.tabs[clip.type] ?? []).map((t): [string, Tab] => [t.id, { ...t, icon: t.icon as IconName }]));
  const tabs = inspectorTabs(clip, [...own.keys()], !!init?.retimes.includes(clip.type), session.inspector).map((id) => CLIP_TABS[id] ?? own.get(id)!);
  const tab = tabs.find((t) => t.id === session.inspector) ?? tabs[0];
  const value = (group: string, field: string, fallback = 0) => valueAt(clip, session.playhead, group, field, fallback);
  const edit: Edit = (group, fields, label, key) => {
    const clips = selected.filter((c) => c === clip || c.type === clip.type || c.props[group] !== undefined).map((c) => c.id);
    host.run("clip.set", { clips, props: { [group]: fields }, at: session.playhead }, label, key);
  };

  return (
    <>
      <div className="flex border-b border-divider bg-tabbar">
        {tabs.map((t) => (
          <Tab key={t.id} title={t.title} active={t === tab} onClick={() => host.run("inspector.tab", { tab: t.id })}>
            {t.id === "effects" ? <span className="text-[17px] leading-none font-bold italic">fx</span> : <Icon name={t.icon} size={22} filled={t === tab} />}
          </Tab>
        ))}
      </div>
      {selected.length > 1 && <div className="border-b border-divider bg-panel py-2 text-center text-label text-text-faint">Editing {selected.length} clips</div>}
      {session.animation?.clip === clip.id && <AnimationSection clip={clip} id={session.animation.id} host={host} />}
      {tab?.id === "transform" && <Visual clip={clip} project={project} value={value} edit={edit} picture={traits.includes("picture")} />}
      {tab?.id === "speed" && (
        <ClipSpeed clip={clip} selected={selected} fps={rationalToNumber(project.settings.fps)} host={host} />
      )}
      {tab?.id === "cursor" && <Cursor value={value} clip={clip} edit={edit} />}
      {tab?.id === "callout" && <CalloutProps clip={clip} edit={edit} host={host} />}
      {tab?.id === "region" && <RegionProps clip={clip} value={value} edit={edit} />}
      {tab?.id === "caption" && <CaptionProps key={clip.id} clip={clip} project={project} host={host} />}
      {tab?.id === "broll" && <BrollTab key={clip.id} clip={clip} project={project} session={session} host={host} />}
      {tab?.id === "motion" && <MotionTab key={clip.id} clip={clip} project={project} session={session} host={host} />}
      {tab?.id === "audio" && (
        <Section>
          <Slider
            label="Volume"
            title="The level of the clip's volume line where the playhead is (drag the line on the timeline to change it there)"
            value={value("audio", "volume", 1) * 100}
            max={100}
            unit="%"
            onChange={(v, key) => edit("audio", { volume: v / 100 }, "Volume", key)}
          />
          <Slider
            label="Boost"
            title="Gain: makes a quiet recording louder, up to 500%, on top of the volume line"
            value={value("audio", "gain", 1) * 100}
            max={500}
            unit="%"
            onChange={(v, key) => edit("audio", { gain: v / 100 }, "Boost", key)}
          />
          <div className="ml-[92px] flex flex-col gap-3">
            <Check label="Mute" checked={!!propsOf<{ muted?: boolean }>(clip, "audio").muted} onChange={(on) => edit("audio", { muted: on }, on ? "Mute Clip" : "Unmute Clip")} />
            <Check label="Mix to mono" checked={false} disabled />
            <Check
              label="Auto-normalize loudness"
              checked={propsOf<{ normalize: boolean }>(clip, "audio").normalize}
              onChange={(on) => edit("audio", { normalize: on }, "Auto-normalize Loudness")}
            />
          </div>
        </Section>
      )}
      {tab?.id === "effects" && clip.effects.map((e) => (
          <Effect key={e.id} clip={clip} effect={e} host={host} def={init?.effects.find((x) => x.id === e.type)} selected={session.effects.some((x) => x.clip === clip.id && x.id === e.id)} />
        ))}
      <ClipId ids={selected.map((c) => c.id)} host={host} />
    </>
  );
}

/** The clip's id at the foot of its properties, to name it to an agent: a click copies it (all of them, with several selected). */
function ClipId({ ids, host }: { ids: string[]; host: Host }) {
  const text = copiedIds(ids);
  return (
    <div className="mt-auto flex justify-center px-4 pt-6 pb-3">
      <button
        data-clip-id
        title={ids.length > 1 ? "Copy these clips' ids, to name them to an agent" : "Copy this clip's id, to name it to an agent"}
        className="max-w-full truncate rounded-md bg-control px-2 py-0.5 font-mono text-label text-text-faint hover:text-text-muted"
        onClick={() => {
          host.copyText(text);
          replica.status(`Copied ${text}`);
        }}
      >
        {ids.length > 1 ? `${ids[0]} + ${ids.length - 1} more` : ids[0]}
      </button>
    </div>
  );
}

function Visual({ clip, project, value, edit, picture }: { clip: Clip; project: Project; value: (g: string, f: string, d?: number) => number; edit: Edit; picture: boolean }) {
  const size = contentSize(project, clip);
  const crop = (side: string) => value("crop", side);
  const sx = value("transform", "scaleX", 1);
  const sy = value("transform", "scaleY", 1);
  const cw = size ? size[0] - crop("left") - crop("right") : undefined;
  const ch = size ? size[1] - crop("top") - crop("bottom") : undefined;
  const degrees = (value("transform", "rotation") * 180) / Math.PI;
  const border = propsOf<{ thickness: number; color: RGBA }>(clip, "border");
  // Scale keeps the clip's aspect: the slider scales both axes.
  const setScale = (pct: number, key?: string) => edit("transform", { scaleX: pct / 100, scaleY: (pct / 100) * (sy / (sx || 1)) }, "Scale", key);
  return (
    <>
      <Section>
        <Slider label="Scale" value={sx * 100} max={400} unit="%" onChange={(v, key) => setScale(Math.max(1, v), key)} reset={() => setScale(100)} />
        <Slider label="Opacity" value={value("transform", "opacity", 1) * 100} max={100} unit="%" onChange={(v, key) => edit("transform", { opacity: v / 100 }, "Opacity", key)} />
      </Section>
      <Section>
        <div className="flex items-center justify-between">
          <span className="text-label font-medium text-text-muted">Rotation</span>
          <RotationGizmo
            value={{ x: (value("transform", "rotationX") * 180) / Math.PI, y: (value("transform", "rotationY") * 180) / Math.PI, z: degrees }}
            onChange={(axis, deg, key) => edit("transform", { [axis === "z" ? "rotation" : axis === "x" ? "rotationX" : "rotationY"]: (deg * Math.PI) / 180 }, "Rotation", key)}
          />
        </div>
      </Section>
      <Section>
        <div className="flex items-start justify-between">
          <span className="mt-1 text-label font-medium text-text-muted">Position</span>
          <div className="flex flex-col gap-2">
            <Stepper axis="X" value={value("transform", "x")} onChange={(v) => edit("transform", { x: v }, "Position")} />
            <Stepper axis="Y" value={value("transform", "y")} onChange={(v) => edit("transform", { y: v }, "Position")} />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-label font-medium text-text-muted">Size</span>
          <div className="flex flex-col gap-2">
            <Stepper axis="Width" value={cw === undefined ? undefined : cw * sx} onChange={cw ? (v) => edit("transform", { scaleX: Math.max(1, v) / cw }, "Size") : undefined} />
            <Stepper axis="Height" value={ch === undefined ? undefined : ch * sy} onChange={ch ? (v) => edit("transform", { scaleY: Math.max(1, v) / ch }, "Size") : undefined} />
          </div>
        </div>
      </Section>
      {picture && (
        <Section>
          <Slider unit="" label="Border" title="A border just inside the edge, following Round Corners: its thickness, 0 for none" value={border.thickness} max={100} onChange={(v, key) => edit("border", { thickness: Math.max(0, v) }, "Border", key)} />
          {/* No opacity of its own: beside the clip's, a second Opacity read as a duplicate that did nothing. */}
          <ColorRow label="Color" color={border.color} opacity={false} onChange={(color, key) => edit("border", { color }, "Border Color", key)} />
        </Section>
      )}
    </>
  );
}

/** The Clip Speed section: the speed, and the duration it gives as minutes, seconds and frames (editing it sets the speed). */
function ClipSpeed({ clip, selected, fps, host }: { clip: Clip; selected: Clip[]; fps: number; host: Host }) {
  const speed = clipSpeed(clip);
  // The selected clips only; a recording's other clips keep their speed unless they are selected too.
  const set = (v: number | null) => host.run("clip.speed", { clips: selected.map((c) => c.id), speed: v === null ? null : clamp(v, 0.1, 10), linked: false }, "Clip Speed");
  const perSecond = Math.round(fps);
  const frames = Math.round(ticksToSeconds(clip.duration) * fps);
  const [m, sec, f] = [Math.floor(frames / (perSecond * 60)), Math.floor(frames / perSecond) % 60, frames % perSecond];
  const media = ticksToSeconds(clip.duration) * speed;
  const setDuration = (mm: number, ss: number, ff: number) => {
    const seconds = mm * 60 + ss + ff / fps;
    if (seconds > 0) set(media / seconds);
  };
  return (
    <Section>
      <Row label="Speed">
        <div className="flex-1" />
        <NumberBox value={speed} unit="x" digits={2} step={0.1} min={0.1} max={10} onCommit={set} />
        <button title="Reset to 1x" className={`ml-1 text-text-muted hover:text-text-strong ${speed === 1 ? "invisible" : ""}`} onClick={() => set(null)}>
          ↺
        </button>
      </Row>
      <Row label="Duration">
        <div className="flex flex-1 justify-end gap-1.5">
          {(
            [
              ["Minutes", m, (v: number) => setDuration(v, sec, f), 999],
              ["Seconds", sec, (v: number) => setDuration(m, v, f), 59],
              ["Frames", f, (v: number) => setDuration(m, sec, v), perSecond - 1],
            ] as const
          ).map(([name, v, commit, max]) => (
            <label key={name} className="flex flex-col items-center gap-0.5 text-caption text-text-muted">
              <NumberBox value={v} digits={0} min={0} max={max} width={46} onCommit={commit} />
              {name}
            </label>
          ))}
        </div>
        <span className="ml-1 w-3" />
      </Row>
    </Section>
  );
}

/** Font families the user's projects use, listed first, then every installed family. */
const FONTS = ["Suisse Intl", "Montserrat", "SF Pro", "Helvetica Neue", "Menlo"];
const WEIGHTS: [number, string][] = [
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semibold"],
  [700, "Bold"],
];

/** Font and Weight rows: the families the user's projects use first, then every installed one (`installed`). */
function FontRows({ font, weight, installed, set, label }: { font: string; weight: number; installed?: string[]; set: (fields: { font?: string; weight?: number }, label: string) => void; label: string }) {
  return (
    <>
      <Row label="Font">
        <Select value={font} onChange={(e) => set({ font: e.target.value }, label)}>
          {[...new Set([font, ...FONTS])].map((f) => (
            <option key={f}>{f}</option>
          ))}
          {installed && (
            <optgroup label="All fonts">
              {installed.filter((f) => f !== font && !FONTS.includes(f)).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </optgroup>
          )}
        </Select>
      </Row>
      <Row label="Weight">
        <Select value={weight} onChange={(e) => set({ weight: Number(e.target.value) }, label)}>
          {(WEIGHTS.some(([w]) => w === weight) ? WEIGHTS : [...WEIGHTS, [weight, String(weight)] as [number, string]]).map(([w, name]) => (
            <option key={w} value={w}>
              {name}
            </option>
          ))}
        </Select>
      </Row>
    </>
  );
}

type Count = { from: number; to: number; seconds: number; decimals: number };
type CalloutProp = { shape: string; cornerRadius: number; count?: Count; fill?: RGBA; stroke?: { color: RGBA; width: number }; text?: { text: string; font: string; weight: number; size: number; color: RGBA; align: string } & Record<string, unknown> };

/** Annotation properties, what the user changes: text, font, size, colour; a shape's fill, outline and corners. */
function CalloutProps({ clip, edit, host }: { clip: Clip; edit: Edit; host: Host }) {
  const c = clip.props.callout as CalloutProp | undefined;
  const installed = useQuery<string[]>(host, "callout.fonts");
  const editing = useView((v) => v.editingText);
  if (!c) return null;
  const text = c.text;
  const setText = (fields: Partial<NonNullable<CalloutProp["text"]>>, label: string, key?: string) => edit("callout", { text: { ...text!, ...fields } }, label, key);
  return (
    <>
      {text && (
        <Section>
          <TextArea
            ref={(el) => {
              if (el && editing === clip.id) {
                el.focus();
                el.select();
                replica.editText(undefined);
              }
            }}
            className="mb-3 h-20 w-full"
            value={text.text}
            onChange={(e) => setText({ text: e.target.value }, "Edit Text", `text-${clip.id}`)}
          />
          <FontRows font={text.font} weight={text.weight} installed={installed} set={setText} label="Font" />
          <Slider unit="" label="Size" value={text.size} min={8} max={400} onChange={(v, key) => setText({ size: Math.max(8, v) }, "Font Size", key)} />
          <ColorRow label="Color" color={text.color} onChange={(color, key) => setText({ color }, "Text Color", key)} />
          <Row label="Align">
            <div className="flex gap-1">
              {(["left", "center", "right"] as const).map((a) => (
                <Button key={a} look={text.align === a ? "solid" : "quiet"} onClick={() => setText({ align: a }, "Alignment")}>
                  {a[0]!.toUpperCase() + a.slice(1)}
                </Button>
              ))}
            </div>
          </Row>
        </Section>
      )}
      {c.count && <CountRows count={c.count} set={(fields, label) => edit("callout", { count: { ...c.count!, ...fields } }, label)} />}
      {c.shape !== "text" && (
        <Section>
          <ColorRow label="Fill" color={c.fill} onChange={(fill, key) => edit("callout", { fill }, "Fill", key)} />
          <ColorRow label="Outline" color={c.stroke?.color} onChange={(color, key) => edit("callout", { stroke: { width: c.stroke?.width ?? 0, color } }, "Outline", key)} />
          <Slider unit="" label="Thickness" value={c.stroke?.width ?? 0} max={40} onChange={(width, key) => edit("callout", { stroke: { color: c.stroke?.color ?? [1, 1, 1, 1], width: Math.max(0, width) } }, "Outline", key)} />
          <Slider unit="" label="Corners" value={c.cornerRadius} max={200} onChange={(v, key) => edit("callout", { cornerRadius: Math.max(0, v) }, "Corner Radius", key)} />
        </Section>
      )}
    </>
  );
}

/** A counter's numbers: `{n}` in the text counts from From to To over Seconds. */
function CountRows({ count, set }: { count: Count; set: (fields: Partial<Count>, label: string) => void }) {
  return (
    <Section>
      <div className="mb-3 font-semibold text-text-strong">Count</div>
      <Row label="From" title="The number shown as the clip starts">
        <div className="flex-1" />
        <NumberBox value={count.from} digits={count.decimals} onCommit={(from) => set({ from }, "Count From")} />
      </Row>
      <Row label="To" title="The number it counts up (or down) to">
        <div className="flex-1" />
        <NumberBox value={count.to} digits={count.decimals} onCommit={(to) => set({ to }, "Count To")} />
      </Row>
      <Row label="Seconds" title="How long it takes, from the clip's start">
        <div className="flex-1" />
        <NumberBox value={count.seconds} unit=" s" digits={2} min={0} onCommit={(seconds) => set({ seconds: Math.max(0, seconds) }, "Count Length")} />
      </Row>
      <Row label="Decimals">
        <div className="flex-1" />
        <NumberBox value={count.decimals} digits={0} min={0} max={4} onCommit={(v) => set({ decimals: Math.round(Math.min(4, Math.max(0, v))) }, "Count Decimals")} />
      </Row>
    </Section>
  );
}

/** Align to page: each button puts the captions against an edge, or in the middle, at the usual distance. */
const ALIGN: { label: string; icon: IconName; fields: (margin: number) => Partial<CaptionStyle> }[] = [
  { label: "Top", icon: "align-top", fields: (m) => ({ anchorY: "top", offsetY: m }) },
  { label: "Left", icon: "align-left", fields: (m) => ({ anchorX: "left", offsetX: m }) },
  { label: "Middle", icon: "align-center-vertical", fields: () => ({ anchorY: "middle", offsetY: 0 }) },
  { label: "Centre", icon: "align-center-horizontal", fields: () => ({ anchorX: "center", offsetX: 0 }) },
  { label: "Bottom", icon: "align-bottom", fields: (m) => ({ anchorY: "bottom", offsetY: m }) },
  { label: "Right", icon: "align-right", fields: (m) => ({ anchorX: "right", offsetX: m }) },
];

/** The caption's words, then how every caption looks: one style for all of them (`captions.style`). */
function CaptionProps({ clip, project, host }: { clip: Clip; project: Project; host: Host }) {
  const installed = useQuery<string[]>(host, "callout.fonts");
  const [draft, setDraft] = useState<string>();
  // One style for all the captions on a track, kept on the track.
  const style = project.tracks.find((t) => t.clips.some((c) => c.id === clip.id))?.props?.captionStyle as CaptionStyle | undefined;
  if (!style) return null;
  const words = wordsInWindow(clip, (clip.props.caption as { words?: { text: string; start: number; end: number }[] } | undefined)?.words ?? []);
  const text = words.map((w) => w.text).join(" ");
  // Typed into a draft and set on leaving the field or Return: the words are re-timed from the whole text.
  const commit = () => {
    if (draft !== undefined && draft.trim() && draft !== text) host.run("caption.setText", { clip: clip.id, text: draft }, "Edit Caption");
    setDraft(undefined);
  };
  const set = (fields: Partial<CaptionStyle>, label: string, key?: string) => host.run("captions.style", { style: fields }, label, key);
  const own = clip.props.captionPlace as Partial<CaptionStyle> | undefined;
  const place = { ...style, ...own };
  // Align to page moves a caption placed on its own by itself, else every caption.
  const align = (fields: Partial<CaptionStyle>) => (own ? host.run("caption.place", { clip: clip.id, place: fields }, "Align Caption") : set(fields, "Align Captions"));
  return (
    <>
      <Section>
        <TextArea
          className="h-16 w-full"
          value={draft ?? text}
          title="What this caption says: Return or leaving the field sets it"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") setDraft(undefined);
          }}
        />
      </Section>
      <Section>
        <div className="mb-3 text-label text-text-faint">Every caption</div>
        <FontRows font={style.font} weight={style.weight} installed={installed} set={set} label="Caption Font" />
        <Slider unit="" label="Size" value={style.size} min={12} max={200} onChange={(v, key) => set({ size: Math.max(12, v) }, "Caption Size", key)} />
        <ColorRow label="Color" color={style.color} onChange={(color, key) => set({ color }, "Caption Color", key)} />
        <ColorRow label="Highlight" color={style.highlight} onChange={(highlight, key) => set({ highlight }, "Caption Highlight", key)} />
        <div className="ml-[92px] mb-3 text-caption text-text-faint">The word being spoken; transparent for none</div>
        <ColorRow label="Box" color={style.background} onChange={(background, key) => set({ background }, "Caption Box", key)} />
        <Slider unit="" label="Corners" value={style.cornerRadius} max={60} onChange={(v, key) => set({ cornerRadius: Math.max(0, v) }, "Caption Corners", key)} />
        <div className="mt-3 ml-[92px]">
          <Check label="All capitals" checked={style.uppercase} onChange={(uppercase) => set({ uppercase }, "Caption Capitals")} />
        </div>
      </Section>
      <Section>
        {own && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-groove px-3 py-2 text-label text-text" data-caption-own>
            This caption has its own position
            <Button look="quiet" onClick={() => host.run("caption.place", { clip: clip.id, place: null }, "Use Shared Position")}>
              Use shared
            </Button>
          </div>
        )}
        <div className="mb-2 text-label text-text-faint">Align to page</div>
        <div className="mb-3 grid grid-cols-2 gap-1.5" data-caption-align>
          {ALIGN.map((a) => {
            const fields = a.fields(Math.round((80 * project.settings.height) / 1080));
            const on = Object.entries(fields).every(([k, v]) => place[k as keyof CaptionStyle] === v);
            return (
              <Button key={a.label} look={on ? "solid" : "quiet"} title={`Align ${own ? "this caption" : "the captions"} to the ${a.label.toLowerCase()} of the canvas`} onClick={() => align(fields)}>
                <span className="flex items-center gap-2">
                  <Icon name={a.icon} size={16} />
                  {a.label}
                </span>
              </Button>
            );
          })}
        </div>
        <div className="mb-3 text-caption text-text-faint">Drag a caption to move them all. ⌥-drag moves this one alone; ⌥⇧ moves it and the captions after it.</div>
        <Slider unit="%" label="Width" value={style.maxWidth * 100} min={20} max={100} onChange={(v, key) => set({ maxWidth: Math.min(1, Math.max(0.2, v / 100)) }, "Caption Width", key)} />
      </Section>
    </>
  );
}

/** Blur, Pixelate and Spotlight show only the intensity. */
function RegionProps({ clip, value, edit }: { clip: Clip; value: (g: string, f: string, d?: number) => number; edit: Edit }) {
  const kind = (clip.props.region as { kind?: string } | undefined)?.kind;
  // Spotlight darkens 0-100%; blur is a radius and pixelate a block size, shown as 0-100; a highlight's is its opacity.
  const scale = kind === "blur" ? 10 : 100;
  const region = clip.props.region as { invert?: boolean; color?: RGBA } | undefined;
  return (
    <Section>
      {kind === "highlight" && <ColorRow label="Color" color={region?.color} opacity={false} onChange={(c, key) => edit("region", { color: c }, "Highlight Color", key)} />}
      {kind === "highlight" ? (
        <Slider unit="%" label="Opacity" value={value("region", "intensity") * 100} max={100} onChange={(v, key) => edit("region", { intensity: Math.max(0, v) / 100 }, "Highlight Opacity", key)} />
      ) : (
        <Slider unit="" label="Intensity" value={value("region", "intensity") * scale} max={100} onChange={(v, key) => edit("region", { intensity: Math.max(0, v) / scale }, "Intensity", key)} />
      )}
      <Slider unit="" label="Corners" value={value("region", "cornerRadius")} max={200} onChange={(v, key) => edit("region", { cornerRadius: Math.max(0, v) }, "Corner Radius", key)} />
      {kind !== "spotlight" && (
        <div className="ml-[92px]">
          <Check label="Invert" title={kind === "highlight" ? "Colour everything outside the box instead" : "Work on everything outside the box instead"} checked={!!region?.invert} onChange={(on) => edit("region", { invert: on }, on ? "Invert" : "Don't Invert")} data-region-invert />
        </div>
      )}
    </Section>
  );
}

function Cursor({ value, clip, edit }: { value: (g: string, f: string, d?: number) => number; clip: Clip; edit: Edit }) {
  const smooth = propsOf<{ smoothAcrossEdits: number }>(clip, "cursor").smoothAcrossEdits;
  return (
    <Section>
      <Slider label="Scale" value={value("cursor", "scale", 1) * 100} max={1000} unit="%" onChange={(v, key) => edit("cursor", { scale: Math.max(1, v) / 100 }, "Cursor Scale", key)} />
      <Slider label="Opacity" value={value("cursor", "opacity", 1) * 100} max={100} unit="%" onChange={(v, key) => edit("cursor", { opacity: v / 100 }, "Cursor Opacity", key)} />
      <div className="mt-3">
        <Check label="Smooth cursor across edits" checked={smooth > 0} onChange={(on) => edit("cursor", { smoothAcrossEdits: on ? 1 : 0 }, "Smooth Cursor Across Edits")} />
      </div>
    </Section>
  );
}

/** Every hue at full saturation, 0° to 360°, as a hue parameter's slider groove. */
const HUES = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

type JsonSchema = {
  type?: string | string[];
  /** A medium of the project of this kind (an image), by asset id; null for none. */
  asset?: string;
  /** For a file asset: the extensions it takes, and a Choose… button that imports one. */
  extensions?: string[];
  /** Shown only while the other params named have these values (Remove Background's blur with background "blur"). */
  when?: Record<string, unknown>;
  slider?: { min?: number; max: number }; percent?: boolean; degrees?: boolean; hue?: boolean; color?: boolean; minimum?: number; maximum?: number; exclusiveMinimum?: number; enum?: unknown[]; properties?: Record<string, JsonSchema>; pattern?: string };

/** An effect's params as controls generated from its schema (PLAN §2.6), with on/off and remove. */
function Effect({ clip, effect, host, def, selected }: { clip: Clip; effect: EffectInstance; host: Host; def?: Init["effects"][number]; selected: boolean }) {
  const fields = (def?.schema as JsonSchema | undefined)?.properties ?? {};
  const name = def?.title ?? effect.type;
  const set = (params: Record<string, unknown>, key?: string) => host.run("effect.set", { clip: clip.id, effect: effect.id, params }, name, key);
  /** Why the look file last chosen couldn't be read. */
  const [importError, setImportError] = useState<string>();
  /** Why the file last chosen for a file param (a LUT) couldn't be imported. */
  const [chooseError, setChooseError] = useState<string>();
  // Files imported before (`importFile.keep`), in every project, after the built-ins.
  const keep = def?.importFile?.keep;
  const keptText = useView((s) => (keep ? s.preferences.find((p) => p.id === keep)?.value : undefined));
  const kept = useMemo(() => {
    const parsed = KeptLooksSchema.safeParse((() => { try { return JSON.parse(keptText || "[]"); } catch { return []; } })());
    return parsed.success ? parsed.data : [];
  }, [keptText]);
  const looks = [...(def?.presets ?? []).map((p) => ({ ...p, group: undefined as string | undefined })), ...kept.map((l) => ({ id: l.id, title: l.name, params: l.params, description: undefined as string | undefined, group: "Your looks" }))];
  const preset = looks.find((p) => Object.entries(p.params).every(([k, v]) => effect.params[k] === v));
  const assets = useView((s) => s.project?.assets);
  // What the effect needs of the clip's media (a matte) while it is made, or why it couldn't be.
  const making = useView((s) => (clip.assetId ? def?.needs?.map((n) => s.analyzing[`${n}:${clip.assetId}`]).find((p) => p !== undefined) : undefined));
  const failed = useView((s) => (clip.assetId ? def?.needs?.map((n) => s.analysisFailed[`${n}:${clip.assetId}`]).find(Boolean) : undefined));
  // The sliders as they are, kept as a look of the user's own, named to rename in Settings › General.
  const saveLook = () => {
    const taken = new Set(kept.map((l) => l.name));
    let n = 1;
    while (taken.has(`My Look ${n}`)) n++;
    const look = { id: `look-${Date.now().toString(36)}`, name: `My Look ${n}`, params: { ...effect.params } };
    void host.setPreference(keep!, JSON.stringify([...kept, look]));
    replica.status(`Saved as "${look.name}" in Your looks, for every project; rename it in Settings › General`);
  };
  const importLook = async () => {
    const path = await host.chooseFile(def!.importFile!.extensions);
    if (!path) return;
    try {
      const look = (await host.query(def!.importFile!.query, { path })) as { name: string; params: Record<string, unknown>; notReproduced?: string[] };
      host.run("effect.set", { clip: clip.id, effect: effect.id, params: look.params }, `Import ${look.name}`);
      setImportError(undefined);
      if (keep) {
        // Kept for every project; one of the same name gives way.
        const entry = { id: `look-${Date.now().toString(36)}`, name: look.name, params: look.params, ...(look.notReproduced?.length ? { notes: look.notReproduced } : {}) };
        void host.setPreference(keep, JSON.stringify([...kept.filter((l) => l.name !== look.name), entry]));
      }
    } catch (e) {
      setImportError(`${path.split("/").pop()}: ${(e as Error).message}`);
    }
  };
  return (
    <div data-effect={effect.id}>
    <FoldSection
      title={name}
      selected={selected}
      selectHint="Select the effect (⇧ or ⌘ for several): ⌘C copies it, Delete removes it"
      onSelect={(e) => host.run("effect.select", { effects: [{ clip: clip.id, id: effect.id }], add: e.shiftKey || e.metaKey })}
      action={keep ? { icon: "floppy-disk", label: "Save these settings as a look of your own, for every project", run: saveLook, disabled: preset ? `These settings are ${preset.title} already` : undefined } : undefined}
      remove={{ label: "Remove Effect", run: () => host.run("effect.remove", { clip: clip.id, effect: effect.id }, `Remove ${name}`) }}
      enabled={effect.enabled}
      onEnable={(on) => host.run("effect.set", { clip: clip.id, effect: effect.id, enabled: on }, on ? `Enable ${name}` : `Disable ${name}`)}
    >
          {(def?.presets || def?.importFile) && (
            <Row label="Look">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {looks.length > 0 && (
                  <ListSelect
                    value={preset?.id ?? ""}
                    title={preset?.description}
                    options={[{ id: "", label: "Custom" }, ...looks.map((p) => ({ id: p.id, label: p.title, title: p.description, group: p.group }))]}
                    onPreview={(id) => {
                      const p = looks.find((x) => x.id === id);
                      host.previewEffect(p ? { clip: clip.id, effect: effect.id, params: p.params } : null);
                    }}
                    onChange={(id) => {
                      const p = looks.find((x) => x.id === id);
                      if (p) {
                        host.run("effect.set", { clip: clip.id, effect: effect.id, params: p.params }, p.title);
                        setImportError(undefined);
                      }
                      host.previewEffect(null);
                    }}
                    data-effect-preset
                  />
                )}
                {def.importFile && (
                  <Button look="quiet" title={`Read a look from a .${def.importFile.extensions[0]} file onto these sliders`} onClick={() => void importLook()} data-effect-import>
                    {def.importFile.label}
                  </Button>
                )}
              </div>
            </Row>
          )}
          {importError && (
            <div className="mb-2 ml-[92px] text-label text-danger" data-effect-import-error>
              {importError}
            </div>
          )}
          {def?.tune && (
            <Row label="">
              <div className="flex min-w-0 flex-1 items-center" data-effect-tune>
                <Button title={def.tune.title} onClick={() => host.run(def.tune!.action, { clip: clip.id, effect: effect.id })} data-effect-tune-run>
                  {def.tune.label}
                </Button>
              </div>
            </Row>
          )}
          {chooseError && (
            <div className="mb-2 ml-[92px] text-label text-danger" data-effect-choose-error>
              {chooseError}
            </div>
          )}
          {making !== undefined && (
            <div className="mb-2 ml-[92px] text-label text-text-faint" data-effect-preparing>
              {def?.preparing ?? "Preparing"}… {Math.round(making * 100)}%
            </div>
          )}
          {failed && making === undefined && (
            <div className="mb-2 ml-[92px] text-label text-danger" data-effect-failed>
              {def?.preparing ?? "Preparing"} failed: {failed}
            </div>
          )}
          {[...Object.keys(fields).filter((k) => k in effect.params), ...Object.keys(effect.params).filter((k) => !(k in fields))].map((k) => {
            const v = effect.params[k];
            const f = fields[k] ?? {};
            if (f.when && Object.entries(f.when).some(([o, want]) => effect.params[o] !== want)) return null;
            const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
            if (typeof v === "boolean") return <div key={k} className="mb-2 ml-[92px]"><Check label={label} checked={v} onChange={(on) => set({ [k]: on })} /></div>;
            if (typeof v === "number") {
              const min = f.slider?.min ?? f.minimum ?? f.exclusiveMinimum ?? 0;
              const max = f.slider?.max ?? f.maximum;
              if (f.degrees) {
                const deg = (((v * 180) / Math.PI) % 360 + 360) % 360;
                return <Slider key={k} label={label} value={Math.round(deg)} max={360} unit="°" onChange={(x, key) => set({ [k]: (x * Math.PI) / 180 }, key)} />;
              }
              if (f.hue) return <Slider key={k} label={label} value={Math.round(v)} max={360} unit="°" digits={0} groove={HUES} onChange={(x, key) => set({ [k]: x }, key)} />;
              if (max !== undefined && f.percent) return <Slider key={k} label={label} value={v * 100} min={min * 100} max={max * 100} unit="%" onChange={(x, key) => set({ [k]: x / 100 }, key)} />;
              if (max !== undefined) {
                const whole = f.type === "integer";
                return <Slider key={k} label={label} value={v} min={min} max={max} unit="" step={whole ? 1 : (max - min) / 200} digits={whole ? 0 : 2} onChange={(x, key) => set({ [k]: x }, key)} />;
              }
              return (
                <Row key={k} label={label}>
                  <div className="flex-1" />
                  <NumberBox value={v} onCommit={(x) => set({ [k]: Math.max(min, x) })} />
                </Row>
              );
            }
            if (f.enum) {
              return (
                <Row key={k} label={label}>
                  <Select value={String(v)} onChange={(e) => set({ [k]: e.target.value })} data-effect-param={k}>
                    {f.enum.map((o) => (
                      <option key={String(o)} value={String(o)}>
                        {String(o).replace(/^./, (c) => c.toUpperCase())}
                      </option>
                    ))}
                  </Select>
                </Row>
              );
            }
            if (f.asset) {
              const exts = f.extensions;
              const choices = Object.values(assets ?? {}).filter((a) => a.kind === f.asset && (!exts || exts.some((x) => a.path.toLowerCase().endsWith(`.${x}`))));
              const choose = async () => {
                const path = await host.chooseFile(exts!);
                if (!path) return;
                const r = await host.importFile(path);
                if (r.ok && r.result) set({ [k]: r.result });
                setChooseError(r.ok ? undefined : (r.error ?? `${path.split("/").pop()} couldn't be read`));
              };
              return (
                <Row key={k} label={label}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Select value={typeof v === "string" ? v : ""} onChange={(e) => set({ [k]: e.target.value || null })} data-effect-param={k}>
                      <option value="">{choices.length ? "None" : exts ? "None chosen" : `No ${f.asset}s in the Media Bin`}</option>
                      {choices.map((a) => (
                        <option key={a.id} value={a.id}>
                          {assetName(a)}
                        </option>
                      ))}
                    </Select>
                    {exts && (
                      <Button look="quiet" title={`Pick a .${exts[0]} file; it is copied into the project`} onClick={() => void choose()} data-effect-choose={k}>
                        Choose…
                      </Button>
                    )}
                  </div>
                </Row>
              );
            }
            if (typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) {
              return (
                <Row key={k} label={label}>
                  <ColorSwatch color={fromHex(v)!} title={label} onChange={(c, key) => set({ [k]: formatColor(c) }, key)} />
                </Row>
              );
            }
            if (f.color && Array.isArray(v)) {
              return (
                <Row key={k} label={label}>
                  <ColorSwatch color={v as RGBA} title={label} onChange={(c, key) => set({ [k]: c }, key)} />
                </Row>
              );
            }
            return <Row key={k} label={label}><span className="truncate text-text-muted">{JSON.stringify(v)}</span></Row>;
          })}
    </FoldSection>
    </div>
  );
}

/** The selected animation arrow: its easing and length, and removing it. */
function AnimationSection({ clip, id, host }: { clip: Clip; id: string; host: Host }) {
  const anim = clip.animations.find((a) => a.id === id);
  if (!anim) return null;
  const speed = clip.speed ? clip.speed.num / clip.speed.den : 1;
  const seconds = anim.duration / 705_600_000 / speed;
  return (
    <Section>
      <div className="mb-3 flex items-center">
        <span className="flex-1 font-semibold text-text-strong">Animation</span>
        <TrashButton label="Delete the animation (⌫)" onClick={() => host.run("animation.remove", { clip: clip.id, animation: id }, "Delete Animation")} />
      </div>
      <Row label="Easing">
        <Select
          value={anim.easing}
          data-animation-easing
          onChange={(e) => {
            host.run("animation.set", { clip: clip.id, animation: id, easing: e.target.value }, "Animation Easing");
            // New animations take the easing last picked, until another is.
            void host.setPreference("animationEasing", e.target.value);
          }}
        >
          {EASINGS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Duration">
        <div className="flex-1" />
        <NumberBox value={seconds} unit=" s" onCommit={(v) => v > 0 && host.run("animation.set", { clip: clip.id, animation: id, duration: v }, "Animation Duration")} />
      </Row>
    </Section>
  );
}
