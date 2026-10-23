import { useEffect, useState } from "react";
import type { Project, Session } from "@beacon/model";
import type { BrollReview, BrollShot, Rect } from "@beacon/features";
import { Button, Check, Segmented, TextArea } from "./controls";
import { circle, COLOR, line, type CanvasMark } from "./canvas-marks";
import type { Line } from "./canvas-snap";
import { useShortcutTip } from "./keymap";
import { useQuery } from "./query";
import { useView } from "./store";
import { clock } from "./time";
import type { TimelineMark } from "./timeline-draw";
import type { Host } from "./app";

export const brollReviewOf = (s: Session | undefined) => s?.features.broll as BrollReview | undefined;

/** What `broll.estimate` answers. */
interface Estimate {
  model: string;
  resolution: string;
  limit: number;
  total: number;
  shots: { id: string; seconds: number; cost: number }[];
}

const dollars = (v: number) => `$${v.toFixed(2)}`;

/** The shots over the range on the timeline: grey until made, green once made; the one under the playhead outlined. */
export const brollMarks = (r: BrollReview, playhead: number): TimelineMark[] =>
  r.shots.map((s) => ({ start: s.start, end: s.end, tone: s.candidate && s.use ? "take" : "keep", current: playhead >= s.start && playhead < s.end }));

/** A corner of the region within this many points of the pointer is grabbed. */
const GRAB = 9;
/** Edges snap from this many points away. */
const SNAP = 8;

export type Corner = "nw" | "ne" | "se" | "sw";

const corners = ([x, y, w, h]: Rect): Record<Corner, [number, number]> => ({ nw: [x, y], ne: [x + w, y], se: [x + w, y + h], sw: [x, y + h] });

/** The corner of `r` under overlay point `pt`, if any. */
export function regionCorner(r: Rect, pt: [number, number], at: (x: number, y: number) => [number, number]): Corner | undefined {
  return (Object.entries(corners(r)) as [Corner, [number, number]][]).find(([, c]) => Math.hypot(at(...c)[0] - pt[0], at(...c)[1] - pt[1]) <= GRAB)?.[0];
}

/**
 * The region from fixed corner `anchor` to `pt` (canvas pixels), each edge snapped to the canvas's edges,
 * halves and thirds, and to `extra` (the safe areas shown), within SNAP points at `k` points a pixel; clamped to the canvas.
 */
export function regionTo(anchor: [number, number], pt: [number, number], width: number, height: number, k: number, extra?: { x: Line[]; y: Line[] }, snapping = true): Rect {
  const snap = (v: number, size: number, lines: Line[]) => {
    if (!snapping) return v;
    const targets = [0, size / 3, size / 2, (2 * size) / 3, size, ...lines.map((l) => l.at)];
    const best = targets.reduce((b, t) => (Math.abs(t - v) < Math.abs(b - v) ? t : b), Infinity);
    return Math.abs(best - v) * k <= SNAP ? best : v;
  };
  // A drag can start or end off the canvas: both corners are kept on it.
  const [ax, x] = [anchor[0], pt[0]].map((v) => Math.min(width, Math.max(0, snap(v, width, extra?.x ?? [])))) as [number, number];
  const [ay, y] = [anchor[1], pt[1]].map((v) => Math.min(height, Math.max(0, snap(v, height, extra?.y ?? [])))) as [number, number];
  const [x0, x1] = [Math.min(ax, x), Math.max(ax, x)];
  const [y0, y1] = [Math.min(ay, y), Math.max(ay, y)];
  return [Math.round(x0), Math.round(y0), Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))];
}

/** The corner opposite `c`: it stays put while `c` is dragged. */
export const opposite = (r: Rect, c: Corner): [number, number] => corners(r)[({ nw: "se", ne: "sw", se: "nw", sw: "ne" } as const)[c]];

/** The region's outline on the canvas, with a handle at each corner to resize it. */
export function regionMarks(r: Rect, at: (x: number, y: number) => [number, number]): CanvasMark[] {
  const c = Object.values(corners(r));
  return [...c.map((p, i) => line(at(...p), at(...c[(i + 1) % 4]!), COLOR.hot, 1.5)), ...c.map((p) => circle(at(...p), 5, COLOR.handle, COLOR.hot))];
}

