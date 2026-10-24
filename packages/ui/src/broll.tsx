import { useEffect, useMemo, useState } from "react";
import { assetName, ticksToSeconds, type Clip, type Project, type RGBA, type Session } from "@beacon/model";
import type { BrollProps, BrollState, Style, TakeInfo } from "@beacon/features";
import { Button, Check, Section, Segmented, Select, TextArea } from "./controls";
import { COLOR, line, type CanvasMark } from "./canvas-marks";
import type { Placed } from "./canvas";
import { useQuery } from "./query";
import { useView } from "./store";
import type { Host } from "./app";

/** What `broll.estimate` answers. */
interface Estimate {
  /** What it was asked for: the clips and settings it priced. */
  for: string;
  model: string;
  resolution: string;
  limit: number;
  longest: number;
  clips: { id: string; seconds: number; cost: number; compare: { models: number; cost: number } }[];
}

const dollars = (v: number) => `$${v.toFixed(2)}`;

/** The Style menu's last item: opens Settings › AI, where the user's own styles are added and edited. */
const ADD = "__add__";

export const brollStateOf = (s: Session | undefined) => (s?.features.broll as BrollState | undefined) ?? { planning: [], making: [], errors: {} };

/** A filled band: a square-ended line `width` points thick. */
const band = (from: [number, number], to: [number, number], color: RGBA, width: number): CanvasMark => ({ kind: "line", from, to, width, color, butt: true });

/**
 * An empty B-roll placeholder on the canvas: a tinted box with a dashed-looking outline, so its region shows where
 * nothing is drawn yet (exports show nothing there).
 */
export function placeholderMarks(p: Placed): CanvasMark[] {
  const [a, b, c, d] = p.corners as [[number, number], [number, number], [number, number], [number, number]];
  const tint: RGBA = [COLOR.hot[0], COLOR.hot[1], COLOR.hot[2], 0.14];
  const mid = (u: [number, number], v: [number, number]): [number, number] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  // Filled by one band from the left edge's middle to the right's, as tall as the box (axis-aligned boxes).
  const height = Math.hypot(d[0] - a[0], d[1] - a[1]);
  return [band(mid(a, d), mid(b, c), tint, height), ...[a, b, c, d].map((q, i) => line(q, [a, b, c, d][(i + 1) % 4]!, COLOR.hot, 1.5))];
}

/**
 * A B-roll clip's tab: its prompt (typed, or planned from the words under it), what Plan uses, the take shown and
 * the others, and making it (or again, or with every model) with what that costs.
 */
