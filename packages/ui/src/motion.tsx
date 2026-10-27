import { useEffect, useMemo, useState } from "react";
import type { Clip, Project, Session } from "@beacon/model";
import type { CustomStyle, Look, MotionProps, MotionState } from "@beacon/features";
import { Button, Section, Segmented, Select, TextArea } from "./controls";
import { MotionCode } from "./motion-code";
import { useOnline } from "./online";
import { useQuery } from "./query";
import { useView } from "./store";
import type { Host } from "./app";

export const motionStateOf = (s: Session | undefined) => (s?.features.motion as MotionState | undefined) ?? { writing: [], making: [], errors: {} };

/** A motion graphics clip with nothing made yet: its box shows on the canvas, nothing in an export. */
export const isEmptyMotion = (c: Clip) => c.type === "motion" && !c.assetId;

/** The Skill menu's last item: Import Skill… */
const IMPORT_SKILL = "\u0000import";

/** Images a reference can be: motion.refer's. */
const REFERENCE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

/** What a Make by OpenAI or Claude is likely to cost: the average of the project's Makes by it so far, else a typical one. */
function typicalCost(project: Project, by: string): number {
  const costs = project.tracks
    .flatMap((t) => t.clips)
    .flatMap((c) => (c.type === "motion" ? (c.props.motion as MotionProps).takes.flatMap((t) => (t.cost && (t.by ?? "openai") === by ? [t.cost] : [])) : []));
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : by === "claude" ? 0.3 : 0.15;
}