/**
 * B-roll's review, in place of the properties panel (the AI panel's B-roll tile): the range and what is said in it,
 * a guide, research and where it goes; then the shots, each with its prompt, what it costs and the footage made;
 * Apply places them. The canvas shows the footage in place while it is open.
 */
export function BrollPanel({ project, session, host }: { project: Project; session: Session; host: Host }) {
  const review = brollReviewOf(session)!;
  const tip = useShortcutTip();
  const [guide, setGuide] = useState(review.guide);
  useEffect(() => setGuide(review.guide), [review.guide]);
  const said = useQuery<{ text: string }[]>(host, "transcript.get", { format: "words", from: review.from, to: review.to }, project);
  const estimate = useQuery<Estimate>(host, review.shots.length ? "broll.estimate" : "", {}, JSON.stringify(review.shots.map((s) => [s.id, s.start, s.end])));
  const settingsOpen = useView((v) => !!v.settings);
  const making = review.shots.some((s) => s.making);
  const waiting = review.shots.filter((s) => !s.candidate && !s.making);
  const toMake = estimate?.shots.filter((x) => waiting.some((s) => s.id === x.id)).reduce((sum, x) => sum + x.cost, 0) ?? 0;
  const ready = review.shots.some((s) => s.use && s.candidate) && !making;
  const where = review.drawing ? "draw" : review.region ? "region" : "full";
  const [, , w, h] = review.region ?? [0, 0, project.settings.width, project.settings.height];
  const show = (s: BrollShot) => host.run("playhead.set", { time: s.start + 0.05 });
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-broll-review>
      <div className="mb-3 text-title font-semibold text-text-strong">B-roll</div>
      <div className="mb-3 rounded-md bg-groove px-3 py-2" data-broll-range>
        <div className="text-label text-text-muted">
          {clock(review.from)}–{clock(review.to)} · {(review.to - review.from).toFixed(1)} s
        </div>
        <div className="mt-1 line-clamp-4 text-caption text-text">{said === undefined ? "…" : said.length ? said.map((x) => x.text).join(" ") : "Nothing is said here yet (no transcript)."}</div>
      </div>
      <label className="mb-3 flex flex-col gap-1">
        <span className="text-label font-medium text-text-muted">Guide (optional)</span>
        <TextArea rows={2} placeholder="Show a city at night; keep it abstract" value={guide} onChange={(e) => setGuide(e.target.value)} onBlur={() => guide !== review.guide && host.run("broll.review", { guide })} data-broll-guide />
      </label>
      <div className="mb-3 flex flex-col gap-1">
        <span className="text-label font-medium text-text-muted">Kind</span>
        <Segmented value="footage" options={[{ value: "footage", label: "Footage", icon: null }]} onChange={() => {}} data-broll-kind />
        <span className="text-caption text-text-faint">Animation (titles, numbers, diagrams drawn here) comes next.</span>
      </div>
      <div className="mb-3">
        <Check label="Research the topic" title="The planner searches the web for the names, products and places said, so the shots show the right thing" checked={review.research} onChange={(on) => host.run("broll.review", { research: on })} data-broll-research />
      </div>
      <div className="mb-3 flex flex-col gap-1">
        <span className="text-label font-medium text-text-muted">Where</span>
        <Segmented
          value={where === "full" ? "full" : "draw"}
          options={[
            { value: "full", label: "Full Canvas", icon: null },
            { value: "draw", label: "Draw on Canvas", icon: null },
          ]}
          onChange={(v) => host.run("broll.review", v === "full" ? { region: null, drawing: false } : { drawing: true })}
          data-broll-where
        />
        <span className="text-caption text-text-faint" data-broll-region>
          {where === "draw" ? "Drag a rectangle on the canvas; it snaps to halves, thirds and the safe areas." : where === "region" ? `${Math.round(w)}×${Math.round(h)} px; drag its corners to change it.` : `${project.settings.width}×${project.settings.height} px, the whole canvas.`}
        </span>
      </div>
      <Button disabled={review.planning || making || review.drawing} onClick={() => host.run("broll.plan")} data-broll-plan>
        {review.planning ? "Planning…" : review.shots.length ? "Plan Again" : "Plan Shots"}
      </Button>
      {review.error && (
        <div className="mt-2 flex flex-col items-start gap-2 text-danger" data-broll-error>
          {review.error}
          {/API (key|token)/.test(review.error) && !settingsOpen && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
        </div>
      )}
      {review.notes && <div className="mt-2 rounded-md bg-groove px-3 py-2 text-caption text-text-muted" data-broll-notes>{review.notes}</div>}
      {review.shots.length > 0 && (
        <div className="mt-3 flex flex-col gap-2" data-broll-shots>
          {review.shots.map((s, i) => (
            <ShotCard key={s.id} shot={s} n={i + 1} cost={estimate?.shots.find((x) => x.id === s.id)} host={host} current={session.playhead >= s.start && session.playhead < s.end} show={() => show(s)} />
          ))}
          {waiting.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md bg-groove px-3 py-2" data-broll-estimate>
              <span>
                {waiting.length === 1 ? "1 shot" : `${waiting.length} shots`} · about {dollars(toMake)} with {estimate?.model ?? "…"}, {estimate?.resolution ?? ""}
              </span>
              {estimate && estimate.limit > 0 && toMake > estimate.limit && <span className="text-caption text-warning">Over your {dollars(estimate.limit)} limit (Settings › AI).</span>}
              <span className="text-caption text-text-faint">Replicate charges your account; the files are kept in the project's media/B-roll folder.</span>
              <Button look="primary" disabled={making || (!!estimate && estimate.limit > 0 && toMake > estimate.limit)} onClick={() => host.run("broll.generate")} data-broll-generate>
                Generate {dollars(toMake)}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="mt-auto flex justify-end gap-2 pt-4">
        <Button onClick={() => host.run("broll.close")} data-broll-cancel>
          Cancel{tip("reviews.cancel")}
        </Button>
        <Button look="primary" disabled={!ready} onClick={() => host.run("broll.apply")} data-broll-apply>
          Apply{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}

function ShotCard({ shot: s, n, cost, host, current, show }: { shot: BrollShot; n: number; cost?: { seconds: number; cost: number }; host: Host; current: boolean; show: () => void }) {
  const [prompt, setPrompt] = useState(s.prompt);
  useEffect(() => setPrompt(s.prompt), [s.prompt]);
  const changed = !!s.candidate && s.candidate.prompt !== s.prompt;
  return (
    <div className={`flex flex-col gap-1.5 rounded-md border px-3 py-2 ${current ? "border-accent" : "border-divider"}`} data-broll-shot={s.id}>
      <div className="flex items-center gap-2">
        <Check checked={s.use} title="Place this shot on Apply" onChange={(on) => host.run("broll.shot", { shot: s.id, use: on })} data-broll-use />
        <button className="text-label font-medium text-text-strong hover:underline" title="Show it on the canvas" onClick={show}>
          Shot {n} · {clock(s.start)}–{clock(s.end)}
        </button>
        <span className="ml-auto text-caption text-text-faint">{cost ? `${cost.seconds} s · ${dollars(cost.cost)}` : ""}</span>
      </div>
      <TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt.trim() && prompt !== s.prompt && host.run("broll.shot", { shot: s.id, prompt: prompt.trim() })} data-broll-prompt />
      {s.why && <span className="text-caption text-text-faint">{s.why}</span>}
      <div className="flex items-center gap-2 text-caption" data-broll-state={s.making ? "making" : s.candidate ? "made" : s.error ? "failed" : "planned"}>
        {s.making ? (
          <span className="text-text-muted">Making…</span>
        ) : (
          <>
            {s.candidate && <span className="text-text-muted">{changed ? "Made from the old prompt" : `Made with ${s.candidate.model}`}</span>}
            {s.error && <span className="text-danger">{s.error}</span>}
            {(s.candidate || s.error) && (
              <Button look="quiet" className="ml-auto" onClick={() => host.run("broll.generate", { shots: [s.id] })} data-broll-again>
                Make Again
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
