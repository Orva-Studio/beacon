import { useEffect, useState } from "react";
import { type Project, type Session } from "@beacon/model";
import { Button, Icon, Slider } from "./controls";
import { ReviewPanel, useReviewed } from "./review";
import { useView } from "./store";
import { clock } from "./time";
import type { Host } from "./app";
import type { TimelineMark } from "./timeline-draw";

/** Remove Retakes' review in `session.features.transcript.retakes` (the transcript feature's `retakes.review`). */
interface Review {
  minWords: number;
  within: number;
  kept: number[];
  learned?: string[];
}

export interface RetakeGroup {
  start: number;
  end: number;
  takes: { start: number; end: number; text: string }[];
  /** Its takes' words, naming it to retakes.cutAll. */
  key: string;
  /** The take kept, from 0; -1 when every take is cut. */
  best: number;
  by: "you" | "openai" | "beacon" | "habit";
  reason?: string;
  /** Every group cuts something; `ReviewPanel` counts these. */
  cut?: true;
}

/** What `transcript.retakes` answers. */
export interface Retakes {
  /** Media with no transcript yet. */
  waiting: string[];
  /** Media OpenAI hasn't judged yet. */
  judging: string[];
  judge: "beacon" | "openai";
  groups: RetakeGroup[];
  cuts: number;
  saved: number;
  current?: number;
}

export const retakeReviewOf = (session: Session | undefined) => (session?.features.transcript as { retakes?: Review } | undefined)?.retakes;

export const useRetakes = (host: Host, session: Session | undefined, project: Project | undefined) => useReviewed<Retakes>(host, "transcript.retakes", retakeReviewOf(session), project);

/** Each take on the timeline: the one kept green, the others red; every take of the group looked at outlined. */
export const retakeMarks = (found: Retakes): TimelineMark[] =>
  found.groups.flatMap((g, i) => g.takes.map((t, k) => ({ start: t.start, end: t.end, tone: k === g.best ? ("take" as const) : ("cut" as const), current: i === found.current })));

const BY = { you: "Chosen by you", openai: "Picked by OpenAI", beacon: "Picked by Beacon", habit: "The take you usually keep" };

/** Takes a group cuts: all but the one kept, or every one. */
const cutCount = (g: RetakeGroup) => (g.best < 0 ? g.takes.length : g.takes.length - 1);

