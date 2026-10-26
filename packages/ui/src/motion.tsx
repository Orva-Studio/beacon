import { useEffect, useMemo, useState } from "react";
import type { Clip, Project, Session } from "@beacon/model";
import type { Look, MotionProps, MotionState } from "@beacon/features";
import { Button, Section, Segmented, Select, TextArea } from "./controls";
import { useOnline } from "./online";
import { useQuery } from "./query";
import { useView } from "./store";
import type { Host } from "./app";

export const motionStateOf = (s: Session | undefined) => (s?.features.motion as MotionState | undefined) ?? { writing: [], making: [], errors: {} };

/** A motion graphics clip with nothing made yet: its box shows on the canvas, nothing in an export. */
export const isEmptyMotion = (c: Clip) => c.type === "motion" && !c.assetId;

/** Images a reference can be: motion.refer's. */
const REFERENCE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

/** What a Make with OpenAI is likely to cost: the average of the project's Makes so far, else a typical one. */
function typicalCost(project: Project): number {
  const costs = project.tracks.flatMap((t) => t.clips).flatMap((c) => (c.type === "motion" ? (c.props.motion as MotionProps).takes.flatMap((t) => (t.cost ? [t.cost] : [])) : []));
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0.15;
}

/** A take in the Take menu: its prompt, in a few words. */
const takeName = (t: MotionProps["takes"][number]) => (t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}…` : t.prompt) || "Untitled";

/** Clips waiting to be drawn again after their style changed: a colour dragged draws once, when it settles. */
const redraws = new Map<string, ReturnType<typeof setTimeout>>();

/** A style change, then the clips made drawn again in it (motion.render), once changes stop for a moment. */
function restyle(host: Host, clips: Clip[], style: { look?: string; timing?: string }, label: string, key?: string, all = false) {
  host.run("motion.style", { ...(all ? {} : { clips: clips.map((c) => c.id) }), ...style }, label, key);
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
  useEffect(() => setManual(m.manual), [m.manual]);
  const planner = useView((v) => v.preferences.find((p) => p.id === "motionPlanner")?.value);
  const online = useOnline();
  const needsNet = planner === "openai" && !online;
  const offline = "Needs the internet: you're offline (OpenAI makes it)";
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
  const cost = typicalCost(project);
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
            <Button look="quiet" title="Give every motion graphic in this project this Look" onClick={() => restyle(host, project.tracks.flatMap((t) => t.clips).filter((c) => c.type === "motion"), { look: m.look }, "Motion Graphics Look for All", undefined, true)} data-motion-look-all>
              Use for All
            </Button>
          </div>
          {look && <span className="text-caption text-text-faint">{look.description}.</span>}
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Made by</span>
          <Segmented
            value={planner === "apple" ? "apple" : "openai"}
            options={[
              { value: "openai", label: "OpenAI", icon: null },
              { value: "apple", label: "Apple · Free", icon: null },
            ]}
            onChange={(v) => v !== planner && void host.setPreference("motionPlanner", v)}
            data-motion-planner
          />
        </div>
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
            {reference && planner !== "openai" ? "Needs OpenAI as the planner (Settings › AI)." : "Make recreates its design and animates it (OpenAI)."}
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
        {m.shown >= 0 && (
          <Button look="quiet" disabled={busy} title="Draw it again at its box's size and length now, after resizing or trimming it (no AI)" onClick={() => host.run("motion.render", { clips: [clip.id] })} data-motion-render>
            Draw Again
          </Button>
        )}
        <span className="text-caption text-text-faint">
          {planner === "apple"
            ? "Apple's model on this Mac fills a template: a title, lower third, number, list or text. OpenAI designs anything (3D, maps, any style)."
            : "Designed by OpenAI with your key, charged to your account (about what the button says, from what Makes have cost)."}{" "}
          Drawn with transparency into the project's media/Motion graphics folder.
        </span>
      </div>
    </Section>
  );
}