export function BrollTab({ clip, project, session, host }: { clip: Clip; project: Project; session: Session; host: Host }) {
  const b = clip.props.broll as BrollProps;
  const state = brollStateOf(session);
  const planning = state.planning.includes(clip.id);
  const making = state.making.includes(clip.id);
  const busy = planning || making;
  const error = state.errors[clip.id];
  const [prompt, setPrompt] = useState(b.prompt);
  useEffect(() => setPrompt(b.prompt), [b.prompt]);
  const styles = useQuery<Style[]>(host, "broll.styles", {}, useView((v) => v.preferences.find((p) => p.id === "brollStyles")?.value));
  const planner = useView((v) => v.preferences.find((p) => p.id === "brollPlanner")?.value);
  const auto = b.source === "auto";
  const set = (fields: Partial<BrollProps>, label: string) => host.run("clip.set", { clip: clip.id, props: { broll: fields } }, label);
  // Asked again when the clip's length or Settings › AI's model, resolution or limit change: what is shown is what Generate pays.
  const priced = useView((v) => v.preferences.filter((p) => p.id.startsWith("broll")).map((p) => p.value).join());
  const asked = JSON.stringify([priced, clip.id, clip.duration]);
  const answer = useQuery<Estimate>(host, "broll.estimate", { clips: [clip.id], for: asked });
  const estimate = answer?.for === asked ? answer : undefined;
  const cost = estimate?.clips[0];
  // A frame over is fine: the footage ends a frame early (broll.generate's allowance).
  const tooLong = !!estimate && ticksToSeconds(clip.duration) > estimate.longest + project.settings.fps.den / project.settings.fps.num + 1e-3;
  const over = !!estimate && !!cost && estimate.limit > 0 && cost.cost > estimate.limit;
  const settingsOpen = useView((v) => !!v.settings);
  // What is said under the clip (the transcript already made): the prompt's placeholder, and its prompt if left empty.
  // Asked again when a transcript is finished too: that changes no document.
  const transcribing = useView((v) => Object.keys(v.transcribing).join());
  const again = useMemo(() => ({}), [project, transcribing]);
  const said = useQuery<string>(host, "broll.words", { clip: clip.id }, again);
  const takes = b.takes.map((t) => t.assetId).filter((id) => project.assets[id]);
  const info = (id: string) => project.assets[id]?.derived.broll as TakeInfo | undefined;
  // Something to make it from: its prompt, or (still empty) the words said.
  const prompted = !!prompt.trim() || !!said;
  const ready = prompted && !!estimate && !busy && !tooLong && !over;
  const groups = [...new Set((styles ?? []).map((s) => s.group))];
  return (
    <Section>
      <div className="flex flex-col gap-3 py-1" data-broll-tab>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Style</span>
          <Select
            value={b.style}
            onChange={(e) => {
              if (e.target.value === ADD) return void host.app("app.settings:ai");
              set({ style: e.target.value }, "B-roll Style");
              // Auto's prompt is written in the style: written again in the new one.
              if (auto && b.prompt) host.run("broll.plan", { clip: clip.id });
            }}
            data-broll-style
          >
            {groups.map((g) =>
              g ? (
                <optgroup key={g} label={g}>
                  {styles!.filter((s) => s.group === g).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                styles!.filter((s) => !s.group).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))
              ),
            )}
            <option value={ADD}>Add or Edit Styles…</option>
          </Select>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Prompt</span>
          <Segmented
            value={b.source}
            options={[
              { value: "auto", label: "Auto", icon: null },
              { value: "manual", label: "Manual", icon: null },
            ]}
            onChange={(source) => {
              // Manual starts from the words said; Auto writes its own.
              if (source === "manual") set({ source, prompt: said ?? "", why: "" }, "B-roll Prompt: Manual");
              else {
                set({ source, prompt: "", why: "" }, "B-roll Prompt: Auto");
                host.run("broll.plan", { clip: clip.id });
              }
            }}
            data-broll-source
          />
        </div>
        {auto ? (
          <div className="flex flex-col gap-1">
            <div className={`rounded-md bg-groove px-3 py-2 text-caption ${b.prompt ? "text-text" : "text-text-faint"}`} data-broll-prompt>
              {planning ? "Writing the prompt…" : b.prompt || "Written from the words under the clip, in its style"}
            </div>
            {b.why && <span className="text-caption text-text-faint">{b.why}</span>}
            <div className="flex items-center gap-2">
              <Button look="quiet" disabled={busy} onClick={() => host.run("broll.plan", { clip: clip.id })} data-broll-plan>
                {planning ? "Writing…" : b.prompt ? "Write Again" : "Write the Prompt"}
              </Button>
              {planner === "openai" && <Check label="Research" title="OpenAI searches the web for the names, products and places said, so the shot shows the right thing" checked={b.research} onChange={(on) => set({ research: on }, "B-roll Research")} data-broll-research />}
            </div>
            <span className="text-caption text-text-faint">
              {planner === "openai" ? "Written by OpenAI (your key)." : "Written by Apple's model on this Mac."} A clip longer than the video model makes is split into shots.
            </span>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <TextArea rows={4} placeholder={said || "Describe the shot"} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== b.prompt && set({ prompt }, "B-roll Prompt")} data-broll-prompt />
            <span className="text-caption text-text-faint">Starts from the words said under the clip; the style's wording is added.</span>
          </label>
        )}
        {takes.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-label font-medium text-text-muted">Footage</span>
            <Select value={clip.assetId ?? ""} onChange={(e) => host.run("broll.use", { clip: clip.id, asset: e.target.value }, "Pick B-roll Take")} data-broll-pick>
              {takes.map((id) => (
                <option key={id} value={id}>
                  {info(id)?.model ?? assetName(project.assets[id]!)} · {dollars(info(id)?.cost ?? 0)}
                  {info(id) && info(id)!.prompt !== b.prompt ? " · earlier prompt" : ""}
                </option>
              ))}
            </Select>
          </label>
        )}
        {error && (
          <div className="flex flex-col items-start gap-2 text-danger" data-broll-error>
            {error}
            {/API (key|token)/.test(error) && !settingsOpen && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
          </div>
        )}
        {tooLong && <span className="text-caption text-warning">Longer than {estimate!.model} makes ({estimate!.longest} s): trim it, or Plan to split it.</span>}
        {over && <span className="text-caption text-warning">Over your {dollars(estimate!.limit)} limit (Settings › AI).</span>}
        <Button look="primary" disabled={!ready} onClick={() => host.run("broll.generate", { clips: [clip.id] })} data-broll-generate>
          {making ? "Making…" : !estimate ? "Pricing…" : `${clip.assetId ? "Make Again" : "Generate"} · ${dollars(cost?.cost ?? 0)}`}
        </Button>
        {cost && cost.compare.models > 1 && (
          <Button look="quiet" disabled={!prompted || busy} title={`Make this clip with each of the ${cost.compare.models} models that can, to compare them`} onClick={() => host.run("broll.compare", { clip: clip.id })} data-broll-compare>
            Try {cost.compare.models} Models · {dollars(cost.compare.cost)}
          </Button>
        )}
        <span className="text-caption text-text-faint">
          {estimate ? `${estimate.model}, ${estimate.resolution}. ` : ""}Replicate charges your account; files are kept in the project's media/B-roll folder.
        </span>
      </div>
    </Section>
  );
}