/** A group's takes as text, with their lengths: a click keeps one, ▶ plays it alone; or cut every take. */
function Takes({ group, host, session }: { group: RetakeGroup; host: Host; session: Session }) {
  /** The take being played: where it ends, and whether playback has begun (it starts a moment after ▶). */
  const [until, setUntil] = useState<{ end: number; started: boolean }>();
  useEffect(() => {
    if (!until) return;
    if (!session.playing) {
      if (until.started) setUntil(undefined);
    } else if (session.playhead >= until.end) {
      host.run("playback.pause");
      setUntil(undefined);
    } else if (!until.started) setUntil({ ...until, started: true });
  }, [session.playhead, session.playing, until]);
  return (
    <div className="mb-3 flex flex-col gap-1" data-retake-takes>
      {group.takes.map((t, k) => (
        <div key={k} className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${k === group.best ? "bg-accent-wash" : "bg-groove"}`} data-take={k} data-kept={k === group.best || undefined}>
          <button
            className="flex-1 cursor-pointer text-left"
            title={k === group.best ? "The take kept" : "Keep this take instead"}
            onClick={() => host.run("retakes.keep", { at: (t.start + t.end) / 2 })}
            data-take-keep
          >
            <span className={k === group.best ? "text-text-strong" : "text-text-muted line-through decoration-silence-cut"}>{t.text}</span>
            <span className="ml-2 text-label text-text-faint">{(t.end - t.start).toFixed(1)} s</span>
          </button>
          <Button
            look="quiet"
            title="Play this take"
            onClick={() => {
              host.run("playhead.set", { time: t.start });
              host.run("playback.play");
              setUntil({ end: t.end, started: false });
            }}
            data-take-play
          >
            <Icon name="play" size={14} filled />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-label text-text-faint" data-take-by>
          {group.best < 0 ? "Every take cut, by you" : BY[group.by]}
          {group.reason ? `: ${group.reason}` : ""}
        </span>
        <Button
          look="quiet"
          title={group.best < 0 ? "Keep one take again: the one picked" : "Cut every take of this line, keeping none"}
          onClick={() => host.run("retakes.cutAll", { start: group.start, end: group.end, key: group.key, on: group.best >= 0 })}
          data-take-cut
          data-take-cut-all={group.best < 0 || undefined}
        >
          {group.best < 0 ? "Keep One" : "Cut All"}
        </Button>
      </div>
    </div>
  );
}

/** Remove Retakes' review, with its settings. */
export function RetakeReviewPanel({ project, session, host, found }: { project: Project; session: Session; host: Host; found: Retakes | undefined }) {
  const review = retakeReviewOf(session)!;
  // Remembered app-wide, as Remove Silences' are.
  const set = (args: Partial<Review>) => {
    host.run("retakes.review", args);
    if (args.minWords !== undefined) void host.setPreference("retakeMinWords", String(args.minWords));
    if (args.within !== undefined) void host.setPreference("retakeWithin", String(args.within));
  };
  const judging = useView((v) => v.judging);
  const failed = useView((v) => v.judgeFailed);
  const asking = found?.judging.filter((a) => a in judging || !failed[a]) ?? [];
  const error = found?.judging.map((a) => failed[a]).find(Boolean);
  return (
    <ReviewPanel
      review="retakes"
      one="retake"
      title="Remove Retakes"
      noun="retakes"
      none="No line said more than once."
      project={project}
      host={host}
      found={found}
      items={found?.groups.map((g) => ({ ...g, cut: true as const }))}
      tally={(groups) => `${groups.length} ${groups.length === 1 ? "line" : "lines"} said more than once, ${groups.reduce((n, g) => n + cutCount(g), 0)} takes to cut.`}
      describe={(g) => `${clock(g.start)}: ${g.takes.length} takes, ${g.best < 0 ? "cutting them all" : `keeping take ${g.best + 1}`}`}
      list
      learned={review.learned}
      detail={(g) => <Takes group={g} host={host} session={session} />}
      legend={
        <>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-4 rounded-sm bg-take-kept" /> Take kept
            <span className="ml-3 h-2.5 w-4 rounded-sm bg-silence-cut" /> To cut
          </span>
          <span>Click a line on the timeline or in the list to look at it, then one of its takes to keep it instead.</span>
        </>
      }
      note={
        found?.judge === "openai" && !found.waiting.length && (asking.length || error) ? (
          <div className="mb-2 text-label text-text-muted" data-retakes-judging>
            {error && !asking.length ? `${error}. Beacon's own picks are shown.` : "OpenAI is picking the best takes; Beacon's own picks are shown until it has."}
          </div>
        ) : undefined
      }
    >
      <Slider label="Repeats" title="Words in a row a take must say again to count as a retake" value={review.minWords} unit=" words" digits={0} step={1} min={2} max={8} onChange={(v) => set({ minWords: Math.round(v) })} />
      <Slider label="Within" title="Seconds between the starts of two takes, at most" value={review.within} unit=" s" digits={0} step={5} min={5} max={120} onChange={(v) => set({ within: Math.round(v) })} />
      <div className="mb-4 text-label text-text-faint">Lines restarted or said again, found in the transcript. {found?.judge === "openai" ? "OpenAI picks the take to keep" : "The last take that says the whole line is kept, unless an earlier one has noticeably fewer fillers and stumbles"}; Best Take in Settings › Transcripts chooses who picks.</div>
    </ReviewPanel>
  );
}
