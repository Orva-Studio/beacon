import type { ReactNode } from "react";
import type { Clip, EffectInstance, Project, Session } from "@beacon/model";
import { clipSpeed, rationalToNumber, ticksToSeconds } from "@beacon/model";
import type { Host } from "./app";
import { contentSize, valueAt } from "./canvas";
import type { Init } from "./rpc";
import { timelineView } from "./timeline";
import { Button, Check, clamp, ColorRow, ColorSwatch, FoldSection, fromHex, NumberBox, Row, Section, Select, Slider, Stepper, Tab, TextArea, toHex, TrashButton, Icon, type IconName, type RGBA, RotationGizmo } from "./controls";
import { replica, useView } from "./store";
import { effectName } from "./effect-names";
import { useQuery } from "./query";

/**
 * The properties panel: icon tabs, the clip's name, then the tab's
 * controls, showing values at the playhead. Edits apply to every selected
 * clip at the playhead (`clip.set` with `at`); a slider drag is one undo step.
 */
export function Properties({ project: full, session, host, init }: { project: Project; session: Session; host: Host; init?: Init }) {
  // With a group open, its clips are the ones being edited, shown at main-timeline times.
  const { project } = timelineView(full, session, init?.nested ?? {});
  const all = project.tracks.flatMap((t) => t.clips);
  const selected = session.selection.map((id) => all.find((c) => c.id === id)).filter((c): c is Clip => !!c);
  const clip = selected[0];
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto text-body">
      {!clip ? (
        <div className="p-4 text-center text-text-faint">{session.selection.length ? "Selection is not on the timeline" : "Select media on the timeline to see its properties"}</div>
      ) : (
        <ClipProperties project={project} session={session} clip={clip} selected={selected} host={host} init={init} />
      )}
    </div>
  );
}

type Tab = { id: string; title: string; icon: IconName };

/** The tabs a clip type's traits give it, in order. */
const TRAIT_TABS: [trait: string, tab: Tab][] = [
  ["visual", { id: "transform", title: "Visual Properties", icon: "film-strip" }],
  ["callout", { id: "callout", title: "Annotation Properties", icon: "chat-centered-text" }],
  ["region", { id: "region", title: "Annotation Properties", icon: "chat-centered-text" }],
  ["cursor", { id: "cursor", title: "Cursor Properties", icon: "pointer" }],
  ["audio", { id: "audio", title: "Audio Properties", icon: "speaker-high" }],
];

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
  const tabs = TRAIT_TABS.filter(([trait]) => traits.includes(trait)).map(([, tab]) => tab);
  const speedShown = useView((v) => v.clipSpeed);
  // Speed is the clip's timing, video and audio alike: its own tab once it has been changed or asked for.
  if ((clip.assetId || traits.includes("stitched")) && (clipSpeed(clip) !== 1 || speedShown.includes(clip.id))) tabs.push({ id: "speed", title: "Clip Speed", icon: "gauge" });
  if (clip.effects.length) tabs.push({ id: "effects", title: "Effects", icon: "sparkle" });
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
      {tab?.id === "transform" && <Visual clip={clip} project={project} value={value} edit={edit} />}
      {tab?.id === "speed" && (
        <ClipSpeed clip={clip} selected={selected} fps={rationalToNumber(project.settings.fps)} host={host} />
      )}
      {tab?.id === "cursor" && <Cursor value={value} clip={clip} edit={edit} />}
      {tab?.id === "callout" && <CalloutProps clip={clip} edit={edit} host={host} />}
      {tab?.id === "region" && <RegionProps clip={clip} value={value} edit={edit} />}
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
            <Check label="Mix to mono" checked={false} disabled />
            <Check
              label="Auto-normalize loudness"
              checked={Boolean((clip.props.audio as { normalize?: boolean } | undefined)?.normalize)}
              onChange={(on) => edit("audio", { normalize: on }, "Auto-normalize Loudness")}
            />
          </div>
        </Section>
      )}
      {tab?.id === "effects" && clip.effects.map((e) => (
          <Effect key={e.id} clip={clip} effect={e} host={host} schema={init?.effects.find((x) => x.id === e.type)?.schema} selected={session.effects.some((x) => x.clip === clip.id && x.id === e.id)} />
        ))}
    </>
  );
}

