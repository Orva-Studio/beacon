import { useEffect, useRef, useState, type ReactNode } from "react";
import { projectDuration, ticksToSeconds, type Project } from "@beacon/model";
import { Button, Progress } from "./controls";
import { useShortcutTip } from "./keymap";
import { useQuery } from "./query";
import { replica, useView } from "./store";
import type { Host } from "./app";
import { clock } from "./time";

/** The mean progress of the transcripts being made, 0-1. */
export function useTranscribing(): number | undefined {
  const values = useView((v) => Object.values(v.transcribing).join());
  return values ? values.split(",").reduce((n, v) => n + Number(v), 0) / values.split(",").length : undefined;
}

/**
 * A transcript query (`transcript.silences`, `.fillers`, `.retakes`) asked while `active`: again after each edit, and
 * each second while media is still being transcribed, whose missing transcripts (an import whose app quit first) are
 * started; likewise media whose takes OpenAI is to judge (`judging`), asked for once each while the review is open.
 */
export function useTranscriptsReady<T extends { waiting: string[]; judging?: string[] }>(host: Host, query: string, args: object, active: boolean, project?: Project): T | undefined {
  const [tick, setTick] = useState(0);
  // Each edit is a new project: the marks and Apply must describe the timeline as it is now; so must a change of
  // who picks (Best Take), which Apply reads.
  const edits = useRef({ project, n: 0 });
  if (edits.current.project !== project) edits.current = { project, n: edits.current.n + 1 };
  const prefs = useView((v) => v.preferences.map((p) => `${p.id}=${p.value}`).join());
  const found = useQuery<T>(host, active ? query : "", args, `${tick}:${edits.current.n}:${prefs}`);
  const missing = active ? (found?.waiting.join() ?? "") : "";
  useEffect(() => {
    for (const asset of missing ? missing.split(",") : []) host.analyze("transcript", asset);
  }, [missing]);
  const failed = useView((v) => v.judgeFailed);
  const asked = useRef(new Set<string>());
  if (!active) asked.current.clear();
  // Opened again, what OpenAI couldn't judge is asked again (back online, a key corrected).
  useEffect(() => {
    if (active) replica.media({ judgeFailed: {} });
  }, [active]);
  // Those it couldn't judge keep Beacon's own picks: asking again would fail again.
  const judging = active && !missing ? (found?.judging ?? []).filter((a) => !failed[a]).join() : "";
  useEffect(() => {
    for (const asset of judging ? judging.split(",") : []) {
      if (asked.current.has(asset)) continue;
      asked.current.add(asset);
      host.analyze("retakes", asset);
    }
  }, [judging]);
  useEffect(() => {
    if (!missing && !judging) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [missing, judging]);
  return active ? found : undefined;
}

/** What an open review (`review`, its query's args) finds, for the timeline's marks and the review panel. */
export const useReviewed = <T extends { waiting: string[]; judging?: string[] }>(host: Host, query: string, review: object | undefined, project: Project | undefined) =>
  useTranscriptsReady<T>(host, query, review ?? {}, !!review, project);

type Review = "silences" | "fillers" | "retakes";
type Item = { start: number; end: number; cut: boolean };

/** Goes to one silence, filler or group of takes, with the playhead a second before it to play across it. */
export function goTo(host: Host, review: Review, item: { start: number }) {
  host.run(`${review}.focus`, { at: item.start });
  host.run("playhead.set", { time: Math.max(0, item.start - 1) });
}

/**
 * Going through a review's silences or fillers one at a time: ‹ › step between them (a click on a silence on the timeline, ⌥-click on a filler,
 * goes to it), Skip moves on, Cut This One cuts only it (one undo step) and moves on.
 */
function OneByOne<T extends Item>({ review, items, current, host, describe, detail }: { review: Review; items: T[]; current: number | undefined; host: Host; describe: (item: T) => string; detail?: (item: T) => ReactNode }) {
  if (!items.length) return null;
  const item = current === undefined ? undefined : items[current];
  const step = (by: 1 | -1) => {
    const i = current === undefined ? (by > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, current + by));
    goTo(host, review, items[i]!);
  };
  return (
    <div className="mb-4 rounded-md border border-divider px-3 py-2" data-one-by-one>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-label text-text-muted" data-one-at>
          {item ? `One at a time: ${current! + 1} of ${items.length}` : "One at a time"}
        </span>
        <Button title="The one before" disabled={current === 0} onClick={() => step(-1)} data-one-prev>
          ‹
        </Button>
        <Button title="The next one" disabled={current === items.length - 1} onClick={() => step(1)} data-one-next>
          ›
        </Button>
      </div>
      {item ? (
        <>
          <div className="mb-2 text-text" data-one-item>
            {describe(item)}
          </div>
          {detail?.(item)}
          <div className="flex justify-end gap-2">
            <Button title="Leave it as it is and go to the next" onClick={() => step(1)} data-one-skip>
              Skip
            </Button>
            <Button
              title="Cut only this one, then go to the next"
              onClick={() => {
                host.run(`${review}.apply`, { one: true });
                host.run("playhead.set", { time: Math.max(0, item.start - 1) });
              }}
              data-one-cut
            >
              Cut This One
            </Button>
          </div>
        </>
      ) : (
        <div className="text-label text-text-faint">Step through them to hear each one and cut them one by one.</div>
      )}
    </div>
  );
}