/** A take in the Take menu: its prompt, in a few words. */
const takeName = (t: MotionProps["takes"][number]) => (t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}…` : t.prompt) || "Untitled";

/** Clips waiting to be drawn again after their style changed: a colour dragged draws once, when it settles. */
const redraws = new Map<string, ReturnType<typeof setTimeout>>();

/** A style change, then the clips made drawn again in it (motion.render), once changes stop for a moment. */
function restyle(host: Host, clips: Clip[], style: { look?: string; timing?: string }, label: string, key?: string) {
  host.run("motion.style", { clips: clips.map((c) => c.id), ...style }, label, key);
  const made = clips.filter((c) => (c.props.motion as MotionProps).shown >= 0).map((c) => c.id);
  if (!made.length) return;
  const id = made.join();
  clearTimeout(redraws.get(id));
  redraws.set(
    id,
    setTimeout(() => {
      redraws.delete(id);
      host.run("motion.render", { clips: made });
    }, 600),
  );
}

/**
 * A motion graphics clip's tab: its prompt (written from the words under it, or typed), making it (or again), and the
 * takes made, to pick one again.
 */
export function MotionTab({ clip, project, session, host }: { clip: Clip; project: Project; session: Session; host: Host }) {
  const m = clip.props.motion as MotionProps;
  const state = motionStateOf(session);
  const writing = state.writing.includes(clip.id);
  const making = state.making.includes(clip.id);
  const busy = writing || making;
  const error = state.errors[clip.id];
  const [manual, setManual] = useState(m.manual);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  // A change asked for is done once its take arrives.
  useEffect(() => setNote(""), [m.takes.length, clip.id]);
  useEffect(() => setManual(m.manual), [m.manual]);
  const planner = useView((v) => v.preferences.find((p) => p.id === "motionPlanner")?.value);
  const online = useOnline();
  const needsNet = planner !== "apple" && !online;
  const offline = `Needs the internet: you're offline (${planner === "claude" ? "Claude" : "OpenAI"} makes it)`;
  const settingsOpen = useView((v) => !!v.settings);
  const auto = m.source === "auto";
  const set = (fields: Partial<MotionProps>, label: string) => host.run("clip.set", { clip: clip.id, props: { motion: fields } }, label);
  const transcribing = useView((v) => Object.keys(v.transcribing).join());
  const again = useMemo(() => ({}), [clip.start, clip.duration, transcribing]);
  const said = useQuery<string>(host, "broll.words", { clip: clip.id }, again);
  const prompted = !!(auto ? m.prompt : manual).trim() || !!said;
  const looks = useQuery<Look[]>(host, "motion.looks");
  const look = looks?.find((l) => l.id === m.look);
  const reference = m.reference ? project.assets[m.reference] : undefined;
  const by = m.takes[m.shown]?.by;
  const designed = by === "openai" || by === "claude" || by === "you";
  const cost = typicalCost(project, planner ?? "openai");
  const skills = useQuery<CustomStyle[]>(host, "motion.skills", {}, useView((v) => v.preferences.find((p) => p.id === "motionSkills")?.value)) ?? [];
  const skill = skills.find((k) => k.id === m.skill);
  const [skillError, setSkillError] = useState<string>();
  const pickSkill = (id: string | null) => {
    host.run("motion.style", { clips: [clip.id], skill: id }, "Motion Graphics Skill");
    // New motion graphics take the skill last picked, as they do the Look.
    void host.setPreference("motionSkill", JSON.stringify(id ?? ""));
  };
  // A skill read from a file joins the list kept for every project (one of the same name is replaced), then is picked.
  const importSkill = async () => {
    const path = await host.chooseFile(["md", "markdown", "txt"]);
    if (!path) return;
    try {
      const read = (await host.query("motion.readSkill", { path })) as { name: string; text: string };
      const same = skills.find((k) => k.name === read.name);
      const id = same?.id ?? `skill-${Date.now().toString(36)}`;
      const list = same ? skills.map((k) => (k.id === id ? { ...k, text: read.text } : k)) : [...skills, { id, ...read }];
      const r = await host.setPreference("motionSkills", JSON.stringify(list));
      if (!r.ok) throw new Error(r.error);
      pickSkill(id);
      setSkillError(undefined);
    } catch (e) {
      setSkillError(`${path.split("/").pop()}: ${(e as Error).message}`);
    }
  };
  return (
    <Section>
      <div className="flex flex-col gap-3 py-1" data-motion-tab>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Look</span>
          <div className="flex items-center gap-2">
            <Select
              className="flex-1"
              value={m.look}
              title={look?.description}
              onChange={(e) => {
                restyle(host, [clip], { look: e.target.value }, "Motion Graphics Look");
                // New motion graphics take the Look last picked, so a video's graphics match.
                void host.setPreference("motionLook", e.target.value);
              }}
              data-motion-look
            >
              {(looks ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          {look && <span className="text-caption text-text-faint">{look.description}.</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Skill</span>
          <Select
            value={skill?.id ?? ""}
            title={skill ? skill.text.slice(0, 300) : undefined}
            onChange={(e) => {
              const v = e.target.value;
              if (v === IMPORT_SKILL) void importSkill();
              else if (v !== (skill?.id ?? "")) pickSkill(v || null);
            }}
            data-motion-skill
          >
            <option value="">None</option>
            {skills.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
            <option value={IMPORT_SKILL}>Import Skill…</option>
          </Select>
          {skillError ? (
            <span className="text-caption text-danger" data-motion-skill-error>
              {skillError}
            </span>
          ) : (
            skill && (
              <span className="text-caption text-text-faint">
                {planner === "apple" ? "Skills need OpenAI or Claude: Apple's model only fills templates (Settings › AI)." : "Make and Revise follow its design and rules. Kept for every project; Settings › AI lists them."}
              </span>
            )
          )}
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Words</span>
          <Segmented
            value={m.timing}
            options={[
              { value: "speech", label: "As Said", icon: null },
              { value: "together", label: "All at Once", icon: null },
            ]}
            onChange={(timing) => timing !== m.timing && restyle(host, [clip], { timing }, "Motion Graphics Timing")}
            data-motion-timing
          />
          {designed && <span className="text-caption text-text-faint">Designed with its own look and timing: Look and Words change only the parts that use them.</span>}
        </div>
        <div className={`flex flex-col gap-1 ${writing ? "opacity-50" : ""}`}>
          <span className="text-label font-medium text-text-muted">Prompt</span>
          <Segmented
            value={m.source}
            options={[
              { value: "auto", label: "Auto", icon: null },
              { value: "manual", label: "Manual", icon: null },
            ]}
            onChange={(source) => {
              if (source === m.source || writing) return;
              set(source === "manual" && !m.manual ? { source, manual: m.prompt || said || "" } : { source }, source === "manual" ? "Motion Graphics Prompt: Manual" : "Motion Graphics Prompt: Auto");
              if (source === "auto" && !m.prompt) host.run("motion.write", { clip: clip.id });
            }}
            data-motion-source
          />
        </div>
        {auto ? (
          <div className="flex flex-col gap-1">
            <div className={`rounded-md bg-groove px-3 py-2 text-caption ${m.prompt ? "text-text" : "text-text-faint"}`} data-motion-prompt>
              {writing ? "Writing the prompt…" : m.prompt || "Written from the words under the clip"}
            </div>
            <div className="flex items-center gap-2">
              <Button disabled={busy || needsNet} title={needsNet ? offline : undefined} onClick={() => host.run("motion.write", { clip: clip.id })} data-motion-write>
                {writing ? "Writing…" : m.prompt ? "Write Again" : "Write the Prompt"}
              </Button>
              <Button look="quiet" disabled={!m.prompt || writing} title="Start Manual's prompt from this one, to edit it" onClick={() => set({ source: "manual", manual: m.prompt }, "Copy Motion Graphics Prompt to Manual")}>
                Copy to Manual
              </Button>
            </div>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <TextArea
              rows={4}
              placeholder={said || 'Describe it: "a title: Ship faster", "Sarah Chen, head of design", "87% counting up, revenue growth"'}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onBlur={() => manual !== m.manual && set({ manual }, "Motion Graphics Prompt")}
              data-motion-prompt
            />
            <span className="text-caption text-text-faint">A title, a name and role, a number, a list, or a line of text, with the words to show.</span>
          </label>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Reference Image</span>
          {reference ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-caption text-text" title={reference.path} data-motion-reference>
                {reference.name ?? reference.path.split("/").at(-1)}
              </span>
              <Button look="quiet" disabled={busy} onClick={() => host.run("motion.refer", { clip: clip.id, path: null })} data-motion-reference-remove>
                Remove
              </Button>
            </div>
          ) : (
            <Button
              disabled={busy}
              onClick={async () => {
                const path = await host.chooseFile(REFERENCE_EXTENSIONS);
                if (path) host.run("motion.refer", { clip: clip.id, path });
              }}
              data-motion-reference-add
            >
              Add Image…
            </Button>
          )}
          <span className="text-caption text-text-faint">
            {reference && planner === "apple" ? "Needs OpenAI or Claude: choose one in Settings › AI › Motion Graphics." : "Make recreates its design and animates it."}
          </span>
        </div>
        {m.takes.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-label font-medium text-text-muted">Take</span>
            <Select value={String(m.shown)} onChange={(e) => host.run("motion.use", { clip: clip.id, take: Number(e.target.value) }, "Pick Motion Graphics Take")} data-motion-pick>
              {m.takes.map((t, i) => (
                <option key={i} value={i}>
                  {i + 1}. {takeName(t)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {error && (
          <div className="flex flex-col items-start gap-2 text-danger" data-motion-error>
            {error}
            {/API key|Apple Intelligence/.test(error) && !settingsOpen && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
          </div>
        )}
        <Button
          look="primary"
          disabled={!prompted || busy || needsNet}
          title={needsNet ? offline : undefined}
          // The prompt being typed is kept as the box loses focus, before this click: it's the one made.
          onClick={() => host.run("motion.make", { clip: clip.id })}
          data-motion-make
        >
          {making ? "Making…" : `${m.takes.length ? "Make Again" : "Make"} · ${planner === "apple" ? "Free" : `~$${cost.toFixed(2)}`}`}
        </Button>
        {making && (
          <span className="text-caption text-text-muted" data-motion-making-note>
            Keep editing meanwhile: if you resize, trim or restyle the clip, it's drawn again to fit when it arrives.
          </span>
        )}
        {m.shown >= 0 && (
          <Button look="quiet" disabled={busy} title="Draw it again at its box's size and length now, after resizing or trimming it (no AI)" onClick={() => host.run("motion.render", { clips: [clip.id] })} data-motion-render>
            Draw Again
          </Button>
        )}
        <div className="flex flex-col gap-1" data-motion-edit>
          <span className="text-label font-medium text-text-muted">Edit</span>
          {m.shown >= 0 && <TextArea rows={2} placeholder='Change something: "make the logo bigger", "slower", "a blue background"' value={note} onChange={(e) => setNote(e.target.value)} data-motion-note />}
          <div className="flex gap-2">
            {m.shown >= 0 && (
              <Button
                className="flex-1"
                disabled={!note.trim() || busy || needsNet || planner === "apple"}
                title={planner === "apple" ? "Revise needs OpenAI or Claude: choose one in Settings › AI" : needsNet ? offline : "The AI changes what you asked and keeps the rest: a new take"}
                onClick={() => host.run("motion.revise", { clip: clip.id, note: note.trim() })}
                data-motion-revise
              >
                {`Revise · ${planner === "apple" ? "Needs OpenAI or Claude" : `~$${cost.toFixed(2)}`}`}
              </Button>
            )}
            <Button
              look="quiet"
              disabled={busy}
              title={m.shown >= 0 ? "Edit its HTML, CSS and script with a live preview: a new take, free" : "Write its HTML, CSS and script by hand with a live preview, instead of Make: free"}
              onClick={() => setEditing(true)}
              data-motion-code
            >
              {m.shown >= 0 ? "Edit Code…" : "Write Code…"}
            </Button>
          </div>
        </div>
        {editing && <MotionCode host={host} clip={clip.id} html={m.takes[m.shown]?.html ?? ""} onClose={() => setEditing(false)} />}
        <span className="text-caption text-text-faint">
          {planner === "apple"
            ? "Apple's model on this Mac fills a template: a title, lower third, number, list or text. OpenAI and Claude design anything (3D, maps, any style)."
            : `Designed by ${planner === "claude" ? "Claude" : "OpenAI"} with your key, charged to your account (about what the button says, from what Makes have cost).`}{" "}
          Drawn with transparency into the project's media/Motion graphics folder.
        </span>
      </div>
    </Section>
  );
}