function Visual({ clip, project, value, edit }: { clip: Clip; project: Project; value: (g: string, f: string, d?: number) => number; edit: Edit }) {
  const size = contentSize(project, clip);
  const crop = (side: string) => value("crop", side);
  const sx = value("transform", "scaleX", 1);
  const sy = value("transform", "scaleY", 1);
  const cw = size ? size[0] - crop("left") - crop("right") : undefined;
  const ch = size ? size[1] - crop("top") - crop("bottom") : undefined;
  const degrees = (value("transform", "rotation") * 180) / Math.PI;
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

type CalloutProp = { shape: string; cornerRadius: number; fill?: RGBA; stroke?: { color: RGBA; width: number }; text?: { text: string; font: string; weight: number; size: number; color: RGBA; align: string } & Record<string, unknown> };

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
          <Row label="Font">
            <Select value={text.font} onChange={(e) => setText({ font: e.target.value }, "Font")}>
              {[...new Set([text.font, ...FONTS])].map((f) => (
                <option key={f}>{f}</option>
              ))}
              {installed && (
                <optgroup label="All fonts">
                  {installed.filter((f) => f !== text.font && !FONTS.includes(f)).map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Row>
          <Row label="Weight">
            <Select value={text.weight} onChange={(e) => setText({ weight: Number(e.target.value) }, "Font")}>
              {(WEIGHTS.some(([w]) => w === text.weight) ? WEIGHTS : [...WEIGHTS, [text.weight, String(text.weight)] as [number, string]]).map(([w, name]) => (
                <option key={w} value={w}>
                  {name}
                </option>
              ))}
            </Select>
          </Row>
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

/** Blur, Pixelate and Spotlight show only the intensity. */
function RegionProps({ clip, value, edit }: { clip: Clip; value: (g: string, f: string, d?: number) => number; edit: Edit }) {
  const kind = (clip.props.region as { kind?: string } | undefined)?.kind;
  // Spotlight darkens 0-100%; blur is a radius and pixelate a block size, shown as 0-100.
  const scale = kind === "blur" ? 10 : 100;
  return (
    <Section>
      <Slider unit="" label="Intensity" value={value("region", "intensity") * scale} max={100} onChange={(v, key) => edit("region", { intensity: Math.max(0, v) / scale }, "Intensity", key)} />
      <Slider unit="" label="Corners" value={value("region", "cornerRadius")} max={200} onChange={(v, key) => edit("region", { cornerRadius: Math.max(0, v) }, "Corner Radius", key)} />
    </Section>
  );
}

function Cursor({ value, clip, edit }: { value: (g: string, f: string, d?: number) => number; clip: Clip; edit: Edit }) {
  const smooth = (clip.props.cursor as { smoothAcrossEdits?: number } | undefined)?.smoothAcrossEdits ?? 0;
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

type JsonSchema = { type?: string; slider?: { min?: number; max: number }; percent?: boolean; color?: boolean; minimum?: number; maximum?: number; exclusiveMinimum?: number; enum?: unknown[]; properties?: Record<string, JsonSchema>; pattern?: string };

/** An effect's params as controls generated from its schema (PLAN §2.6), with on/off and remove. */
function Effect({ clip, effect, host, schema, selected }: { clip: Clip; effect: EffectInstance; host: Host; schema?: Record<string, unknown>; selected: boolean }) {
  const fields = (schema as JsonSchema | undefined)?.properties ?? {};
  const name = effectName(effect.type);
  const set = (params: Record<string, unknown>, key?: string) => host.run("effect.set", { clip: clip.id, effect: effect.id, params }, name, key);
  return (
    <FoldSection
      title={name}
      selected={selected}
      selectHint="Select the effect (⇧ or ⌘ for several): ⌘C copies it, Delete removes it"
      onSelect={(e) => host.run("effect.select", { effects: [{ clip: clip.id, id: effect.id }], add: e.shiftKey || e.metaKey })}
      remove={{ label: "Remove Effect", run: () => host.run("effect.remove", { clip: clip.id, effect: effect.id }, `Remove ${name}`) }}
      enabled={effect.enabled}
      onEnable={(on) => host.run("effect.set", { clip: clip.id, effect: effect.id, enabled: on }, on ? `Enable ${name}` : `Disable ${name}`)}
    >
          {Object.entries(effect.params).map(([k, v]) => {
            const f = fields[k] ?? {};
            const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
            if (typeof v === "boolean") return <div key={k} className="mb-2 ml-[92px]"><Check label={label} checked={v} onChange={(on) => set({ [k]: on })} /></div>;
            if (typeof v === "number") {
              const min = f.slider?.min ?? f.minimum ?? f.exclusiveMinimum ?? 0;
              const max = f.slider?.max ?? f.maximum;
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
                  <Select value={String(v)} onChange={(e) => set({ [k]: e.target.value })}>
                    {f.enum.map((o) => <option key={String(o)}>{String(o)}</option>)}
                  </Select>
                </Row>
              );
            }
            if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) {
              return (
                <Row key={k} label={label}>
                  <ColorSwatch color={fromHex(v)!} title={label} onChange={(c, key) => set({ [k]: toHex(c) }, key)} />
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
          onChange={(e) => host.run("animation.set", { clip: clip.id, animation: id, easing: e.target.value }, "Animation Easing")}
        >
          <option value="easeInOut">Ease in and out</option>
          <option value="linear">Linear</option>
        </Select>
      </Row>
      <Row label="Duration">
        <div className="flex-1" />
        <NumberBox value={seconds} unit=" s" onCommit={(v) => v > 0 && host.run("animation.set", { clip: clip.id, animation: id, duration: v }, "Animation Duration")} />
      </Row>
    </Section>
  );
}