/**
 * A review in the properties panel while it is open: `children` (its settings), what it will cut (marked on the
 * timeline, red to cut and grey to keep; a click there flips one, or picks a silence to cut), one at a time, then Apply as one undo step or Cancel.
 */
export function ReviewPanel<T extends Item>(props: {
  review: Review;
  title: string;
  /** What it finds, plural: "silences". */
  noun: string;
  project: Project;
  host: Host;
  found: { waiting: string[]; saved: number; current?: number } | undefined;
  items: T[] | undefined;
  /** Shown when it finds none. */
  none: string;
  describe: (item: T) => string;
  /** Data attributes' names: `data-<one>-review`, `data-<review>-summary`. */
  one: string;
  children: ReactNode;
  /** What it found, in place of "N silences: X to cut, Y kept.". */
  tally?: (items: T[]) => string;
  /** The colours on the timeline and what a click there does, in place of to cut / kept. */
  legend?: ReactNode;
  /** More about the one being looked at, one at a time (a group's takes). */
  detail?: (item: T) => ReactNode;
  /** A line under the summary while it is still being worked out (OpenAI judging). */
  note?: ReactNode;
  /** Every one listed, a click going to it, for reviews with few (a talk's retakes, not its silences). */
  list?: boolean;
}) {
  const { review, title, noun, project, host, found, items = [], none, describe, one, children, tally, legend, detail, note, list } = props;
  const length = ticksToSeconds(projectDuration(project));
  const cut = items.filter((s) => s.cut).length;
  const kept = items.length - cut;
  const ready = !!found && !found.waiting.length && cut > 0;
  const progress = useTranscribing();
  const tip = useShortcutTip();
  const summary = !found
    ? `Finding ${noun}…`
    : found.waiting.length
      ? `Transcribing ${found.waiting.length === 1 ? "the speech" : `${found.waiting.length} media items`}${progress === undefined ? "" : ` (${Math.round(progress * 100)}%)`}: ${noun} are found in the transcript.`
      : !items.length
        ? none
        : `${tally ? tally(items) : `${items.length} ${noun}: ${cut} to cut, ${kept} kept.`} ${clock(length)} → ${clock(length - found.saved)}, ${clock(found.saved)} shorter.`;
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" {...{ [`data-${one}-review`]: true }}>
      <div className="mb-4 text-title font-semibold text-text-strong">{title}</div>
      {children}
      <div className="mb-2 rounded-md bg-groove px-3 py-2 text-text" {...{ [`data-${review}-summary`]: true }}>
        {summary}
        {!!found?.waiting.length && <Progress value={progress ?? 0} className="mt-2" />}
      </div>
      {note}
      <div className="mb-4 flex flex-col gap-1 text-label text-text-muted">
        {legend ?? (
          <>
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-4 rounded-sm bg-silence-cut" /> To cut
              <span className="ml-3 h-2.5 w-4 rounded-sm bg-silence-keep" /> Kept
            </span>
            <span data-review-hint>
              Click one on the timeline to keep or cut it.
            </span>
          </>
        )}
      </div>
      {list && !found?.waiting.length && items.length > 0 && (
        <div className="mb-3 flex flex-col gap-0.5" data-review-list>
          {items.map((item, i) => (
            <button
              key={`${item.start}`}
              className={`truncate rounded-md px-2 py-1 text-left text-label ${i === found?.current ? "bg-accent-wash text-text-strong" : "text-text-muted hover:bg-groove"}`}
              onClick={() => goTo(host, review, item)}
              data-review-item={i}
              data-current={i === found?.current || undefined}
            >
              {describe(item)}
            </button>
          ))}
        </div>
      )}
      <OneByOne review={review} items={found?.waiting.length ? [] : items} current={found?.current} host={host} describe={describe} {...(detail ? { detail } : {})} />
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => host.run(`${review}.close`)} {...{ [`data-${review}-cancel`]: true }}>
          Cancel{tip("reviews.cancel")}
        </Button>
        <Button look="primary" disabled={!ready} onClick={() => host.run(`${review}.apply`)} {...{ [`data-${review}-apply`]: true }}>
          Apply All{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}
