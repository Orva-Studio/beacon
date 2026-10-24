import { useEffect, useMemo, useState } from "react";
import { assetName, ticksToSeconds, type Clip, type Project, type RGBA, type Session } from "@beacon/model";
import type { BrollProps, BrollState, TakeInfo } from "@beacon/features";
import { Button, Check, Section, Select, TextArea } from "./controls";
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
  const [guide, setGuide] = useState(b.guide);
  useEffect(() => setPrompt(b.prompt), [b.prompt]);
  useEffect(() => setGuide(b.guide), [b.guide]);
  const set = (fields: Partial<BrollProps>, label: string) => host.run("clip.set", { clip: clip.id, props: { broll: fields } }, label);
  // Asked again when the clip's length or Settings › AI's model, resolution or limit change: what is shown is what Generate pays.
  const priced = useView((v) => v.preferences.filter((p) => p.id.startsWith("broll")).map((p) => p.value).join());
  const asked = JSON.stringify([priced, clip.id, clip.duration]);
  const answer = useQuery<Estimate>(host, "broll.estimate", { clips: [clip.id], for: asked });
  const estimate = answer?.for === asked ? answer : undefined;
  const cost = estimate?.clips[0];
  const tooLong = !!estimate && ticksToSeconds(clip.duration) > estimate.longest + 1e-3;
  const over = !!estimate && !!cost && estimate.limit > 0 && cost.cost > estimate.limit;
  const settingsOpen = useView((v) => !!v.settings);
  // What is said under the clip (the transcript already made): the prompt's placeholder, and its prompt if left empty.
  // Asked again when a transcript is finished too: that changes no document.
  const transcribing = useView((v) => Object.keys(v.transcribing).join());
  const again = useMemo(() => ({}), [project, transcribing]);
  const said = useQuery<{ text: string }[]>(host, "transcript.get", { format: "words", from: ticksToSeconds(clip.start), to: ticksToSeconds(clip.start + clip.duration) }, again)
    ?.map((w) => w.text)
    .join(" ")
    .trim();
  const takes = b.takes.map((t) => t.assetId).filter((id) => project.assets[id]);
  const info = (id: string) => project.assets[id]?.derived.broll as TakeInfo | undefined;
  const ready = (!!prompt.trim() || !!said) && !!estimate && !busy && !tooLong && !over;
  return (
    <Section>
      <div className="flex flex-col gap-3 py-1" data-broll-tab>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-text-muted">Prompt</span>
          <TextArea rows={4} placeholder={said ? `“${said}”` : "What the footage shows: subject, action, setting, camera"} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== b.prompt && set({ prompt }, "B-roll Prompt")} data-broll-prompt />
          {b.why && <span className="text-caption text-text-faint">{b.why}</span>}
          {!prompt.trim() && said && <span className="text-caption text-text-faint">Left empty, the words said here are the prompt. Type your own, or Plan for a better one.</span>}
        </label>
        <div className="flex flex-col gap-2 rounded-md bg-groove px-3 py-2">
          <Button disabled={busy} onClick={() => host.run("broll.plan", { clip: clip.id })} data-broll-plan>
            {planning ? "Planning…" : b.prompt ? "Plan Again from the Words" : "Plan from the Words"}
          </Button>
          <TextArea rows={2} placeholder="Guide (optional): a city at night; keep it abstract" value={guide} onChange={(e) => setGuide(e.target.value)} onBlur={() => guide !== b.guide && set({ guide }, "B-roll Guide")} data-broll-guide />
          <Check label="Research the topic" title="Plan searches the web for the names, products and places said, so the shot shows the right thing" checked={b.research} onChange={(on) => set({ research: on }, "B-roll Research")} data-broll-research />
          <span className="text-caption text-text-faint">Plan turns the words into a shot with OpenAI (its key); a clip longer than the model makes is split into shots.</span>
        </div>
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
          <Button look="quiet" disabled={(!prompt.trim() && !said) || busy} title={`Make this clip with each of the ${cost.compare.models} models that can, to compare them`} onClick={() => host.run("broll.compare", { clip: clip.id })} data-broll-compare>
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
